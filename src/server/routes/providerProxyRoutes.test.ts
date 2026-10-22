import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CustomConnectionStore } from '../customConnectionStore.js'
import { FREE_MODE_STATE_FILE } from '../freeMode.js'
import { readAnyJsonBody, setJson } from '../httpUtils.js'
import { createProviderProxyService } from '../providerProxyService.js'
import { createProviderProxyRoutes } from './providerProxyRoutes.js'

const { legacyCalls } = vi.hoisted(() => ({ legacyCalls: [] as Array<{ provider: string; token: string; wire: string }> }))
vi.mock('../zenProxy.js', () => ({
  handleZenProxyRequest: (_req: IncomingMessage, res: ServerResponse, token: string, wire: string) => {
    legacyCalls.push({ provider: 'zen', token, wire })
    res.end('{}')
  },
}))
vi.mock('../openRouterProxy.js', () => ({
  handleOpenRouterProxyRequest: (_req: IncomingMessage, res: ServerResponse, token: string, wire: string) => {
    legacyCalls.push({ provider: 'openrouter', token, wire })
    res.end('{}')
  },
}))

const id = 'a'.repeat(64)
const runtimePath = `/codex-api/custom-connections/runtime/${id}/7/v1/responses`
let home: string
let servers: Server[]
let base: string
let upstreamBase: string
let store: CustomConnectionStore
let remoteAddress: string | undefined
let upstreamStatus: number
let upstreamMode: 'responses' | 'chat' | 'pending'
let calls: Array<{ path: string; authorization?: string; body: Record<string, unknown> }>
let upstreamClosed: boolean

async function listen(server: Server) {
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

async function saveConnection(wireApi: 'responses' | 'chat' = 'responses', protocolBridge = false) {
  await writeFile(join(home, 'custom-connections.json'), JSON.stringify({
    version: 1, activeId: id, connections: [{
      storageId: id, alias: 'fixture', provider: 'custom', baseUrl: `${upstreamBase}/v1`,
      apiKey: 'synthetic-upstream', runtimeToken: 'synthetic-runtime', revision: 7,
      model: 'fixture-model', models: [{ id: 'fixture-model', efforts: [], serviceTiers: [] }], wireApi, protocolBridge,
    }],
  }))
  store = new CustomConnectionStore(home)
  await store.ready
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'sidux-provider-proxy-'))
  vi.stubEnv('CODEX_HOME', home)
  servers = []
  remoteAddress = '127.0.0.1'
  upstreamStatus = 200
  upstreamMode = 'responses'
  upstreamClosed = false
  calls = []
  legacyCalls.length = 0
  upstreamBase = await listen(createServer((req, res) => {
    void readAnyJsonBody(req).then(body => {
      calls.push({ path: req.url ?? '', authorization: req.headers.authorization, body: body as Record<string, unknown> })
      if (upstreamMode === 'pending') {
        res.on('close', () => { upstreamClosed = true })
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: {"id":"chat-fixture","choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n')
        return
      }
      setJson(res, upstreamStatus, upstreamStatus !== 200 ? { error: 'fixture failure' } : upstreamMode === 'chat' ? {
        id: 'chat-fixture', model: 'fixture-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } }],
      } : { id: 'response-fixture', object: 'response', status: 'completed', output: [] })
    }).catch(error => setJson(res, 500, { error: error.message }))
  }))
  await saveConnection()
  const route = createProviderProxyRoutes(createProviderProxyService(() => store))
  base = await listen(createServer((req, res) => {
    // Exercise the original address gate with a controlled socket-address seam.
    Object.defineProperty(req.socket, 'remoteAddress', { value: remoteAddress, configurable: true })
    void store.ready.then(() => route(req, res, new URL(req.url ?? '/', base))).then(handled => {
      if (!handled) setJson(res, 404, { error: 'Unhandled' })
    }).catch(error => setJson(res, 500, { error: error.message }))
  }))
})

afterEach(async () => {
  for (const server of servers.reverse()) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

async function post(path = runtimePath, token = 'synthetic-runtime', payload: unknown = { input: 'hello', reasoning: { effort: 'high' }, service_tier: 'fast' }) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(3000),
  })
  return { status: response.status, body: await response.json() }
}

describe('provider proxy route/service/store/transport contracts', () => {
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('forwards one native request from %s with the saved key and sanitizer', async address => {
    remoteAddress = address
    expect(await post()).toMatchObject({ status: 200, body: { id: 'response-fixture' } })
    expect(calls).toEqual([{ path: '/v1/responses', authorization: 'Bearer synthetic-upstream', body: { input: 'hello', model: 'fixture-model' } }])
  })

  it.each(['remote', 'missing', 'revision', 'token'])('rejects %s before reading/forwarding the request body', async mismatch => {
    if (mismatch === 'remote') remoteAddress = '192.168.50.46'
    const path = mismatch === 'missing' ? runtimePath.replace(id, 'b'.repeat(64)) : mismatch === 'revision' ? runtimePath.replace('/7/', '/6/') : runtimePath
    const response = await fetch(`${base}${path}`, { method: 'POST', body: '{invalid', headers: { Authorization: `Bearer ${mismatch === 'token' ? 'wrong' : 'synthetic-runtime'}` } })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: '连接配置已变化，请重新发送' })
    expect(calls).toHaveLength(0)
  })

  it('rejects a chat connection with conversion disabled without upstream work', async () => {
    await saveConnection('chat')
    expect(await post()).toEqual({ status: 409, body: { error: '该连接仅支持 Chat Completions，可在账号设置中开启协议转换' } })
    expect(calls).toHaveLength(0)
  })

  it('converts once, omits namespace tools, and preserves upstream failures', async () => {
    await saveConnection('chat', true)
    upstreamMode = 'chat'
    const result = await post(runtimePath, 'synthetic-runtime', { input: 'hello', tools: [{ type: 'namespace', name: 'functions', tools: [] }] })
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ object: 'response', status: 'completed', output: [{ content: [{ text: 'hello' }] }] })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ path: '/v1/chat/completions', authorization: 'Bearer synthetic-upstream', body: { model: 'fixture-model', messages: [{ role: 'user', content: 'hello' }] } })
    expect(calls[0]!.body.tools ?? []).toEqual([])
    upstreamStatus = 429
    expect(await post()).toEqual({ status: 429, body: { error: 'fixture failure' } })
    expect(calls).toHaveLength(2)
  })

  it('cancels a bridge upstream after disconnect and admits a subsequent request', async () => {
    await saveConnection('chat', true)
    upstreamMode = 'pending'
    const controller = new AbortController()
    const response = await fetch(`${base}${runtimePath}`, { method: 'POST', headers: { Authorization: 'Bearer synthetic-runtime' }, body: '{"input":"hello","stream":true}', signal: controller.signal })
    await response.body!.getReader().read()
    controller.abort()
    await vi.waitFor(() => expect(upstreamClosed).toBe(true))
    upstreamMode = 'chat'
    expect((await post()).status).toBe(200)
    expect(calls).toHaveLength(2)
  })

  it('keeps the Zen address gate and the original legacy wire/default rules', async () => {
    remoteAddress = '192.168.50.46'
    expect(await post('/codex-api/zen-proxy/v1/responses')).toEqual({ status: 403, body: { error: 'Zen proxy is only available from localhost' } })
    expect(legacyCalls).toHaveLength(0)
    remoteAddress = '::1'
    await post('/codex-api/zen-proxy/v1/responses')
    expect(legacyCalls).toEqual([{ provider: 'zen', token: '', wire: 'responses' }])
    await writeFile(join(home, FREE_MODE_STATE_FILE), JSON.stringify({ enabled: true, provider: 'custom', model: 'fixture-model', apiKey: 'legacy-fixture', wireApi: 'chat', customBaseUrl: `${upstreamBase}/v1` }))
    remoteAddress = '192.168.50.46'
    await post('/codex-api/openrouter-proxy/v1/responses')
    expect(legacyCalls.at(-1)).toEqual({ provider: 'openrouter', token: 'legacy-fixture', wire: 'chat' })
    upstreamMode = 'chat'
    expect((await post('/codex-api/custom-proxy/v1/responses')).status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ path: '/v1/chat/completions', authorization: 'Bearer legacy-fixture' })
  })

  it('falls back after malformed legacy state and passes unmatched routes to the next handler', async () => {
    await writeFile(join(home, FREE_MODE_STATE_FILE), '{broken')
    await post('/codex-api/openrouter-proxy/v1/responses')
    expect(legacyCalls).toEqual([{ provider: 'openrouter', token: '', wire: 'responses' }])
    expect((await fetch(`${base}${runtimePath}`)).status).toBe(404)
    expect((await post(runtimePath.replace(id, id.toUpperCase()))).status).toBe(404)
    expect((await post('/codex-api/provider-models')).status).toBe(404)
    expect(calls).toHaveLength(0)
  })
})
