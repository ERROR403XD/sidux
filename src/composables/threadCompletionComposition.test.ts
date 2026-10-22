import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDesktopState } from './useDesktopState'

const api = vi.hoisted(() => ({ subscribe: vi.fn(), fetch: vi.fn(), list: vi.fn(), detail: vi.fn() }))
vi.mock('../api/codexRpcClient', () => ({ subscribeRpcNotifications: api.subscribe }))
vi.mock('../api/threadReadGateway', () => ({
  getThreadGroupsPage: api.list, getThreadDetail: api.detail, getBackgroundThreadListLimit: () => 100,
}))
vi.mock('../api/projectGateway', () => ({ getWorkspaceRootsState: vi.fn().mockRejectedValue(new Error('isolated')) }))
vi.mock('../api/threadPreferencesGateway', () => ({ getThreadTitleCache: vi.fn().mockResolvedValue({ titles: {} }), persistThreadTitle: vi.fn() }))
vi.mock('../api/threadCommandGateway', () => ({
  getCurrentModelConfig: vi.fn().mockResolvedValue({ model: '', providerId: '', reasoningEffort: '', speedMode: '' }),
  getAvailableModels: vi.fn().mockResolvedValue([]),
}))
vi.mock('../api/accountGateway', () => ({ getAccountRateLimits: vi.fn().mockResolvedValue(null) }))
vi.mock('../api/threadQueueGateway', () => ({ getThreadQueueState: vi.fn().mockResolvedValue({}), getDeliveryStatuses: vi.fn().mockResolvedValue([]) }))
vi.mock('../api/runtimeGateway', () => ({ getPendingServerRequests: vi.fn().mockResolvedValue([]) }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const response = (data: Record<string, string>) => ({ ok: true, json: async () => ({ data }) })
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

async function setup() {
  vi.stubGlobal('window', {
    localStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() },
    setTimeout: vi.fn(), clearTimeout: vi.fn(),
  })
  vi.stubGlobal('fetch', api.fetch)
  const handlers: Array<(event: { method: string; params: unknown }) => void> = []
  api.subscribe.mockImplementation(handler => { handlers.push(handler); return vi.fn() })
  const state = useDesktopState()
  state.primeSelectedThread('viewed')
  state.startPolling()
  await state.refreshAll({ includeSelectedThreadMessages: false })
  const notify = (method: string, params = {}) => handlers.at(-1)!({ method, params })
  return {
    state, notify,
    ready: () => notify('ready'),
    complete: (threadId: string, token: string | null) => notify('codexapp/completions/changed', { threadId, token }),
    unread: (id: string) => state.projectGroups.value.flatMap(group => group.threads).find(thread => thread.id === id)?.unread,
    restart: () => { state.stopPolling(); state.startPolling() },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.fetch.mockReset().mockResolvedValue(response({}))
  api.list.mockResolvedValue({ groups: [{ projectName: 'p', threads: ['viewed', 'old', 'new'].map(id => ({
    id, title: id, projectName: 'p', cwd: '/p', hasWorktree: false, preview: '', unread: false, inProgress: false,
    createdAtIso: '2026-10-12T00:00:00Z', updatedAtIso: '2026-10-12T00:00:00Z',
  })) }], nextCursor: null })
  api.detail.mockResolvedValue({ messages: [], inProgress: false, activeTurnId: '', turnIndexByTurnId: {} })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('completion snapshot lifecycle through the real desktop owner', () => {
  it.each(['response', 'body'])('does not restore unread markers from a late %s after stop', async phase => {
    const test = await setup()
    const oldResponse = deferred<ReturnType<typeof response>>()
    const oldBody = deferred<{ data: Record<string, string> }>()
    api.fetch.mockReturnValueOnce(phase === 'response' ? oldResponse.promise : Promise.resolve({ ok: true, json: () => oldBody.promise }))
    test.ready()
    await flush()
    test.state.stopPolling()
    if (phase === 'response') oldResponse.resolve(response({ old: 'stale' }))
    else oldBody.resolve({ data: { old: 'stale' } })
    await flush()
    test.state.primeSelectedThread('new')
    expect(test.unread('old')).toBe(false)
    test.state.markThreadAsRead('old')
    expect(api.fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
  })

  it('starts a fresh snapshot after restart without joining the stopped request', async () => {
    const test = await setup()
    const old = deferred<ReturnType<typeof response>>()
    api.fetch.mockReturnValueOnce(old.promise).mockResolvedValueOnce(response({ new: 'current' }))
    test.ready()
    await flush()
    test.restart()
    test.ready()
    await flush()
    expect(api.fetch).toHaveBeenCalledTimes(2)
    old.resolve(response({ old: 'stale' }))
    await flush()
    expect(test.unread('old')).toBe(false)
    expect(test.unread('new')).toBe(true)
    test.state.stopPolling()
  })

  it.each(['success', 'failure'])('does not let the old snapshot %s release the new request slot or delta buffer', async outcome => {
    const test = await setup()
    const old = deferred<ReturnType<typeof response>>()
    const current = deferred<ReturnType<typeof response>>()
    api.fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    test.ready()
    await flush()
    test.restart()
    test.ready()
    await flush()
    test.complete('new', 'live')
    if (outcome === 'success') old.resolve(response({ old: 'stale' }))
    else old.reject(new Error('offline'))
    await flush()
    test.ready()
    await flush()
    expect(api.fetch).toHaveBeenCalledTimes(2)
    current.resolve(response({ old: 'snapshot', new: 'older' }))
    await flush()
    test.state.markThreadAsRead('new')
    await flush()
    const post = api.fetch.mock.calls.find(([, options]) => options?.method === 'POST')
    expect(post && JSON.parse(post[1].body)).toEqual({ threadId: 'new', token: 'live' })
    test.state.stopPolling()
  })

  it('merges live completion and deletion over a pending snapshot, coalesces only the active read, and refreshes on later ready', async () => {
    const test = await setup()
    const pending = deferred<ReturnType<typeof response>>()
    api.fetch.mockReturnValueOnce(pending.promise)
    test.ready()
    test.ready()
    test.complete('new', 'live')
    test.complete('old', null)
    pending.resolve(response({ new: 'older', old: 'deleted' }))
    await flush()
    expect(api.fetch).toHaveBeenCalledOnce()
    expect(test.unread('new')).toBe(true)
    expect(test.unread('old')).toBe(false)
    test.state.markThreadAsRead('new')
    await flush()
    expect(JSON.parse(api.fetch.mock.calls.at(-1)![1].body).token).toBe('live')
    test.ready()
    await flush()
    expect(api.fetch.mock.calls.filter(([, options]) => !options?.method)).toHaveLength(2)
    test.state.stopPolling()
  })
})
