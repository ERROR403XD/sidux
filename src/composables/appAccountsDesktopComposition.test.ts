import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppAccountsController } from './appAccountsController'
import { useDesktopState } from './useDesktopState'
import type { UiAccountEntry } from '../types/codex'

const api = vi.hoisted(() => ({ accounts: vi.fn(), switch: vi.fn(), list: vi.fn(), history: vi.fn(), subscribe: vi.fn() }))
vi.mock('../api/accountGateway', () => ({ getAccounts: api.accounts, switchAccount: api.switch }))
vi.mock('../api/threadQueueGateway', () => ({ getThreadQueueState: vi.fn().mockResolvedValue({}), getDeliveryStatuses: vi.fn().mockResolvedValue([]) }))
vi.mock('../api/threadReadGateway', () => ({
  getThreadGroupsPage: api.list, getThreadDetail: api.history, resumeThread: api.history,
  invalidateThreadResumeCache: vi.fn(), getBackgroundThreadListLimit: () => 100,
}))
vi.mock('../api/projectGateway', () => ({ getWorkspaceRootsState: vi.fn().mockRejectedValue(new Error('isolated')) }))
vi.mock('../api/threadPreferencesGateway', () => ({ getThreadTitleCache: vi.fn().mockResolvedValue({ titles: {} }), persistThreadTitle: vi.fn() }))
vi.mock('../api/codexRpcClient', () => ({ subscribeRpcNotifications: api.subscribe }))
const flush = async () => { for (let index = 0; index < 32; index += 1) await Promise.resolve() }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const history = { messages: [], inProgress: false, activeTurnId: '', turnIndexByTurnId: {}, hasMoreOlder: false }
const account = (storageId: string, isActive: boolean) => ({ storageId, accountId: storageId, isActive }) as UiAccountEntry
const snapshot = (active = 'a') => ({ accounts: [account('a', active === 'a'), account('b', active === 'b')] })
const cleanups: (() => void)[] = []
function setup() {
  vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }, setTimeout: vi.fn(), clearTimeout: vi.fn() })
  const desktop = useDesktopState()
  desktop.primeSelectedThread('thread-a')
  const notifications = vi.fn()
  const controller = createAppAccountsController({
    t: text => text, notifyOperation: notifications,
    getSelectedProvider: () => 'codex', getRateLimitSnapshots: () => [],
    workspace: {
      getSelectedThreadId: () => desktop.selectedThreadId.value,
      loadConnections: vi.fn().mockResolvedValue(undefined), invalidateModels: vi.fn(),
      restartPolling: () => { desktop.stopPolling(); desktop.startPolling() },
      refresh: desktop.refreshAll,
    },
  })
  const stop = () => { controller.stop(); desktop.stopPolling() }
  cleanups.push(stop)
  return { desktop, controller, notifications, stop }
}
beforeEach(() => {
  vi.useFakeTimers()
  api.accounts.mockReset().mockResolvedValue(snapshot())
  api.switch.mockReset().mockResolvedValue({ account: account('b', true) })
  api.list.mockReset().mockResolvedValue({ groups: [], nextCursor: null })
  api.history.mockReset().mockResolvedValue(history)
  api.subscribe.mockReset().mockReturnValue(vi.fn())
})
afterEach(() => {
  cleanups.splice(0).forEach(stop => stop())
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('accounts through real desktop refresh and history owners', () => {
  it('switches once and rejects the previous account history completion', async () => {
    const { controller, desktop } = setup()
    await controller.loadAccountsState()
    const waiting = deferred<typeof history>()
    api.history.mockReturnValueOnce(waiting.promise)
    const old = desktop.refreshAll({ includeThreads: false })
    await flush()
    api.accounts.mockResolvedValue(snapshot('b'))
    await controller.onSwitchAccount('b')
    const before = desktop.messages.value
    waiting.resolve({ ...history, messages: [{ id: 'old', role: 'assistant', text: 'old account', turnId: 'old-turn' }] } as typeof history)
    await old
    expect(api.switch).toHaveBeenCalledExactlyOnceWith('b', 'a', 'thread-a')
    expect(controller.activeAccount.value?.storageId).toBe('b')
    expect(desktop.messages.value).toEqual(before)
    expect(api.list).toHaveBeenCalledOnce()
  })

  it('does not admit desktop refresh or subscriptions after a pending switch is disposed', async () => {
    const { controller, stop, notifications } = setup()
    await controller.loadAccountsState()
    const waiting = deferred<{ account: UiAccountEntry }>()
    api.switch.mockReturnValueOnce(waiting.promise)
    const switching = controller.onSwitchAccount('b')
    stop()
    waiting.resolve({ account: account('b', true) })
    await switching
    expect(api.list).not.toHaveBeenCalled()
    expect(api.history).not.toHaveBeenCalled()
    expect(api.subscribe).not.toHaveBeenCalled()
    expect(notifications).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
