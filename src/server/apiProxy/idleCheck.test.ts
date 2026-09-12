import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
const { checkIdle } = createRequire(import.meta.url)('../../../scripts/check-codexapp-idle.cjs')
afterEach(() => vi.unstubAllGlobals())
function responses(api: unknown, activity?: unknown, activation?: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname
    if (path === '/codex-api/api-proxy/activation/activity') return activation === undefined ? new Response('{}', { status: 404 }) : new Response(JSON.stringify({ data: typeof activation === 'function' ? activation() : activation }));
    if (path === '/codex-api/runtime/activity') return activity === undefined ? new Response('{}', { status: 404 }) : new Response(JSON.stringify({ data: activity }));
    const payload = path === '/codex-api/automation-runtime' ? { data: { ready: true, activeCount: 0, queuedCount: 0 } }
      : path === '/codex-api/thread-queue-state' ? { data: {} }
      : path === '/codex-api/server-requests/pending' ? { data: [] }
      : path === '/codex-api/meta/methods' ? { data: [] }
      : path === '/codex-api/rpc' ? { result: { data: [], nextCursor: null } }
      : api
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
}
describe('release API activity inventory', () => {
  it('fails closed when proxy activity cannot be read', async () => {
    responses({})
    await expect(checkIdle('http://fixture')).rejects.toThrow('API proxy activity')
  })
  it('does not treat a disabled outlet with closing connections as idle', async () => {
    responses({ data: { settings: { enabled: false }, activity: { connections: 1, activeRequests: 0 } } })
    expect((await checkIdle('http://fixture')).idle).toBe(false)
  })
  it('accepts an explicit empty snapshot and permits only an explicit legacy exemption', async () => {
    responses({ data: { settings: { enabled: false }, activity: { connections: 0, activeRequests: 0 } } })
    expect((await checkIdle('http://fixture')).idle).toBe(true)
    responses({})
    expect((await checkIdle('http://fixture', { legacyApiProxy: true })).idle).toBe(true)
  })
})


describe('native background activity before cutover', () => {
  function nativeFixture(options: { process?: boolean; fail?: boolean; repeatCursor?: boolean; count?: number } = {}) {
    let activeReads = 0
    let peakReads = 0
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname
      if (path === '/codex-api/api-proxy/activation/activity') return new Response('{}', { status: 404 });
      if (path === '/codex-api/runtime/activity') return new Response('{}', { status: 404 });
      const request = path === '/codex-api/rpc' ? JSON.parse(String(init?.body)) : null
      calls.push(request?.method || path)
      let payload: unknown
      if (path === '/codex-api/automation-runtime') payload = { data: { ready: true, activeCount: 0, queuedCount: 0 } }
      else if (path === '/codex-api/thread-queue-state') payload = { data: {} }
      else if (path === '/codex-api/server-requests/pending') payload = { data: [] }
      else if (path === '/codex-api/api-proxy/status') payload = { data: { settings: { enabled: false }, activity: { connections: 0, activeRequests: 0 } } }
      else if (path === '/codex-api/meta/methods') payload = { data: ['thread/loaded/list', 'thread/backgroundTerminals/list'] }
      else if (request?.method === 'thread/list') payload = { result: { data: [{ id: 'completed-turn-thread', status: { type: 'idle' } }], nextCursor: null } }
      else if (request?.method === 'thread/loaded/list') payload = { result: { data: Array.from({ length: options.count ?? 1 }, (_, i) => `loaded-${i}`), nextCursor: options.repeatCursor ? 'same' : null } }
      else if (request?.method === 'thread/backgroundTerminals/list') {
        expect(request.params.limit).toBe(1)
        activeReads++
        peakReads = Math.max(peakReads, activeReads)
        await new Promise(resolve => setTimeout(resolve, 1))
        activeReads--
        payload = options.fail ? { error: 'unavailable' } : { result: { data: options.process ? [{ processId: '17' }] : [], nextCursor: null } }
      }
      return new Response(JSON.stringify(payload), { status: 200 })
    }))
    return { calls, peak: () => peakReads }
  }

  it('blocks a completed turn that left a native background command running', async () => {
    const fixture = nativeFixture({ process: true })
    const result = await checkIdle('http://fixture')
    expect(result).toMatchObject({ activeTurns: 0, loadedThreads: 1, backgroundThreads: 1, idle: false })
    expect(fixture.calls).not.toContain('thread/read')
    expect(fixture.calls.some(method => method.includes('terminate'))).toBe(false)
  })

  it('fails closed on unknown terminal state or a repeated loaded cursor', async () => {
    nativeFixture({ fail: true })
    await expect(checkIdle('http://fixture')).rejects.toThrow('backgroundTerminals')
    nativeFixture({ repeatCursor: true })
    await expect(checkIdle('http://fixture')).rejects.toThrow('cursor')
  })

  it('bounds parallel metadata reads to four without scanning unloaded histories', async () => {
    const fixture = nativeFixture({ count: 11 })
    expect((await checkIdle('http://fixture')).idle).toBe(true)
    expect(fixture.peak()).toBe(4)
    expect(fixture.calls.filter(method => method === 'thread/backgroundTerminals/list')).toHaveLength(11)
    expect(fixture.calls.filter(method => method === 'thread/loaded/list')).toHaveLength(1)
  })
})

it('blocks a received turn that has not reached the thread catalog yet', async () => {
  responses({ data: { settings: { enabled: false }, activity: { connections: 0, activeRequests: 0 } } }, { activeTurnThreadIds: ['new-thread'], pendingOperationCount: 0 })
  expect(await checkIdle('http://fixture')).toMatchObject({ activeTurns: 0, liveActivityCount: 1, idle: false })
})
it('fails closed on a malformed live activity snapshot', async () => {
  responses({}, { activeTurnThreadIds: [], pendingOperationCount: 'unknown' })
  await expect(checkIdle('http://fixture')).rejects.toThrow('live runtime activity')
})

const emptyApi = { data: { settings: { enabled: false }, activity: { connections: 0, activeRequests: 0 } } }
it('counts activation independently of ordinary API requests and reports older servers as unsupported', async () => {
  responses(emptyApi, undefined, { ready: true, draining: false, activeCount: 1 })
  expect(await checkIdle('http://fixture')).toMatchObject({ idle: false, activationCount: 1, apiActiveRequests: 0 })
  responses(emptyApi)
  expect(await checkIdle('http://fixture')).toMatchObject({ idle: true, activationCount: null })
})
it('fails closed on unavailable activation and rechecks work started during inventory', async () => {
  responses(emptyApi, undefined, { ready: false, draining: false, activeCount: 0 })
  await expect(checkIdle('http://fixture')).rejects.toThrow('activation activity')
  let reads = 0
  responses(emptyApi, undefined, () => ({ ready: true, draining: false, activeCount: reads++ }))
  expect(await checkIdle('http://fixture')).toMatchObject({ idle: false, activationCount: 1 })
})
