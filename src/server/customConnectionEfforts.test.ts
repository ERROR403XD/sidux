import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { forwardCustomConnection } from './customConnectionProxy'
import { normalizeModelCapability, type ModelCapability } from '../modelCapabilities'
import type { CustomEndpoint } from '../customConnections'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address === 'object') resolve(address.port)
      else reject(new Error('test server did not bind to a TCP port'))
    })
  })
}

function capability(model: string, efforts: string[], serviceTiers: string[] = []): ModelCapability {
  return { id: model, model, displayName: model, providerId: 'custom', isDefault: true, efforts: efforts.map(value => ({ value, description: '' })), defaultEffort: '', serviceTiers: serviceTiers.map(value => ({ value, label: value, description: '' })), defaultServiceTier: '', inputModalities: null }
}

function connection(model: string, efforts: string[], serviceTiers: string[] = []) {
  return {
    storageId: 'a'.repeat(64), alias: 'Fixture', provider: 'custom', baseUrl: '', model,
    wireApi: 'chat' as 'chat' | 'responses', protocolBridge: false, reasoningEfforts: efforts, allowFast: false,
    supportedEndpoints: ['/v1/models', '/v1/chat/completions', '/v1/responses'] as CustomEndpoint[], testedAt: '', models: [capability(model, efforts, serviceTiers), capability(`${model}-declared`, ['medium'], ['priority'])], revision: 1, runtimeToken: 'token', apiKey: 'fixture-key', hasApiKey: true,
  }
}

// The upstream records the JSON body it receives on /chat/completions.
async function startUpstream(rejectFast = false): Promise<{ port: number; bodies: Record<string, unknown>[] }> {
  const bodies: Record<string, unknown>[] = []
  const upstream = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      const body = JSON.parse(raw || '{}')
      bodies.push(body)
      if (rejectFast && body.service_tier) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Unsupported parameter: service_tier' } }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(req.url === '/responses' ? { id: 'resp-1', status: 'completed', output: [] } : { id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: 'ok' } }] }))
    })
  })
  const port = await listen(upstream)
  cleanups.push(() => new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve())))
  return { port, bodies }
}

// A local wrapper routes a real HTTP request through forwardCustomConnection,
// mirroring how the API outlet hands parsed chat-completions payloads over.
async function startWrapper(port: number, target: ReturnType<typeof connection>): Promise<number> {
  target.baseUrl = `http://127.0.0.1:${port}`
  const wrapper = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      void forwardCustomConnection(req, res, target, req.url || '/v1/chat/completions', JSON.parse(raw || '{}'), () => {})
    })
  })
  const wrapperPort = await listen(wrapper)
  cleanups.push(() => new Promise<void>((resolve, reject) => wrapper.close(error => error ? reject(error) : resolve())))
  return wrapperPort
}

async function postChat(port: number, payload: Record<string, unknown>, path = '/v1/chat/completions'): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'Content-Type': 'application/json' } }, response => {
      response.resume()
      response.on('end', () => resolve(response.statusCode || 0))
    })
    outgoing.on('error', reject)
    outgoing.end(JSON.stringify(payload))
  })
}

describe('custom connection reasoning effort forwarding', () => {
  it.each(['chat', 'responses'] as const)('protects strict %s upstreams by default and forwards priority only after opt-in', async wireApi => {
    const strict = await startUpstream(true)
    const target = connection('vendor/model', [])
    target.wireApi = wireApi
    const endpoint = wireApi === 'chat' ? '/v1/chat/completions' : '/v1/responses'
    const payload = { model: target.model, input: 'hi', messages: [{ role: 'user', content: 'hi' }], stream: false, service_tier: 'priority' }
    expect(await postChat(strict.port, payload, endpoint)).toBe(400)
    const strictWrapper = await startWrapper(strict.port, target)
    expect(await postChat(strictWrapper, payload, endpoint)).toBe(200)
    expect(strict.bodies.at(-1)).not.toHaveProperty('service_tier')
    const supported = await startUpstream()
    target.allowFast = true
    const wrapper = await startWrapper(supported.port, target)
    expect(await postChat(wrapper, payload, endpoint)).toBe(200)
    expect(supported.bodies.at(-1)).toMatchObject({ model: target.model, service_tier: 'priority' })
    target.allowFast = false
    expect(await postChat(wrapper, payload, endpoint)).toBe(200)
    expect(supported.bodies.at(-1)).not.toHaveProperty('service_tier')
  })
  it('forwards Magpie max and Fast through the real HTTP sanitizer and proxy', async () => {
    const { port, bodies } = await startUpstream()
    const target = connection('sidux/gpt-6.1-sol', [])
    target.models = [normalizeModelCapability({ id: target.model, supported_reasoning_levels: [{ effort: 'max' }, { effort: 'ultra' }], service_tiers: [{ id: 'priority', name: 'Fast' }] }, 'custom')!]
    const wrapperPort = await startWrapper(port, target)
    expect(await postChat(wrapperPort, { model: target.model, messages: [{ role: 'user', content: 'fixture' }], reasoning_effort: 'max', service_tier: 'priority' })).toBe(200)
    expect(bodies.at(-1)).toMatchObject({ model: target.model, reasoning_effort: 'max', service_tier: 'priority' })
  })
  it('keeps reasoning_effort upstream once the levels are declared and strips it otherwise', async () => {
    const { port, bodies } = await startUpstream()

    const declared = connection('deepseek-reasoner', ['low', 'medium', 'high'])
    const declaredPort = await startWrapper(port, declared)
    expect(await postChat(declaredPort, { model: 'deepseek-reasoner', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'high' })).toBe(200)
    expect(bodies.at(-1)).toMatchObject({ model: 'deepseek-reasoner', reasoning_effort: 'high' })

    const undeclared = connection('deepseek-chat', [])
    const undeclaredPort = await startWrapper(port, undeclared)
    expect(await postChat(undeclaredPort, { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'high' })).toBe(200)
    expect(bodies.at(-1)).toEqual({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] })
  })

  it('uses one sanitizer for explicit and connection-default models', async () => {
    const { port, bodies } = await startUpstream()
    const target = connection('deepseek-chat', [], [])
    const wrapperPort = await startWrapper(port, target)

    expect(await postChat(wrapperPort, { model: 'deepseek-chat-declared', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'medium', service_tier: 'priority', metadata: 'keep' })).toBe(200)
    expect(bodies.at(-1)).toEqual({ model: 'deepseek-chat-declared', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'medium', service_tier: 'priority', metadata: 'keep' })

    expect(await postChat(wrapperPort, { messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'medium', service_tier: 'priority', metadata: 'keep' })).toBe(200)
    expect(bodies.at(-1)).toEqual({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], metadata: 'keep' })
  })
})
