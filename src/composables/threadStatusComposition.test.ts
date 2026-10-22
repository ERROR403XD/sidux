import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDesktopState } from './useDesktopState'
import type { UiMessage } from '../types/codex'

const api = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn(), subscribe: vi.fn() }))
vi.mock('../api/threadReadGateway', () => ({
  getThreadGroupsPage: api.list, getThreadDetail: api.detail, resumeThread: api.detail,
  getBackgroundThreadListLimit: () => 100,
}))
vi.mock('../api/projectGateway', () => ({ getWorkspaceRootsState: vi.fn().mockRejectedValue(new Error('isolated')) }))
vi.mock('../api/threadPreferencesGateway', () => ({ getThreadTitleCache: vi.fn().mockResolvedValue({ titles: {} }), persistThreadTitle: vi.fn() }))
vi.mock('../api/threadQueueGateway', () => ({ getThreadQueueState: vi.fn().mockResolvedValue({}), getDeliveryStatuses: vi.fn().mockResolvedValue([]) }))
vi.mock('../api/runtimeGateway', () => ({ getPendingServerRequests: vi.fn().mockResolvedValue([]) }))
vi.mock('../api/codexRpcClient', () => ({ subscribeRpcNotifications: api.subscribe }))

const page = (running: boolean) => ({ groups: [{ projectName: 'p', threads: [{
  id: 'a', title: 'a', cwd: '/p', projectName: 'p', hasWorktree: false, preview: '', unread: false,
  inProgress: running, createdAtIso: '', updatedAtIso: '',
}] }], nextCursor: null })
const detail = (messages: UiMessage[] = []) => ({ messages, inProgress: false, activeTurnId: '', turnIndexByTurnId: {}, hasMoreOlder: false })
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }

async function setup(running = false) {
  vi.stubGlobal('window', {
    localStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() },
    setTimeout: vi.fn(), clearTimeout: vi.fn(),
  })
  const callbacks: Array<(event: { method: string; params: unknown }) => void> = []
  api.subscribe.mockImplementation(handler => { callbacks.push(handler); return vi.fn() })
  api.list.mockResolvedValue(page(running))
  const state = useDesktopState()
  state.primeSelectedThread('a')
  await state.refreshAll({ includeSelectedThreadMessages: false })
  state.startPolling()
  return {
    state, callbacks,
    notify: (method: string, params: unknown) => callbacks.at(-1)!({ method, params }),
    running: () => state.projectGroups.value[0]?.threads[0]?.inProgress,
  }
}
beforeEach(() => { vi.clearAllMocks(); api.detail.mockReset().mockResolvedValue(detail()) })
afterEach(() => { vi.unstubAllGlobals() })

describe('status transitions through real list, history and realtime owners', () => {
  it.each([false, true])('protects live status against an older list, including a same-value update: %s', async initiallyRunning => {
    const test = await setup(initiallyRunning)
    let resolve!: (value: ReturnType<typeof page>) => void
    api.list.mockReturnValueOnce(new Promise(done => { resolve = done }))
    const pending = test.state.refreshAll({ forceThreadRefresh: true, includeSelectedThreadMessages: false })
    await flush()
    expect(api.list).toHaveBeenCalledTimes(2)
    test.notify('thread/status/changed', { threadId: 'a', status: { type: 'inProgress' } })
    resolve(page(false))
    await pending
    expect(test.running()).toBe(true)
    expect(test.state.selectedLiveOverlay.value?.activityLabel).toBe('Thinking')
    test.state.stopPolling()
  })

  it('keeps a final live failure until the same error is in persisted history', async () => {
    const test = await setup()
    test.notify('turn/completed', { threadId: 'a', turn: { id: 'failed', status: 'failed', error: { message: 'same failure' } } })
    expect(test.state.selectedLiveOverlay.value?.errorText).toBe('same failure')
    api.detail.mockResolvedValueOnce(detail([{ id: 'error', role: 'system', text: 'same failure', messageType: 'turnError' }]))
    await test.state.loadMessages('a')
    expect(test.state.selectedLiveOverlay.value).toBeNull()
    expect(test.state.messages.value.filter(message => message.messageType === 'turnError')).toHaveLength(1)
    test.state.stopPolling()
  })

  it('isolates stale status callbacks after stop/start while accepting the current turn', async () => {
    const test = await setup()
    const old = test.callbacks[0]
    test.notify('turn/started', { threadId: 'a', turn: { id: 'old' } })
    test.state.stopPolling()
    test.state.startPolling()
    old({ method: 'turn/started', params: { threadId: 'a', turn: { id: 'stale' } } })
    expect(test.state.selectedLiveOverlay.value).toBeNull()
    test.notify('turn/started', { threadId: 'a', turn: { id: 'current' } })
    expect(test.state.selectedLiveOverlay.value?.activityLabel).toBe('Thinking')
    expect(api.subscribe).toHaveBeenCalledTimes(2)
    test.state.stopPolling()
  })
})
