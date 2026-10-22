import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDesktopState } from './useDesktopState'

const api = vi.hoisted(() => ({
  subscribe: vi.fn(), pending: vi.fn(), queue: vi.fn(), list: vi.fn(), history: vi.fn(),
  config: vi.fn(), models: vi.fn(), quota: vi.fn(), fetch: vi.fn(), reconnect: vi.fn(),
}))
vi.mock('../api/codexRpcClient', () => ({ subscribeRpcNotifications: api.subscribe }))
vi.mock('../api/runtimeGateway', () => ({ getPendingServerRequests: api.pending }))
vi.mock('../api/threadQueueGateway', () => ({ getThreadQueueState: api.queue, getDeliveryStatuses: vi.fn().mockResolvedValue([]) }))
vi.mock('../api/threadReadGateway', () => ({
  getThreadGroupsPage: api.list, getThreadDetail: api.history, resumeThread: api.history,
  invalidateThreadResumeCache: vi.fn(), getBackgroundThreadListLimit: () => 100,
}))
vi.mock('../api/projectGateway', () => ({ getWorkspaceRootsState: vi.fn().mockRejectedValue(new Error('isolated')) }))
vi.mock('../api/threadPreferencesGateway', () => ({ getThreadTitleCache: vi.fn().mockResolvedValue({ titles: {} }), persistThreadTitle: vi.fn() }))
vi.mock('../api/threadCommandGateway', () => ({ getCurrentModelConfig: api.config, getAvailableModels: api.models }))
vi.mock('../api/accountGateway', () => ({ getAccountRateLimits: api.quota }))
vi.mock('../subtasks', () => ({ observeTaskNotification: api.reconnect }))

const flush = async () => { for (let index = 0; index < 24; index += 1) await Promise.resolve() }

function setup() {
  vi.stubGlobal('window', {
    localStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() },
    setTimeout: vi.fn(), clearTimeout: vi.fn(),
  })
  vi.stubGlobal('fetch', api.fetch)
  const callbacks: Array<(event: { method: string; params: unknown }) => void> = []
  const cleanups: ReturnType<typeof vi.fn>[] = []
  api.subscribe.mockImplementation(callback => {
    callbacks.push(callback)
    const cleanup = vi.fn()
    cleanups.push(cleanup)
    return cleanup
  })
  const state = useDesktopState()
  return { state, callbacks, cleanups, notify: (method: string, params = {}) => callbacks.at(-1)!({ method, params }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.pending.mockReset().mockResolvedValue([])
  api.queue.mockReset().mockResolvedValue({})
  api.list.mockReset().mockResolvedValue({ groups: [], nextCursor: null })
  api.history.mockReset().mockResolvedValue({ messages: [], inProgress: false, activeTurnId: '', turnIndexByTurnId: {}, hasMoreOlder: false })
  api.config.mockReset().mockResolvedValue({ model: '', providerId: '', reasoningEffort: '', speedMode: '' })
  api.models.mockReset().mockResolvedValue([])
  api.quota.mockReset().mockResolvedValue(null)
  api.fetch.mockReset().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('subscription and reconnect through the real desktop owners', () => {
  it('starts one stream and joins a pending restoration still in flight at the first ready', async () => {
    const test = setup()
    let resolve!: (value: unknown[]) => void
    api.pending.mockReturnValueOnce(new Promise(done => { resolve = done }))
    test.state.startPolling()
    test.state.startPolling()
    test.notify('ready')
    await flush()
    expect(api.subscribe).toHaveBeenCalledOnce()
    expect(api.pending).toHaveBeenCalledOnce()
    expect(api.queue).toHaveBeenCalledOnce()
    expect(api.fetch).toHaveBeenCalledExactlyOnceWith('/codex-api/thread-completions')
    expect(api.config).not.toHaveBeenCalled()
    expect(api.quota).not.toHaveBeenCalled()
    expect(api.reconnect).not.toHaveBeenCalled()
    resolve([])
    await flush()
    expect(api.list).toHaveBeenCalledOnce()
    expect(api.history).not.toHaveBeenCalled()
    test.state.stopPolling()
    expect(test.cleanups[0]).toHaveBeenCalledOnce()
  })

  it('aligns every settled ready while model and quota refreshes start only on reconnect', async () => {
    const test = setup()
    test.state.startPolling()
    await flush()
    test.notify('ready')
    await flush()
    expect(api.config).not.toHaveBeenCalled()
    expect(api.quota).not.toHaveBeenCalled()
    test.notify('ready')
    await flush()
    expect(api.config).toHaveBeenCalledOnce()
    expect(api.quota).toHaveBeenCalledOnce()
    expect(api.queue).toHaveBeenCalledTimes(2)
    expect(api.fetch).toHaveBeenCalledTimes(2)
    expect(api.reconnect).toHaveBeenCalledExactlyOnceWith({ method: 'codexapp/reconnected', params: {} })
    expect(api.subscribe).toHaveBeenCalledOnce()
    test.state.stopPolling()
  })

  it('keeps the CODEX_HOME stream across an account change and accepts current notifications', async () => {
    const test = setup()
    test.state.startPolling()
    await test.state.refreshAll({ accountChanged: true, includeThreads: false, includeSelectedThreadMessages: false })
    test.state.primeSelectedThread('a')
    test.notify('turn/started', { threadId: 'a', turn: { id: 'current' } })
    expect(api.subscribe).toHaveBeenCalledOnce()
    expect(test.cleanups[0]).not.toHaveBeenCalled()
    expect(test.state.selectedLiveOverlay.value?.activityLabel).toBe('Thinking')
    test.state.stopPolling()
  })

  it('rejects all old dispatch branches after restart and treats the new first ready as initial', async () => {
    const test = setup()
    test.state.startPolling()
    test.notify('ready')
    await flush()
    const old = test.callbacks[0]
    test.state.stopPolling()
    test.state.startPolling()
    await flush()
    test.state.primeSelectedThread('a')
    const counts = [api.pending, api.queue, api.fetch, api.config, api.quota].map(mock => mock.mock.calls.length)
    for (const method of ['ready', 'codexapp/completions/changed', 'codexapp/queue/changed', 'turn/started']) {
      old({ method, params: { threadId: 'a', token: 'stale', turn: { id: 'stale' } } })
    }
    await flush()
    expect([api.pending, api.queue, api.fetch, api.config, api.quota].map(mock => mock.mock.calls.length)).toEqual(counts)
    expect(test.state.selectedLiveOverlay.value).toBeNull()
    test.state.primeSelectedThread('')
    test.notify('ready')
    await flush()
    expect(api.reconnect).not.toHaveBeenCalled()
    test.state.primeSelectedThread('a')
    test.notify('turn/started', { threadId: 'a', turn: { id: 'current' } })
    expect(test.state.selectedLiveOverlay.value?.activityLabel).toBe('Thinking')
    expect(api.subscribe).toHaveBeenCalledTimes(2)
    test.state.stopPolling()
    expect(test.cleanups.every(cleanup => cleanup.mock.calls.length === 1)).toBe(true)
  })
})
