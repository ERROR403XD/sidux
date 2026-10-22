import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeModelCapability } from '../modelCapabilities'
import { useDesktopState } from './useDesktopState'

const api = vi.hoisted(() => ({ history: vi.fn(), config: vi.fn(), models: vi.fn(), skills: vi.fn(), subscribe: vi.fn() }))
vi.mock('../api/threadReadGateway', () => ({
  resumeThread: api.history, getThreadDetail: api.history, invalidateThreadResumeCache: vi.fn(),
  getThreadGroupsPage: vi.fn(), getBackgroundThreadListLimit: () => 100,
}))
vi.mock('../api/threadCommandGateway', () => ({
  getCurrentModelConfig: api.config,
  getAvailableModels: api.models,
}))
vi.mock('../api/skillsGateway', () => ({ getSkillsList: api.skills }))
vi.mock('../api/accountGateway', () => ({ getAccountRateLimits: vi.fn().mockResolvedValue(null) }))
vi.mock('../api/threadPreferencesGateway', () => ({ generateThreadTitle: vi.fn(), getThreadTitleCache: vi.fn(), persistThreadTitle: vi.fn() }))
vi.mock('../api/threadQueueGateway', () => ({ getThreadQueueState: vi.fn().mockResolvedValue({}), getDeliveryStatuses: vi.fn().mockResolvedValue([]) }))
vi.mock('../api/runtimeGateway', () => ({ getPendingServerRequests: vi.fn().mockResolvedValue([]) }))
vi.mock('../api/codexRpcClient', () => ({ subscribeRpcNotifications: api.subscribe }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const snapshot = () => ({ messages: [], inProgress: false, activeTurnId: '', turnIndexByTurnId: {}, hasMoreOlder: false })
const config = () => ({ model: 'gpt-5.4-mini', providerId: 'openai', reasoningEffort: '', speedMode: '' })
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve() }

function setup() {
  vi.stubGlobal('window', {
    localStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() },
    setTimeout: vi.fn(), clearTimeout: vi.fn(),
  })
  api.subscribe.mockReturnValue(vi.fn())
  return useDesktopState()
}

beforeEach(() => {
  vi.clearAllMocks()
  api.history.mockReset().mockResolvedValue(snapshot())
  api.config.mockReset().mockResolvedValue(config())
  api.models.mockReset().mockResolvedValue([normalizeModelCapability('gpt-5.4-mini')!])
  api.skills.mockReset().mockResolvedValue([])
})
afterEach(() => { vi.unstubAllGlobals() })

describe('complete selection operation through the real desktop owners', () => {
  it.each(['history', 'model'].flatMap(phase => ['restart', 'account', 'selection', 'round-trip'].map(transition => ({ phase, transition }))))
    ('rejects the old $phase continuation after $transition', async ({ phase, transition }) => {
      const state = setup()
      const history = deferred<ReturnType<typeof snapshot>>()
      const model = deferred<ReturnType<typeof config>>()
      if (phase === 'history') api.history.mockReturnValueOnce(history.promise)
      else api.config.mockReturnValueOnce(model.promise)
      const old = state.selectThread('a')
      await flush()
      expect(phase === 'history' ? api.history : api.config).toHaveBeenCalledOnce()
      if (transition === 'restart') {
        state.stopPolling()
        state.startPolling()
      } else if (transition === 'account') {
        await state.refreshAll({ accountChanged: true, includeThreads: false, includeSelectedThreadMessages: false })
      } else {
        state.primeSelectedThread('b')
        if (transition === 'round-trip') state.primeSelectedThread('a')
      }
      const configReads = api.config.mock.calls.length
      const catalogReads = api.models.mock.calls.length
      const skillReads = api.skills.mock.calls.length
      if (phase === 'history') history.resolve(snapshot())
      else model.resolve(config())
      expect.soft(await old).toBe('error')
      expect.soft(api.config).toHaveBeenCalledTimes(configReads)
      expect.soft(api.models).toHaveBeenCalledTimes(catalogReads)
      expect.soft(api.skills).toHaveBeenCalledTimes(skillReads)
      expect(state.error.value).toBe('')
      state.stopPolling()
    })

  it('keeps the current successful selection result and follow-up reads', async () => {
    const state = setup()
    expect(await state.selectThread('a')).toBe('ok')
    expect(api.config).toHaveBeenCalledOnce()
    expect(api.skills).toHaveBeenCalledOnce()
    expect(state.selectedThreadId.value).toBe('a')
    state.stopPolling()
  })

  it('keeps a current missing-thread error classification', async () => {
    const state = setup()
    api.history.mockRejectedValue(new Error('thread not found'))
    expect(await state.selectThread('a')).toBe('not-found')
    expect(state.error.value).toBe('thread not found')
    expect(api.config).not.toHaveBeenCalled()
    expect(api.skills).not.toHaveBeenCalled()
    state.stopPolling()
  })

  it('refuses a selection while stopped without changing the selected ID or doing IO', async () => {
    const state = setup()
    state.primeSelectedThread('a')
    state.stopPolling()
    expect.soft(await state.selectThread('b')).toBe('error')
    expect.soft(state.selectedThreadId.value).toBe('a')
    expect.soft(api.history).not.toHaveBeenCalled()
    expect(api.config).not.toHaveBeenCalled()
    expect(api.skills).not.toHaveBeenCalled()
  })

  it('lets a newer same-thread selection reuse history and own the follow-up', async () => {
    const state = setup()
    const history = deferred<ReturnType<typeof snapshot>>()
    api.history.mockReturnValueOnce(history.promise)
    const old = state.selectThread('a')
    const current = state.selectThread('a')
    history.resolve(snapshot())
    expect.soft(await old).toBe('error')
    expect(await current).toBe('ok')
    expect(api.history).toHaveBeenCalledOnce()
    expect.soft(api.config).toHaveBeenCalledOnce()
    state.stopPolling()
  })
})
