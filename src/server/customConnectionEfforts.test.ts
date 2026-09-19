import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { forwardCustomConnection } from './customConnectionProxy'
import type { ModelCapability } from '../modelCapabilities'

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

function capability(model: string, efforts: string[]): ModelCapability {
  return { id: model, model, displayName: model, providerId: 'custom', isDefault: true, efforts: efforts.map(value => ({ value, description: '' })), defaultEffort: '', serviceTiers: [], defaultServiceTier: '', inputModalities: null }
}

function connection(model: string, efforts: string[]) {
  return {
    storageId: 'a'.repeat(64), alias: 'Fixture', provider: 'custom', baseUrl: '', model,
    wireApi: 'chat' as const, protocolBridge: false, reasoningEfforts: efforts,
    supportedEndpoints: ['/v1/models', '/v1/chat/completions'] as const, testedAt: '', models: [capability(model, efforts)], revision: 1, runtimeToken: 'token', apiKey: 'fixture-key', hasApiKey: true,
  }
}

// The upstream records the JSON body it receives on /chat/completions.
async function startUpstream(): Promise<{ port: number; bodies: Record<string, unknown>[] }> {
  const bodies: Record<string, unknown>[] = []
  const upstream = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      bodies.push(JSON.parse(raw || '{}'))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: 'ok' } }] }))
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
      void forwardCustomConnection(req, res, target as never, '/v1/chat/completions', JSON.parse(raw || '{}'), () => {})
    })
  })
  const wrapperPort = await listen(wrapper)
  cleanups.push(() => new Promise<void>((resolve, reject) => wrapper.close(error => error ? reject(error) : resolve())))
  return wrapperPort
}

async function postChat(port: number, payload: Record<string, unknown>): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions', headers: { 'Content-Type': 'application/json' } }, response => {
      response.resume()
      response.on('end', () => resolve(response.statusCode || 0))
    })
    outgoing.on('error', reject)
    outgoing.end(JSON.stringify(payload))
  })
}

describe('custom connection reasoning effort forwarding', () => {
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
})
