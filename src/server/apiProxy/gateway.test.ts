import { AccountExecutionRegistry } from '../accountExecution.js'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiProxyGateway } from './gateway.js'
import { ProxyStore } from './store.js'
import { ProxyActivity } from './activity.js'
import { AccountAuthCoordinator } from '../accountAuthCoordinator.js'
import { ProxyComponent, type ComponentGeneration } from './component.js'

const cleanups: (() => Promise<void>)[] = []
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); vi.restoreAllMocks() })
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
  let operation: any = null
  let lifecycle: any
  let guard: ((isChatGPT?: () => Promise<boolean>, policy?: { storageId?: string; protected?: boolean }) => Promise<void>) | null = null
  let accountState: any = { activeStorageId: 'account', accounts: [{ storageId: 'account' }, { storageId: 'fixed' }] }
  const executions = new AccountExecutionRegistry()
  const coordinator = { executions, store: { codexHome: directory, readState: async () => accountState }, setSubmissionGuard: (value: any) => { guard = value }, setQuotaObserver: vi.fn(), blocksApiAccount: (id: string | null) => AccountAuthCoordinator.prototype.blocksApiAccount.call({ operation, executions, removals: new Map() } as any, id), isAccountOperationInProgress: () => !!operation,
    setApiLifecycle: (value: any) => { lifecycle = value }, listAccounts: async () => ({ activeStorageId: 'account', accounts: [{ storageId: 'account' }] }) } as unknown as AccountAuthCoordinator
  const gateway = new ApiProxyGateway(coordinator)
  await gateway.store.ready
  await gateway.store.saveSettings({ ...gateway.store.settings, enabled: true, drainTimeoutSeconds: 1 })
  const generation = { id: 'fixture-generation', url, key: 'internal-fixture-key', storageId: 'account', revision: 1 } as ComponentGeneration
  vi.spyOn(ProxyComponent.prototype, 'prepare').mockImplementation(async id => ({ ...generation, storageId: id || 'account', references: 0 }))
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
  return { setOperation: (value: any) => { operation = value }, gateway, base, first, second, headers, post, requests, stop, setAccountState: (value: any) => { accountState = value }, guard: (policy?: { storageId?: string; protected?: boolean }) => guard!(undefined, policy), lifecycle: () => lifecycle, upstreamClosed: () => upstreamClosed }
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
  it('accounts for HTTP, compact, cancellation and WS rounds without connection double-counting', async () => {
    const f = await fixture()
    await (await f.post('/v1/responses', { model: 'fixture' })).text()
    await (await f.post('/v1/responses/compact', { model: 'fixture', input: [] })).text()
    const aborted = await f.post('/v1/responses', { model: 'slow' })
    await aborted.body!.cancel()
    const ws = new WebSocket(f.base.replace('http:', 'ws:') + '/v1/responses', { headers: f.headers(f.second.secret) })
    await once(ws, 'open')
    for (let i = 0; i < 2; i++) {
      const event = once(ws, 'message')
      ws.send(JSON.stringify({ type: 'response.create', model: 'fixture', input: [] }))
      await event
    }
    ws.close()
    await once(ws, 'close')
    await sleep(30)
    const summary = f.gateway.usage.summary()
    expect(summary.keys[f.first.key.id].cumulative).toMatchObject({ requests: 3, completed: 2, interrupted: 1, total: 20, unknown: 1 })
    expect(summary.keys[f.second.key.id].cumulative).toMatchObject({ requests: 2, completed: 2, unknown: 2 })
    expect(f.gateway.activity.entries.size).toBe(0)
  })
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
    expect(f.gateway.activity.draining).toBe(false)
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


it('allows protected global keys and persists protection independently of account selection', async () => {
  const store = new ProxyStore(await home()); await store.ready
  const global = await store.createKey('global', null, { protected: true })
  expect(global.key).toMatchObject({ protected: true, accountStorageId: null })
  const key = await store.createKey('protected', null, { protected: true, accountStorageId: 'a'.repeat(64) })
  await store.updateKey(key.key.id, { accountStorageId: null })
  expect(store.findKey(key.key.id)?.protected).toBe(true)
  await store.updateKey(key.key.id, { accountStorageId: null, protected: false })
  expect(store.findKey(key.key.id)?.protected).toBe(false)
  await store.close()
})

it('routes fixed keys to isolated account components and enforces account reserve on HTTP and the main guard', async () => {
  const f = await fixture()
  const a = 'a'.repeat(64), b = 'b'.repeat(64)
  f.setAccountState({ activeStorageId: a, accounts: [a, b].map(storageId => ({ storageId, protectionPercent: storageId === a ? 1 : 0, quotaUpdatedAtIso: new Date().toISOString(), quotaStatus: 'ready', quotaSnapshot: { primary: { windowMinutes: 300, usedPercent: 98 }, secondary: { windowMinutes: 10080, usedPercent: 99 } } })) })
  const defaultGeneration = await f.gateway.component.prepare(null)
  const prepared: string[] = []
  const spy = vi.spyOn(ProxyComponent.prototype, 'prepare').mockImplementation(async id => { prepared.push(id!); return { ...defaultGeneration, id: id!, storageId: id!, references: 0 } })
  try {
    const keyA = await f.gateway.store.createKey('A', null, { accountStorageId: a, protected: true })
    const keyB = await f.gateway.store.createKey('B', null, { accountStorageId: b })
    expect((await f.post('/v1/responses', { input: [] }, keyA.secret)).status).toBe(200)
    expect((await f.post('/v1/responses', { input: [] }, keyB.secret)).status).toBe(200)
    expect(prepared).toEqual([a, b])
    const rejected = await f.post('/v1/responses', { input: [] })
    expect(rejected.status).toBe(429)
    expect((await rejected.json()).error.code).toBe('account_quota_protected')
    await expect(f.guard()).rejects.toThrow('已保留')
    expect(f.requests).toHaveLength(2)
  } finally { spy.mockRestore() }
})

it('checks reserve again for each WebSocket frame, not only at handshake', async () => {
  const f = await fixture()
  const state: any = { activeStorageId: 'account', accounts: [{ storageId: 'account', protectionPercent: 1, quotaUpdatedAtIso: new Date().toISOString(), quotaStatus: 'ready', quotaSnapshot: { primary: { windowMinutes: 300, usedPercent: 90 }, secondary: { windowMinutes: 10080, usedPercent: 90 } } }] }
  f.setAccountState(state)
  const ws = new WebSocket(f.base.replace('http:', 'ws:') + '/v1/responses', { headers: f.headers() })
  await once(ws, 'open')
  state.accounts[0].quotaSnapshot.secondary.usedPercent = 99
  const received = once(ws, 'message')
  ws.send(JSON.stringify({ type: 'response.create', model: 'fixture', input: [] }))
  const [message] = await received
  expect(JSON.parse(String(message)).error.code).toBe('account_quota_protected')
  expect(f.requests).toHaveLength(0)
  ws.terminate()
})


it('serves responses and chat completions throughout background refresh and isolates fixed keys during a primary switch', async () => {
  const f = await fixture()
  f.setOperation({ kind: 'refresh', storageId: 'account' })
  for (const path of ['/v1/responses', '/v1/chat/completions']) {
    expect((await f.post(path, { model: 'fixture', input: [], messages: [] })).status).toBe(200)
  }
  await f.gateway.store.saveSettings({ ...f.gateway.store.settings, accountStorageId: 'fixed' })
  f.setOperation({ kind: 'switch', storageId: 'other' })
  expect((await f.post('/v1/responses', { input: [] })).status).toBe(200)
  await f.gateway.store.saveSettings({ ...f.gateway.store.settings, accountStorageId: null })
  expect((await f.post('/v1/responses', { input: [] })).status).toBe(503)
  f.setOperation(null)
})

it('rebinds a key away from a stalled account without aborting another key stream', async () => {
  const f = await fixture()
  const a = 'a'.repeat(64), b = 'b'.repeat(64)
  f.setAccountState({ activeStorageId: a, accounts: [{ storageId: a }, { storageId: b }] })
  const generation = await f.gateway.component.prepare(null)
  const prepare = vi.spyOn(ProxyComponent.prototype, 'prepare').mockImplementation(async id => ({ ...generation, id: id!, storageId: id!, references: 0 }))
  const controller = new AbortController()
  try {
    const moving = await f.gateway.store.createKey('moving', null, { accountStorageId: a })
    const other = await f.gateway.store.createKey('other', null, { accountStorageId: b })
    const stalled = await f.post('/v1/responses', { model: 'slow', stream: true }, moving.secret)
    const unaffected = await fetch(f.base + '/v1/responses', { method: 'POST', headers: f.headers(other.secret), body: JSON.stringify({ model: 'slow', stream: true }), signal: controller.signal })
    expect(stalled.status).toBe(200)
    expect(unaffected.status).toBe(200)
    expect((await f.post('/codex-api/api-proxy/keys/' + moving.key.id, { accountStorageId: b })).status).toBe(200)
    await vi.waitFor(() => expect([...f.gateway.activity.entries.values()].some(row => row.keyId === moving.key.id)).toBe(false))
    f.setOperation({ kind: 'refresh', storageId: a })
    expect((await f.post('/v1/chat/completions', { model: 'fixture', messages: [] }, moving.secret)).status).toBe(200)
    expect([...f.gateway.activity.entries.values()].some(row => row.keyId === other.key.id && row.busy)).toBe(true)
    f.setOperation(null)
  } finally {
    controller.abort()
    prepare.mockRestore()
  }
})

it('rebinds the default outlet during a stalled stream and primary refresh while preserving a fixed-key stream', async () => {
  const f = await fixture()
  const a = 'a'.repeat(64), b = 'b'.repeat(64)
  f.setAccountState({ activeStorageId: a, accounts: [{ storageId: a }, { storageId: b }] })
  ;(f.gateway as any).coordinator.listAccounts = async () => ({ accounts: [{ storageId: a }, { storageId: b }] })
  const fixed = await f.gateway.store.createKey('independent', null, { accountStorageId: b })
  const ctrl = new AbortController()
  try {
    expect((await f.post('/v1/responses', { model: 'slow', stream: true })).status).toBe(200)
    expect((await fetch(f.base + '/v1/responses', { method: 'POST', headers: f.headers(fixed.secret), body: JSON.stringify({ model: 'slow', stream: true }), signal: ctrl.signal })).status).toBe(200)
    f.setOperation({ kind: 'refresh', storageId: a })
    expect((await f.post('/codex-api/api-proxy/settings', { settings: { accountStorageId: b } })).status).toBe(200)
    await vi.waitFor(() => expect([...f.gateway.activity.entries.values()].filter(entry => entry.keyId === f.first.key.id)).toHaveLength(0))
    expect([...f.gateway.activity.entries.values()].some(entry => entry.keyId === fixed.key.id && entry.busy)).toBe(true)
    for (const path of ['/v1/responses', '/v1/chat/completions', '/v1/responses/compact']) {
      expect((await f.post(path, { model: 'fixture', input: [{ role: 'user', content: 'fixture' }], messages: [] })).status).toBe(200)
    }
    expect((await fetch(f.base + '/v1/models', { headers: f.headers() })).status).toBe(200)
    expect((await fetch(f.base + '/codex-api/api-proxy/models?keyId=' + fixed.key.id)).status).toBe(200)
  } finally { ctrl.abort(); f.setOperation(null) }
})

it('previews one account model catalog for key routing while the outlet stays disabled', async () => {
  const f = await fixture()
  try {
    await f.gateway.store.saveSettings({ ...f.gateway.store.settings, enabled: false })
    expect((await fetch(f.base + '/codex-api/api-proxy/models')).status).toBe(503)
    const preview = await fetch(f.base + '/codex-api/api-proxy/models?accountStorageId=account')
    expect(preview.status).toBe(200)
    expect((await preview.json()).data[0].id).toBe('fixture')
  } finally {
    await f.gateway.store.saveSettings({ ...f.gateway.store.settings, enabled: true })
  }
})

it('force-removes only connections belonging to the selected account without waiting for their streams', async () => {
  const f = await fixture()
  const a = 'a'.repeat(64), b = 'b'.repeat(64)
  f.setAccountState({ activeStorageId: a, accounts: [{ storageId: a }, { storageId: b }] })
  const keyB = await f.gateway.store.createKey('keep', null, { accountStorageId: b })
  const ctrl = new AbortController()
  try {
    await f.post('/v1/responses', { model: 'slow', stream: true })
    await fetch(f.base + '/v1/responses', { method: 'POST', headers: f.headers(keyB.secret), body: JSON.stringify({ model: 'slow', stream: true }), signal: ctrl.signal })
    const started = Date.now()
    await f.lifecycle().beforeMutation('remove', a)
    expect(Date.now() - started).toBeLessThan(500)
    await vi.waitFor(() => expect([...f.gateway.activity.entries.values()].every(entry => entry.storageId === b)).toBe(true))
    expect(f.gateway.activity.entries.size).toBe(1)
  } finally { ctrl.abort() }
})

it('keeps an authenticated WebSocket and its previous response context across credential rotation', async () => {
  const f = await fixture()
  const fixed = 'f'.repeat(64)
  f.setAccountState({ activeStorageId: 'account', accounts: [{ storageId: 'account' }, { storageId: fixed }] })
  const key = await f.gateway.store.createKey('fixed-refresh', null, { accountStorageId: fixed })
  const ws = new WebSocket(f.base.replace('http:', 'ws:') + '/v1/responses', { headers: f.headers(key.secret) })
  try {
    await once(ws, 'open')
    const first = once(ws, 'message')
    ws.send(JSON.stringify({ type: 'response.create', model: 'fixture', input: [] }))
    const previous = JSON.parse((await first)[0].toString()).response.id
    const old = await f.gateway.component.prepare(fixed)
    const prepare = vi.spyOn(ProxyComponent.prototype, 'prepare').mockImplementation(async id => ({ ...old, id: 'rotated-generation', revision: 2, storageId: id || fixed, references: 0 }))
    // A new request uses the new credential generation while the socket stays pinned.
    expect((await f.post('/v1/responses', { model: 'fixture', input: [] }, key.secret)).status).toBe(200)
    prepare.mockClear()
    const next = once(ws, 'message')
    ws.send(JSON.stringify({ type: 'response.create', model: 'fixture', previous_response_id: previous, input: [] }))
    expect(JSON.parse((await next)[0].toString()).type).toBe('response.completed')
    expect(ws.readyState).toBe(WebSocket.OPEN)
    expect(prepare).not.toHaveBeenCalled()
    expect(f.requests.filter(row => row.path === 'ws').at(-1)?.body.previous_response_id).toBe(previous)
  } finally { ws.terminate() }
})

it.each(['free', 'pro'])('uses the same actual-window reserve for %s HTTP, WS and automation admission', async planType => {
  const f = await fixture()
  const state = { activeStorageId: 'a'.repeat(64), accounts: [
    { storageId: 'a'.repeat(64), protectionPercent: 0 },
    { storageId: 'b'.repeat(64), alias: 'local label', planType, protectionPercent: 10, quotaUpdatedAtIso: new Date().toISOString(), quotaStatus: 'ready', quotaSnapshot: { primary: { windowMinutes: 43200, usedPercent: 85 }, secondary: null } },
  ] }
  f.setAccountState(state)
  const fixed = await f.gateway.store.createKey('no-five-hour', null, { accountStorageId: 'b'.repeat(64) })
  // 15% remaining passes the 10% main reserve; no implicit 20% 5-hour reserve.
  for (const path of ['/v1/responses', '/v1/chat/completions']) {
    expect((await f.post(path, { model: 'fixture', input: [], messages: [{ role: 'user', content: 'fixture' }] }, fixed.secret)).status).toBe(200)
  }
  await expect(f.guard({ storageId: 'b'.repeat(64) })).resolves.toBeUndefined()
  const ws = new WebSocket(f.base.replace('http:', 'ws:') + '/v1/responses', { headers: f.headers(fixed.secret) })
  await once(ws, 'open')
  let received = once(ws, 'message')
  ws.send(JSON.stringify({ type: 'response.create', model: 'fixture', input: [] }))
  const [success] = await received
  expect(JSON.parse(String(success)).type).toBe('response.completed')
  state.accounts[1]!.quotaSnapshot!.primary.usedPercent = 90
  await expect(f.guard({ storageId: 'b'.repeat(64) })).rejects.toThrow('已保留')
  await expect(f.guard({ storageId: 'b'.repeat(64), protected: true })).resolves.toBeUndefined()
  await expect(f.guard()).resolves.toBeUndefined()
  received = once(ws, 'message')
  ws.send(JSON.stringify({ type: 'response.create', model: 'fixture', input: [] }))
  const [rejected] = await received
  expect(JSON.parse(String(rejected)).error.code).toBe('account_quota_protected')
  ws.terminate()
})

it('keeps an active stream open on alias or notice saves and enforces only a changed reserve', async () => {
  const f = await fixture()
  const selected = { storageId: 'account', protectionPercent: 1, quotaUpdatedAtIso: new Date().toISOString(), quotaStatus: 'ready', quotaSnapshot: { primary: { windowMinutes: 300, usedPercent: 80 }, secondary: { windowMinutes: 10080, usedPercent: 80 } } }
  f.setAccountState({ activeStorageId: 'account', accounts: [selected] })
  const stream = await f.post('/v1/responses', { model: 'slow', input: [] })
  expect(stream.status).toBe(200)
  // Metadata saves must not re-enforce an already observed quota snapshot.
  selected.quotaSnapshot.secondary.usedPercent = 99
  const save = vi.spyOn(f.gateway.notifications, 'save').mockResolvedValue({ protectionChanged: false } as any)
  const enforce = vi.spyOn(f.gateway as any, 'enforceObservedProtection').mockImplementation(async () => {
    for (const entry of f.gateway.activity.entries.values()) entry.abort()
  })
  const input = { accountId: 'account', alias: 'local label', protectionPercent: 1 }
  expect((await f.post('/codex-api/api-proxy/notifications', input)).status).toBe(200)
  expect(enforce).not.toHaveBeenCalled()
  expect(f.gateway.activity.entries.size).toBe(1)
  expect(f.upstreamClosed()).toBe(false)
  save.mockResolvedValue({ protectionChanged: true } as any)
  expect((await f.post('/codex-api/api-proxy/notifications', { ...input, protectionPercent: 2 })).status).toBe(200)
  expect(enforce).toHaveBeenCalledExactlyOnceWith(selected)
  await vi.waitFor(() => expect(f.upstreamClosed()).toBe(true))
  await stream.body?.cancel().catch(() => undefined)
})

it('internal activation pins its account independently of API keys and default-route changes', async () => {
  const f = await fixture()
  await f.gateway.store.saveSettings({ ...f.gateway.store.settings, enabled: false, accountStorageId: 'account' })
  const before = await readFile(join(f.gateway.store.directory, 'state.json'), 'utf8')
  const transport = await f.gateway.prepareActivation('fixed', new AbortController().signal)
  expect(transport.storageId).toBe('fixed')
  expect(transport.revision).toBe(1)
  expect(transport.url).toContain('/v1/responses')
  expect(f.requests).toEqual([])
  expect(await readFile(join(f.gateway.store.directory, 'state.json'), 'utf8')).toBe(before)
  transport.release()
})

it('aborted internal preparation never acquires a generation reference', async () => {
  const f = await fixture()
  const abort = new AbortController()
  abort.abort()
  await expect(f.gateway.prepareActivation('fixed', abort.signal)).rejects.toThrow()
  expect(f.gateway.component.hold).not.toHaveBeenCalled()
})

it('optional activation respects long-window quota reserved for normal protected tasks', async () => {
  const f = await fixture()
  f.setAccountState({activeStorageId:'account',accounts:[{storageId:'fixed',protectionPercent:10,quotaStatus:'ready',quotaUpdatedAtIso:new Date().toISOString(),quotaSnapshot:{primary:{windowMinutes:300,usedPercent:0},secondary:{windowMinutes:10080,usedPercent:95}}}]})
  const prepare = vi.mocked(ProxyComponent.prototype.prepare)
  prepare.mockClear()
  await expect(f.gateway.prepareActivation('fixed',new AbortController().signal)).rejects.toThrow('受保护任务')
  expect(prepare).not.toHaveBeenCalled()
})

it('keeps publication activation freeze separate from account switching, normal API drain, and fixed outlet streams', async () => {
  const f = await fixture()
  await f.gateway.activation.ready
  const fixed = 'f'.repeat(64)
  f.setAccountState({ activeStorageId: 'account', accounts: [{ storageId: 'account' }, { storageId: fixed }] })
  await f.gateway.store.updateKey(f.second.key.id, { accountStorageId: fixed })
  const controller = new AbortController()
  try {
    const stream = await fetch(f.base + '/v1/responses', { method: 'POST', headers: f.headers(f.second.secret), body: JSON.stringify({ model: 'slow', stream: true }), signal: controller.signal })
    expect(stream.status).toBe(200)
    f.setOperation({ kind: 'switch', storageId: 'other' })
    const frozen = await f.post('/codex-api/api-proxy/activation/drain', { draining: true })
    expect(frozen.status).toBe(200)
    expect(f.gateway.activation.releaseActivity().draining).toBe(true)
    expect(f.gateway.activity.draining).toBe(false)
    expect([...f.gateway.activity.entries.values()].some(entry => entry.keyId === f.second.key.id && entry.busy)).toBe(true)
    expect((await f.post('/v1/responses', { model: 'fixture' }, f.second.secret)).status).toBe(200)
    expect((await f.post('/v1/responses', { model: 'fixture' })).status).toBe(503)
    expect((await f.post('/codex-api/api-proxy/activation/drain', { draining: false })).status).toBe(200)
    expect(f.gateway.activation.releaseActivity().draining).toBe(false)
    f.setOperation(null)
    expect((await f.post('/v1/responses', { model: 'fixture' })).status).toBe(200)
  } finally { controller.abort() }
})

describe('API key routing policy', () => {
  it('normalizes route settings, keeps model case, and rejects illegal combinations', async () => {
    const store = new ProxyStore(await home()); await store.ready
    const account = 'a'.repeat(64)
    const created = await store.createKey('route', null, {
      forceRoute: { enabled: false, model: '  gpt-5.6-luna  ' },
      aggregateRoute: { enabled: true, entries: [{ model: '  Case-Sensitive  ', accountStorageId: account }, { model: 'plain', accountStorageId: null }] },
    })
    expect(created.key.forceRoute).toEqual({ enabled: false, model: 'gpt-5.6-luna' })
    expect(created.key.aggregateRoute).toEqual({ enabled: true, entries: [{ model: 'Case-Sensitive', accountStorageId: account }, { model: 'plain', accountStorageId: null }] })
    // 强制路由的模型必须存在于聚合清单，比较区分大小写。
    await expect(store.updateKey(created.key.id, { forceRoute: { enabled: true, model: 'plain' } })).resolves.toBeUndefined()
    await expect(store.updateKey(created.key.id, { forceRoute: { enabled: true, model: 'casesensitive' } })).rejects.toThrow('不在聚合路由清单内')
    expect(store.findKey(created.key.id)?.forceRoute).toEqual({ enabled: true, model: 'plain' })
    await expect(store.updateKey(created.key.id, { aggregateRoute: { enabled: true, entries: [{ model: 'dup', accountStorageId: null }, { model: 'dup', accountStorageId: null }] } })).rejects.toThrow('重复模型')
    await expect(store.updateKey(created.key.id, { aggregateRoute: { enabled: true, entries: [{ model: '   ', accountStorageId: null }] } })).rejects.toThrow('缺少模型名')
    await expect(store.updateKey(created.key.id, { aggregateRoute: { enabled: true, entries: [] } })).rejects.toThrow('至少需要一项')
    await expect(store.updateKey(created.key.id, { forceRoute: { enabled: true, model: '   ' } })).rejects.toThrow('必须填写模型名')
    await expect(store.updateKey(created.key.id, { aggregateRoute: { enabled: true, entries: [{ model: 'any', accountStorageId: 'not-a-hash' }] } })).rejects.toThrow('第 1 项账号无效')
    // 关闭聚合路由后强制路由不再受限；清单本身仍然保留在 key 上。
    await expect(store.updateKey(created.key.id, { aggregateRoute: { enabled: false, entries: [] }, forceRoute: { enabled: true, model: 'anything' } })).resolves.toBeUndefined()
    expect(store.findKey(created.key.id)?.forceRoute).toEqual({ enabled: true, model: 'anything' })
    const restarted = new ProxyStore(store.directory); await restarted.ready
    expect(restarted.findKey(created.key.id)?.forceRoute).toEqual({ enabled: true, model: 'anything' })
    expect(restarted.findKey(created.key.id)?.aggregateRoute).toEqual({ enabled: false, entries: [] })
    await store.close(); await restarted.close()
  })
  it('drops damaged route settings on load instead of failing to start', async () => {
    const store = new ProxyStore(await home()); await store.ready
    const created = await store.createKey('damaged', null)
    await store.close()
    const file = join(store.directory, 'state.json')
    const state = JSON.parse(await readFile(file, 'utf8'))
    state.keys[0].forceRoute = { enabled: 'yes', model: 5 }
    state.keys[0].aggregateRoute = { enabled: true, entries: [{ model: 'x', accountStorageId: 'not-a-hash' }] }
    await writeFile(file, JSON.stringify(state))
    const restarted = new ProxyStore(store.directory); await restarted.ready
    const key = restarted.findKey(created.key.id)
    expect(key).toBeTruthy()
    expect(key?.forceRoute).toBeUndefined()
    expect(key?.aggregateRoute).toBeUndefined()
    await restarted.close()
  })
  it('serves the aggregate model union and routes each model to its own account', async () => {
    const f = await fixture()
    const a = 'a'.repeat(64), b = 'b'.repeat(64)
    f.setAccountState({ activeStorageId: a, accounts: [{ storageId: a }, { storageId: b }] })
    const generation = await f.gateway.component.prepare(null)
    const prepared: string[] = []
    const spy = vi.spyOn(ProxyComponent.prototype, 'prepare').mockImplementation(async id => { prepared.push(id!); return { ...generation, id: id!, storageId: id!, references: 0 } })
    try {
      const key = await f.gateway.store.createKey('aggregate', null, { aggregateRoute: { enabled: true, entries: [
        { model: 'gpt-a', accountStorageId: a }, { model: 'gpt-b', accountStorageId: b }, { model: 'gpt-global', accountStorageId: null },
      ] } })
      const catalog = await (await fetch(f.base + '/v1/models', { headers: f.headers(key.secret) })).json()
      expect(catalog).toMatchObject({ object: 'list' })
      expect(catalog.data.map((row: any) => row.id)).toEqual(['gpt-a', 'gpt-b', 'gpt-global'])
      expect(f.requests).toHaveLength(0)
      expect((await f.post('/v1/responses', { model: 'gpt-b', input: [] }, key.secret)).status).toBe(200)
      expect(prepared).toEqual([b])
      expect(f.requests.at(-1)!.body.model).toBe('gpt-b')
      // 清单外的模型按一般透传处理，落到 key 自己的账号（未选择时用全局账号）。
      expect((await f.post('/v1/responses', { model: 'not-listed', input: [] }, key.secret)).status).toBe(200)
      expect(prepared).toEqual([b, a])
      expect(f.requests.at(-1)!.body.model).toBe('not-listed')
      // 清单项的账号为“全局账号”时跟随全局设置。
      expect((await f.post('/v1/responses', { model: 'gpt-global', input: [] }, key.secret)).status).toBe(200)
      expect(prepared).toEqual([b, a, a])
    } finally { spy.mockRestore() }
  })
  it('prefers the caller model and only overrides it when force routing is on', async () => {
    const f = await fixture()
    const key = await f.gateway.store.createKey('forced', null, { forceRoute: { enabled: true, model: 'gpt-forced' } })
    expect((await f.post('/v1/responses', { model: 'caller-model', input: [] }, key.secret)).status).toBe(200)
    expect(f.requests.at(-1)!.body.model).toBe('gpt-forced')
    await f.gateway.store.updateKey(key.key.id, { forceRoute: { enabled: false, model: 'gpt-forced' } })
    // 未开启强制路由时按调用方模型直传，不用本地 models 目录否决。
    expect((await f.post('/v1/responses', { model: 'caller-model', input: [] }, key.secret)).status).toBe(200)
    expect(f.requests.at(-1)!.body.model).toBe('caller-model')
  })
  it('lets a forced model win over the aggregate account choice', async () => {
    const f = await fixture()
    const a = 'a'.repeat(64), b = 'b'.repeat(64)
    f.setAccountState({ activeStorageId: a, accounts: [{ storageId: a }, { storageId: b }] })
    const generation = await f.gateway.component.prepare(null)
    const prepared: string[] = []
    const spy = vi.spyOn(ProxyComponent.prototype, 'prepare').mockImplementation(async id => { prepared.push(id!); return { ...generation, id: id!, storageId: id!, references: 0 } })
    try {
      const key = await f.gateway.store.createKey('aggregate-forced', null, {
        aggregateRoute: { enabled: true, entries: [{ model: 'gpt-a', accountStorageId: a }, { model: 'gpt-b', accountStorageId: b }] },
        forceRoute: { enabled: true, model: 'gpt-b' },
      })
      for (const model of ['gpt-a', 'gpt-b']) expect((await f.post('/v1/responses', { model, input: [] }, key.secret)).status).toBe(200)
      expect(prepared).toEqual([b, b])
      expect(f.requests.map(row => row.body.model)).toEqual(['gpt-b', 'gpt-b'])
    } finally { spy.mockRestore() }
  })
  it('opens an aggregate WebSocket upstream only on the first frame model', async () => {
    const f = await fixture()
    const a = 'a'.repeat(64), b = 'b'.repeat(64)
    f.setAccountState({ activeStorageId: a, accounts: [{ storageId: a }, { storageId: b }] })
    const generation = await f.gateway.component.prepare(null)
    const prepared: string[] = []
    const spy = vi.spyOn(ProxyComponent.prototype, 'prepare').mockImplementation(async id => { prepared.push(id!); return { ...generation, id: id!, storageId: id!, references: 0 } })
    const key = await f.gateway.store.createKey('aggregate-ws', null, { aggregateRoute: { enabled: true, entries: [{ model: 'gpt-b', accountStorageId: b }] } })
    const ws = new WebSocket(f.base.replace('http:', 'ws:') + '/v1/responses', { headers: f.headers(key.secret) })
    try {
      await once(ws, 'open')
      expect(prepared).toEqual([])
      const received = once(ws, 'message')
      ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-b', input: [] }))
      expect(JSON.parse(String((await received)[0])).type).toBe('response.completed')
      expect(prepared).toEqual([b])
    } finally { ws.terminate(); spy.mockRestore() }
  })
  it('keeps an aggregate model pinned to account B through a primary switch', async () => {
    const f = await fixture()
    const a = 'a'.repeat(64), b = 'b'.repeat(64)
    f.setAccountState({ activeStorageId: a, accounts: [{ storageId: a }, { storageId: b }] })
    const aggregate = await f.gateway.store.createKey('aggregate-switch', null, { aggregateRoute: { enabled: true, entries: [{ model: 'slow', accountStorageId: b }] } })
    const defaultAbort = new AbortController()
    const aggregateAbort = new AbortController()
    try {
      const defaultResponse = await fetch(f.base + '/v1/responses', { method: 'POST', headers: f.headers(), body: JSON.stringify({ model: 'slow', stream: true }), signal: defaultAbort.signal })
      const aggregateResponse = await fetch(f.base + '/v1/responses', { method: 'POST', headers: f.headers(aggregate.secret), body: JSON.stringify({ model: 'slow', stream: true }), signal: aggregateAbort.signal })
      expect(defaultResponse.status).toBe(200)
      expect(aggregateResponse.status).toBe(200)
      f.setOperation({ kind: 'switch', storageId: b })
      const release = await f.lifecycle().beforeMutation('switch', b)
      release()
      await vi.waitFor(() => expect([...f.gateway.activity.entries.values()].map(entry => entry.keyId)).toEqual([aggregate.key.id]))
      expect([...f.gateway.activity.entries.values()][0]?.storageId).toBe(b)
    } finally {
      defaultAbort.abort()
      aggregateAbort.abort()
      f.setOperation(null)
    }
  })
  it('rejects same-key WS continuation when the aggregate model changes accounts', async () => {
    const f = await fixture()
    const a = 'a'.repeat(64), b = 'b'.repeat(64)
    f.setAccountState({ activeStorageId: a, accounts: [{ storageId: a }, { storageId: b }] })
    const generation = await f.gateway.component.prepare(null)
    const prepared: string[] = []
    const spy = vi.spyOn(ProxyComponent.prototype, 'prepare').mockImplementation(async id => { prepared.push(id!); return { ...generation, id: id!, storageId: id!, references: 0 } })
    const key = await f.gateway.store.createKey('aggregate-continuation', null, { aggregateRoute: { enabled: true, entries: [{ model: 'gpt-a', accountStorageId: a }, { model: 'gpt-b', accountStorageId: b }] } })
    const first = new WebSocket(f.base.replace('http:', 'ws:') + '/v1/responses', { headers: f.headers(key.secret) })
    try {
      await once(first, 'open')
      const completed = once(first, 'message')
      first.send(JSON.stringify({ type: 'response.create', model: 'gpt-a', input: [] }))
      const previous = JSON.parse(String((await completed)[0])).response.id
      first.terminate()
      await once(first, 'close')

      const second = new WebSocket(f.base.replace('http:', 'ws:') + '/v1/responses', { headers: f.headers(key.secret) })
      try {
        await once(second, 'open')
        const rejected = once(second, 'message')
        second.send(JSON.stringify({ type: 'response.create', model: 'gpt-b', previous_response_id: previous, input: [] }))
        const payload = JSON.parse(String((await rejected)[0]))
        expect(payload.error.code).toBe('previous_response_not_found')
        expect(f.requests.filter(row => row.path === 'ws')).toHaveLength(1)
        expect(prepared).toEqual([a, b])
        await vi.waitFor(() => expect(f.gateway.activity.entries.size).toBe(0))
      } finally { second.terminate() }
    } finally { first.terminate(); spy.mockRestore() }
  })
  it('counts a dynamic aggregate upload before routing and force-stops it without upstream traffic', async () => {
    const f = await fixture()
    const a = 'a'.repeat(64), b = 'b'.repeat(64)
    f.setAccountState({ activeStorageId: a, accounts: [{ storageId: a }, { storageId: b }] })
    const key = await f.gateway.store.createKey('aggregate-upload', null, { aggregateRoute: { enabled: true, entries: [{ model: 'gpt-b', accountStorageId: b }] } })
    const port = Number(new URL(f.base).port)
    const socket = connect(port, '127.0.0.1')
    try {
      await once(socket, 'connect')
      socket.write(`POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${key.secret}\r\nContent-Type: application/json\r\nContent-Length: 64\r\nConnection: close\r\n\r\n{"model":"gpt-b",`)
      await vi.waitFor(() => expect(f.gateway.activity.snapshot().entries.some((row: any) => row.phase === 'reading')).toBe(true))
      expect(f.gateway.activity.snapshot().activeRequests).toBe(1)
      const stopped = await f.post('/codex-api/api-proxy/settings', { settings: { enabled: false }, force: true })
      expect(stopped.status).toBe(200)
      await vi.waitFor(() => expect(f.gateway.activity.entries.size).toBe(0))
      expect(f.requests).toHaveLength(0)
      expect(f.gateway.activity.entries.size).toBe(0)
    } finally {
      socket.destroy()
    }
  })
  it('keeps an unbound aggregate upload when a primary switch does not affect its eventual account', async () => {
    const f = await fixture()
    const a = 'a'.repeat(64), b = 'b'.repeat(64)
    f.setAccountState({ activeStorageId: a, accounts: [{ storageId: a }, { storageId: b }] })
    const key = await f.gateway.store.createKey('aggregate-switch-upload', null, { aggregateRoute: { enabled: true, entries: [{ model: 'gpt-b', accountStorageId: b }] } })
    const socket = connect(Number(new URL(f.base).port), '127.0.0.1')
    try {
      await once(socket, 'connect')
      socket.write(`POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${key.secret}\r\nContent-Type: application/json\r\nContent-Length: 28\r\nConnection: close\r\n\r\n{"model":"gpt-b",`)
      await vi.waitFor(() => expect(f.gateway.activity.snapshot().entries.some((row: any) => row.phase === 'reading')).toBe(true))
      const release = await f.lifecycle().beforeMutation('switch', b)
      release()
      socket.write('"input":[]}')
      await vi.waitFor(() => expect(f.requests).toHaveLength(1))
      expect(f.requests[0]?.body.model).toBe('gpt-b')
    } finally { socket.destroy() }
  })
  it('rechecks the primary-route block after a static account waits for its body', async () => {
    const f = await fixture()
    const socket = connect(Number(new URL(f.base).port), '127.0.0.1')
    try {
      await once(socket, 'connect')
      socket.write(`POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${f.first.secret}\r\nContent-Type: application/json\r\nContent-Length: 30\r\nConnection: close\r\n\r\n{"model":"fixture",`)
      await vi.waitFor(() => expect(f.gateway.activity.entries.size).toBe(1))
      expect([...f.gateway.activity.entries.values()][0]?.storageId).toBe('account')
      f.setOperation({ kind: 'switch', storageId: 'other' })
      socket.write('"input":[]}')
      await vi.waitFor(() => expect(f.gateway.activity.entries.size).toBe(0))
      expect(f.requests).toHaveLength(0)
    } finally {
      socket.destroy()
      f.setOperation(null)
    }
  })
  it('aborts an unbound aggregate upload when a listed target account is removed', async () => {
    const f = await fixture()
    const a = 'a'.repeat(64), b = 'b'.repeat(64)
    f.setAccountState({ activeStorageId: a, accounts: [{ storageId: a }, { storageId: b }] })
    const key = await f.gateway.store.createKey('aggregate-remove', null, { aggregateRoute: { enabled: true, entries: [{ model: 'gpt-b', accountStorageId: b }] } })
    const socket = connect(Number(new URL(f.base).port), '127.0.0.1')
    try {
      await once(socket, 'connect')
      socket.write(`POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${key.secret}\r\nContent-Type: application/json\r\nContent-Length: 64\r\nConnection: close\r\n\r\n{"model":"gpt-b",`)
      await vi.waitFor(() => expect(f.gateway.activity.snapshot().entries.some((row: any) => row.phase === 'reading')).toBe(true))
      const release = await f.lifecycle().beforeMutation('remove', b)
      release()
      await vi.waitFor(() => expect(f.gateway.activity.entries.size).toBe(0))
      expect(f.requests).toHaveLength(0)
    } finally { socket.destroy() }
  })
  it('does not start a second aggregate WebSocket prepare while the first frame is connecting', async () => {
    const f = await fixture()
    const account = 'b'.repeat(64)
    f.setAccountState({ activeStorageId: account, accounts: [{ storageId: account }] })
    const generation = await f.gateway.component.prepare(null)
    const prepared: string[] = []
    let releasePrepare!: () => void
    const preparing = new Promise<void>(resolve => { releasePrepare = resolve })
    const spy = vi.spyOn(ProxyComponent.prototype, 'prepare').mockImplementation(async id => {
      prepared.push(id!)
      await preparing
      return { ...generation, id: id!, storageId: id!, references: 0 }
    })
    const key = await f.gateway.store.createKey('aggregate-double-first', null, { aggregateRoute: { enabled: true, entries: [{ model: 'gpt-b', accountStorageId: account }] } })
    const ws = new WebSocket(f.base.replace('http:', 'ws:') + '/v1/responses', { headers: f.headers(key.secret) })
    try {
      await once(ws, 'open')
      ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-b', input: [] }))
      await vi.waitFor(() => expect(prepared).toHaveLength(1))
      ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-b', input: [] }))
      await sleep(20)
      expect(prepared).toHaveLength(1)
    } finally {
      releasePrepare()
      ws.terminate()
      spy.mockRestore()
    }
  })
  it('counts an aggregate WebSocket waiting for its first frame and drains it', async () => {
    const f = await fixture()
    const account = 'b'.repeat(64)
    f.setAccountState({ activeStorageId: account, accounts: [{ storageId: account }] })
    const key = await f.gateway.store.createKey('aggregate-waiting', null, { aggregateRoute: { enabled: true, entries: [{ model: 'gpt-b', accountStorageId: account }] } })
    const ws = new WebSocket(f.base.replace('http:', 'ws:') + '/v1/responses', { headers: f.headers(key.secret) })
    try {
      await once(ws, 'open')
      await vi.waitFor(() => expect(f.gateway.activity.snapshot().entries.some((row: any) => row.phase === 'waiting-first-frame')).toBe(true))
      expect(f.gateway.activity.snapshot().activeRequests).toBe(0)
      const drained = await f.post('/codex-api/api-proxy/drain', { draining: true })
      expect(drained.status).toBe(200)
      await vi.waitFor(() => expect(f.gateway.activity.entries.size).toBe(0))
    } finally { ws.terminate() }
  })
})
