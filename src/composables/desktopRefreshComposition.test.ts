import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDesktopState } from './useDesktopState'

const api = vi.hoisted(() => ({ queue: vi.fn(), list: vi.fn(), history: vi.fn() }))
vi.mock('../api/threadQueueGateway', () => ({
  getThreadQueueState: api.queue, getDeliveryStatuses: vi.fn().mockResolvedValue([]),
}))
vi.mock('../api/threadReadGateway', () => ({
  getThreadGroupsPage: api.list, getThreadDetail: api.history, resumeThread: api.history,
  invalidateThreadResumeCache: vi.fn(), getBackgroundThreadListLimit: () => 100,
}))
vi.mock('../api/projectGateway', () => ({ getWorkspaceRootsState: vi.fn().mockRejectedValue(new Error('isolated')) }))
vi.mock('../api/threadPreferencesGateway', () => ({ getThreadTitleCache: vi.fn().mockResolvedValue({ titles: {} }), persistThreadTitle: vi.fn() }))
const flush = async () => { for (let index = 0; index < 24; index += 1) await Promise.resolve() }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const page = { groups: [], nextCursor: null }
const history = { messages: [], inProgress: false, activeTurnId: '', turnIndexByTurnId: {}, hasMoreOlder: false }
const states: ReturnType<typeof useDesktopState>[] = []
function setup() {
  vi.stubGlobal('window', {
    localStorage: { getItem: () => null, setItem: vi.fn() }, setTimeout: vi.fn(), clearTimeout: vi.fn(),
  })
  const state = useDesktopState()
  states.push(state)
  return state
}
beforeEach(() => {
  api.queue.mockReset().mockResolvedValue({})
  api.list.mockReset().mockResolvedValue(page)
  api.history.mockReset().mockResolvedValue(history)
})
afterEach(() => { states.splice(0).forEach(state => state.stopPolling()); vi.unstubAllGlobals() })

describe('refresh coordination through real desktop owners', () => {
  it('rejects an old queue preparation after an account switch without starting a list or history read', async () => {
    const state = setup()
    state.primeSelectedThread('a')
    const waiting = deferred<Record<string, never>>()
    api.queue.mockReturnValueOnce(waiting.promise)
    const old = state.refreshAll()
    await flush()
    await state.refreshAll({ accountChanged: true, includeThreads: false, includeSelectedThreadMessages: false })
    waiting.resolve({})
    await old
    expect(api.queue).toHaveBeenCalledTimes(2)
    expect(api.list).not.toHaveBeenCalled()
    expect(api.history).not.toHaveBeenCalled()
  })

  it('rejects list-to-history continuation after stop', async () => {
    const state = setup()
    state.primeSelectedThread('a')
    const waiting = deferred<typeof page>()
    api.list.mockReturnValueOnce(waiting.promise)
    const old = state.refreshAll()
    await flush()
    state.stopPolling()
    waiting.resolve(page)
    await old
    expect(api.list).toHaveBeenCalledOnce()
    expect(api.history).not.toHaveBeenCalled()
  })

  it('does not replace a new account page error with a late history error', async () => {
    const state = setup()
    state.primeSelectedThread('a')
    const waiting = deferred<typeof history>()
    api.history.mockReturnValueOnce(waiting.promise)
    const old = state.refreshAll({ includeThreads: false })
    await flush()
    expect(api.history).toHaveBeenCalledOnce()
    await state.refreshAll({ accountChanged: true, includeThreads: false, includeSelectedThreadMessages: false })
    state.error.value = 'Current account error'
    waiting.reject(new Error('Old history error'))
    await old
    expect(state.error.value).toBe('Current account error')
    expect(api.history).toHaveBeenCalledOnce()
  })

  it('reads the current selected conversation after queue preparation settles', async () => {
    const state = setup()
    state.primeSelectedThread('a')
    const waiting = deferred<Record<string, never>>()
    api.queue.mockReturnValueOnce(waiting.promise)
    const refresh = state.refreshAll({ includeThreads: false })
    await flush()
    state.primeSelectedThread('b')
    waiting.resolve({})
    await refresh
    expect(api.history).toHaveBeenCalledOnce()
    expect(api.history.mock.calls[0]?.[0]).toBe('b')
  })
})
