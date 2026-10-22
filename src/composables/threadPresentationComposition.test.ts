import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDesktopState } from './useDesktopState'
import type { RpcNotification } from '../api/codexRpcClient'

const api = vi.hoisted(() => ({ history: vi.fn(), subscribe: vi.fn() }))
vi.mock('../api/threadReadGateway', () => ({
  getThreadDetail: api.history, resumeThread: api.history, invalidateThreadResumeCache: vi.fn(),
  getBackgroundThreadListLimit: () => 100,
  getThreadGroupsPage: vi.fn().mockResolvedValue({ groups: [], nextCursor: null }),
}))
vi.mock('../api/codexRpcClient', async original => ({
  ...await original<typeof import('../api/codexRpcClient')>(), subscribeRpcNotifications: api.subscribe,
}))
vi.mock('../api/runtimeGateway', () => ({ getPendingServerRequests: vi.fn().mockResolvedValue([]) }))
vi.mock('../api/threadQueueGateway', () => ({ getDeliveryStatuses: vi.fn().mockResolvedValue([]) }))
const TOKEN_KEY = 'codex-web-local.thread-token-usage.v1'
const TERMINAL_KEY = 'codex-web-local.thread-terminal-open.v1'
const breakdown = (totalTokens: number) => ({ totalTokens, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 })
const usage = { total: breakdown(50), last: breakdown(30), modelContextWindow: 100 }
const detail = (title: string) => ({
  thread: { id: 'a', title, cwd: '/fixture', projectName: 'fixture', updatedAtIso: '' },
  messages: [], inProgress: false, activeTurnId: '', turnIndexByTurnId: {}, hasMoreOlder: false,
})
const states: ReturnType<typeof useDesktopState>[] = []
function setup(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed))
  const setItem = vi.fn((key: string, value: string) => { values.set(key, value) })
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem, removeItem: (key: string) => { values.delete(key) }, length: 0 }
  vi.stubGlobal('window', {
    localStorage: storage, setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  })
  const state = useDesktopState()
  states.push(state)
  state.primeSelectedThread('a')
  return { state, values, setItem }
}
beforeEach(() => {
  api.history.mockReset().mockResolvedValue(detail('Restored conversation'))
  api.subscribe.mockReset().mockReturnValue(vi.fn())
})
afterEach(() => { states.splice(0).forEach(state => state.stopPolling()); vi.unstubAllGlobals() })

describe('presentation persistence through real desktop owners', () => {
  it('restores normalized usage and terminal preferences and projects the selected conversation', () => {
    const { state } = setup({
      [TOKEN_KEY]: JSON.stringify({ a: { ...usage, last: { totalTokens: '30.8' } }, invalid: { total: [] } }),
      [TERMINAL_KEY]: JSON.stringify({ a: true, invalid: 'true' }),
    })
    expect(state.selectedThreadTokenUsage.value).toMatchObject({ currentContextTokens: 30, remainingContextTokens: 70, remainingContextPercent: 70 })
    expect(state.selectedThreadTerminalOpen.value).toBe(true)
    state.primeSelectedThread('invalid')
    expect(state.selectedThreadTokenUsage.value).toBeNull()
    expect(state.selectedThreadTerminalOpen.value).toBe(false)
  })

  it.each(['{broken', '[]', 'null'])('tolerates malformed persisted state %s', raw => {
    const { state } = setup({ [TOKEN_KEY]: raw, [TERMINAL_KEY]: raw })
    expect(state.selectedThreadTokenUsage.value).toBeNull()
    expect(state.selectedThreadTerminalOpen.value).toBe(false)
  })

  it('persists terminal commands without erasing preferences or token storage on stop', () => {
    const { state, values } = setup({ [TOKEN_KEY]: JSON.stringify({ a: usage }) })
    state.toggleSelectedThreadTerminal()
    state.setThreadTerminalOpen('b', true)
    state.setThreadTerminalOpen('a', false)
    expect(JSON.parse(values.get(TERMINAL_KEY)!)).toEqual({ b: true })
    state.stopPolling()
    expect(state.selectedThreadTokenUsage.value).toBeNull()
    expect(JSON.parse(values.get(TOKEN_KEY)!)).toEqual({ a: usage })
    state.primeSelectedThread('b')
    expect(state.selectedThreadTerminalOpen.value).toBe(true)
  })

  it('persists a realtime usage update once and suppresses unchanged repeated writes', () => {
    const { state, values, setItem } = setup()
    state.startPolling()
    const notify = api.subscribe.mock.calls[0]![0] as (notification: RpcNotification) => void
    const notification = { method: 'thread/tokenUsage/updated', atIso: '', params: { threadId: 'a', tokenUsage: usage } }
    notify(notification)
    notify(notification)
    expect(state.selectedThreadTokenUsage.value?.currentContextTokens).toBe(30)
    expect(setItem.mock.calls.filter(([key]) => key === TOKEN_KEY)).toHaveLength(1)
    expect(JSON.parse(values.get(TOKEN_KEY)!).a.currentContextTokens).toBe(30)
  })

  it('uses a history snapshot for an unlisted conversation, resets it on stop and allows an explicit reread', async () => {
    const { state } = setup()
    expect(state.selectedThread.value).toBeNull()
    await state.loadMessages('a')
    expect(state.selectedThread.value?.title).toBe('Restored conversation')
    state.stopPolling()
    expect(state.selectedThread.value).toBeNull()
    api.history.mockResolvedValue(detail('Explicit reread'))
    await state.loadMessages('a')
    expect(state.selectedThread.value?.title).toBe('Explicit reread')
  })

  it('does not restore a snapshot from a read stopped before its response arrives', async () => {
    const { state } = setup()
    let finish!: (value: ReturnType<typeof detail>) => void
    api.history.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const loading = state.loadMessages('a')
    state.stopPolling()
    finish(detail('Stale conversation'))
    await loading
    expect(state.selectedThread.value).toBeNull()
  })
})
