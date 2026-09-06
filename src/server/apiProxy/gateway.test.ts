import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiProxyGateway } from './gateway.js'
import { ProxyStore } from './store.js'
import { ProxyActivity } from './activity.js'
import type { AccountAuthCoordinator } from '../accountAuthCoordinator.js'
import type { ComponentGeneration } from './component.js'

const cleanups: (() => Promise<void>)[] = []
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })
async function home() {
  const directory = await mkdtemp(join(tmpdir(), 'codexapp-api-test-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}
async function listen(server: Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return `http://127.0.0.1:${port}`
}
async function fixture() {
  const directory = await home()
  const requests: { path: string; headers: Record<string, unknown>; body: any }[] = []
  let upstreamClosed = false
  const backend = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const input = raw ? JSON.parse(raw) : {}
    requests.push({ path: req.url!, headers: req.headers, body: input })
    if (input.model === 'slow') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"type":"response.created","response":{"id":"slow-response"}}\n\n')
      res.once('close', () => { upstreamClosed = true })
      return
    }
    if (req.url?.startsWith('/v1/models')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture', supported_reasoning_levels: [{ effort: 'max' }, { effort: 'ultra' }] }] })); return }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ id: 'fixture-response', object: 'response', status: 'completed', output: input.input?.some((item: any) => item.type === 'compaction_trigger')
      ? [{ type: 'compaction', encrypted_content: 'fixture-opaque' }] : [], usage: { total_tokens: 10 } }))
  })
  const url = await listen(backend)
  const backendWs = new WebSocketServer({ server: backend })
  backendWs.on('connection', ws => ws.on('message', raw => {
    requests.push({ path: 'ws', headers: {}, body: JSON.parse(raw.toString()) })
    ws.send(JSON.stringify({ type: 'response.completed', response: { id: `ws-response-${requests.length}`, status: 'completed', output: [] } }))
  }))
  cleanups.push(async () => { for (const ws of backendWs.clients) ws.terminate(); backendWs.close() })
  let lifecycle: any
  const coordinator = { store: { codexHome: directory }, isAccountOperationInProgress: () => false,
    setApiLifecycle: (value: any) => { lifecycle = value }, listAccounts: async () => ({ activeStorageId: 'account', accounts: [{ storageId: 'account' }] }) } as unknown as AccountAuthCoordinator
  const gateway = new ApiProxyGateway(coordinator)
  await gateway.store.ready
  await gateway.store.saveSettings({ ...gateway.store.settings, enabled: true, drainTimeoutSeconds: 1 })
  const generation = { id: 'fixture-generation', url, key: 'internal-fixture-key', storageId: 'account', revision: 1 } as ComponentGeneration
  vi.spyOn(gateway.component, 'prepare').mockResolvedValue(generation)
  vi.spyOn(gateway.component, 'hold').mockReturnValue(() => undefined)
  const stop = vi.spyOn(gateway.component, 'stop').mockResolvedValue()
  vi.spyOn(gateway.component, 'available').mockResolvedValue(true)
  const front = createServer((req, res) => {
    if (req.url?.startsWith('/codex-api/api-proxy')) void gateway.handleManagement(req, res)
    else void gateway.handleApi(req, res)
  })
  gateway.attach(front)
  const base = await listen(front)
  cleanups.push(() => gateway.close())
  const first = await gateway.store.createKey('first', null)
  const second = await gateway.store.createKey('second', null)
  const headers = (secret = first.secret) => ({ Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' })
  async function post(path: string, input: unknown, secret = first.secret) {
    return await fetch(base + path, { method: 'POST', headers: headers(secret), body: JSON.stringify(input) })
  }
  return { gateway, base, first, second, headers, post, requests, stop, lifecycle: () => lifecycle, upstreamClosed: () => upstreamClosed }
}

describe('API outlet state and admission', () => {
  it('stores only key hashes and preserves revoked state across restart', async () => {
    const store = new ProxyStore(await home()); await store.ready
    const { key, secret } = await store.createKey('CLI', null)
    expect(store.authenticate(secret)?.id).toBe(key.id)
    expect(await readFile(join(store.directory, 'state.json'), 'utf8')).not.toContain(secret)
    await store.updateKey(key.id, { revoke: true })
    await store.updateKey(key.id, { enabled: true })
    const restarted = new ProxyStore(store.directory); await restarted.ready
    expect(restarted.authenticate(secret)).toBeNull()
    expect(restarted.listKeys()[0].revokedAt).toBeTruthy()
    await store.close(); await restarted.close()
  })
  it('expires existing keys and serializes concurrent key writes', async () => {
    const store = new ProxyStore(await home()); await store.ready
    const keys = await Promise.all([store.createKey('A', null), store.createKey('B', null)])
    expect(store.listKeys()).toHaveLength(2)
    await store.updateKey(keys[0].key.id, { expiresAt: new Date(Date.now() - 1).toISOString() })
    expect(store.authenticate(keys[0].secret)).toBeNull()
    expect(store.authenticate(keys[1].secret)).not.toBeNull()
    await store.close()
  })
  it('reserves before asynchronous work and restores admission after drain timeout', async () => {
    const activity = new ProxyActivity()
    const limits = { globalConcurrency: 1, keyConcurrency: 1 }
    const entry = activity.admit('first', 'http', limits)
    expect(() => activity.admit('second', 'http', limits)).toThrow('并发')
    const draining = activity.drain(10)
    expect(() => activity.admit('second', 'http', limits)).toThrow('等待')
    await expect(draining).rejects.toMatchObject({ code: 'drain_timeout' })
    expect(activity.entries.has(entry.id)).toBe(true)
    expect(activity.draining).toBe(false)
    activity.finish(entry.id)
    expect(activity.admit('second', 'http', limits)).toBeTruthy()
  })
})

describe('API outlet transport boundaries', () => {
  it('requires a key, isolates management origin and terminates unknown /v1 paths with JSON', async () => {
    const f = await fixture()
    expect((await fetch(f.base + '/v1/models')).status).toBe(401)
    expect((await fetch(f.base + '/v1/unknown', { headers: f.headers() })).status).toBe(404)
    const cross = await fetch(f.base + '/codex-api/api-proxy/keys', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other.example' }, body: '{"name":"bad"}' })
    expect(cross.status).toBe(403)
    expect(f.requests).toHaveLength(0)
  })
  it('preserves query catalogs and replaces external keys and session namespaces', async () => {
    const f = await fixture()
    for (const key of [f.first, f.second]) {
      const response = await fetch(f.base + '/v1/models?client_version=0.153.4', { headers: { ...f.headers(key.secret), Cookie: 'webui-secret', 'Session-Id': 'same-session' } })
      expect(response.status).toBe(200)
      expect((await response.json()).data[0].supported_reasoning_levels).toEqual([{ effort: 'max' }])
    }
    expect(f.requests[0].path).toContain('client_version=0.153.4')
    expect(f.requests[0].headers.authorization).toBe('Bearer internal-fixture-key')
    expect(f.requests[0].headers.cookie).toBeUndefined()
    expect(f.requests[0].headers['session-id']).not.toBe(f.requests[1].headers['session-id'])
  })
  it('rejects unsupported HTTP previous_response_id before forwarding', async () => {
    const f = await fixture()
    const response = await f.post('/v1/responses', { model: 'fixture', previous_response_id: 'foreign', input: [] })
    expect(response.status).toBe(400)
    expect(f.requests).toHaveLength(0)
  })
  it('adapts compact to native V2 and retains opaque output and caller user messages', async () => {
    const f = await fixture()
    const response = await f.post('/v1/responses/compact', { model: 'fixture', input: [{ role: 'user', content: 'retain me' }] })
    const result = await response.json()
    expect(response.status).toBe(200)
    expect(f.requests[0].path).toBe('/v1/responses')
    expect(f.requests[0].body.input.at(-1).type).toBe('compaction_trigger')
    expect(result.object).toBe('response.compaction')
    expect(result.output).toEqual([{ role: 'user', content: 'retain me' }, { type: 'compaction', encrypted_content: 'fixture-opaque' }])
  })
  it('keeps slow streams alive on normal switch timeout and cancels upstream on disconnect', async () => {
    const f = await fixture()
    const abort = new AbortController()
    const stream = await fetch(f.base + '/v1/responses', { method: 'POST', headers: f.headers(), body: '{"model":"slow","input":[],"stream":true}', signal: abort.signal })
    const reader = stream.body!.getReader(); await reader.read()
    const switched = await f.post('/codex-api/api-proxy/settings', { settings: { enabled: false } })
    expect(switched.status).toBe(409)
    expect(f.stop).not.toHaveBeenCalled()
    expect(f.gateway.activity.snapshot().activeRequests).toBe(1)
    abort.abort()
    for (let i = 0; i < 30 && !f.upstreamClosed(); i++) await sleep(10)
    expect(f.upstreamClosed()).toBe(true)
    expect(f.gateway.activity.snapshot().connections).toBe(0)
  })
  it('keeps fixed API accounts independent and drains before removing that account', async () => {
    const f = await fixture()
    await f.gateway.store.saveSettings({ ...f.gateway.store.settings, accountStorageId: 'fixed' })
    const entry = f.gateway.activity.admit(f.first.key.id, 'http', f.gateway.store.settings)
    const release = await f.lifecycle().beforeMutation('switch', 'other')
    release()
    expect(f.stop).not.toHaveBeenCalled()
    expect(f.gateway.activity.entries.has(entry.id)).toBe(true)
    f.gateway.activity.finish(entry.id)
    const removeRelease = await f.lifecycle().beforeMutation('remove', 'fixed')
    expect(f.stop).toHaveBeenCalledOnce()
    expect(f.gateway.activity.draining).toBe(true)
    removeRelease()
    expect(f.gateway.activity.draining).toBe(false)
  })
  it('rejects cross-key WS continuation before forwarding while allowing the owning key', async () => {
    const f = await fixture()
    const first = new WebSocket(f.base.replace('http:', 'ws:') + '/v1/responses', { headers: f.headers() })
    const second = new WebSocket(f.base.replace('http:', 'ws:') + '/v1/responses', { headers: f.headers(f.second.secret) })
    await Promise.all([once(first, 'open'), once(second, 'open')])
    try {
      const completed = once(first, 'message')
      first.send(JSON.stringify({ type: 'response.create', model: 'fixture', input: [] }))
      const previous = JSON.parse((await completed)[0].toString()).response.id
      const denied = once(second, 'message')
      second.send(JSON.stringify({ type: 'response.create', model: 'fixture', previous_response_id: previous, input: [] }))
      expect(JSON.parse((await denied)[0].toString()).error.code).toBe('previous_response_not_found')
      expect(f.requests.filter(row => row.path === 'ws')).toHaveLength(1)
      const continued = once(first, 'message')
      first.send(JSON.stringify({ type: 'response.create', model: 'fixture', previous_response_id: previous, input: [] }))
      expect(JSON.parse((await continued)[0].toString()).type).toBe('response.completed')
      expect(f.requests.filter(row => row.path === 'ws')).toHaveLength(2)
    } finally {
      first.terminate()
      second.terminate()
    }
  })
  it('rejects WS without key and checks revocation again inside an existing connection', async () => {
    const f = await fixture()
    const bad = new WebSocket(f.base.replace('http:', 'ws:') + '/v1/responses')
    const unauthorized = await new Promise<number>(resolve => { bad.on('unexpected-response', (_req, response) => { resolve(response.statusCode!); response.resume(); bad.terminate() }); bad.on('error', () => undefined) })
    expect(unauthorized).toBe(401)
    const ws = new WebSocket(f.base.replace('http:', 'ws:') + '/v1/responses', { headers: f.headers() })
    await once(ws, 'open')
    const first = once(ws, 'message'); ws.send(JSON.stringify({ type: 'response.create', model: 'fixture', input: [] }))
    const [firstFrame, isBinary] = await first
    expect(isBinary).toBe(false)
    expect(JSON.parse(firstFrame.toString()).type).toBe('response.completed')
    await f.gateway.store.updateKey(f.first.key.id, { revoke: true })
    const next = once(ws, 'message'); ws.send(JSON.stringify({ type: 'response.create', model: 'fixture', input: [] }))
    expect(JSON.parse((await next)[0].toString()).error.code).toBe('invalid_api_key')
    ws.terminate()
    expect(f.requests.filter(row => row.path === 'ws')).toHaveLength(1)
  })
})
