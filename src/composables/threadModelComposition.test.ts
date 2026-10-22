import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeModelCapability, type ModelCapability } from '../modelCapabilities'
import { WEB_CONVERSATION_PREFERENCES_KEY } from '../webConversationPreferences'
import { useDesktopState } from './useDesktopState'

const api = vi.hoisted(() => ({
  config: vi.fn(), models: vi.fn(), invalidate: vi.fn(),
  queue: vi.fn(), receipts: vi.fn(), pending: vi.fn(), subscribe: vi.fn(),
}))
vi.mock('../api/threadCommandGateway', () => ({ getCurrentModelConfig: api.config, getAvailableModels: api.models }))
vi.mock('../api/modelCatalog', () => ({ invalidateModelCatalog: api.invalidate }))
vi.mock('../api/accountGateway', () => ({ getAccountRateLimits: vi.fn().mockResolvedValue(null) }))
vi.mock('../api/executionSettingsGateway', () => ({ getAvailableCollaborationModes: vi.fn().mockResolvedValue([{ value: 'default', label: 'Default' }]) }))
vi.mock('../api/skillsGateway', () => ({ getSkillsList: vi.fn().mockResolvedValue([]) }))
vi.mock('../api/threadPreferencesGateway', () => ({ getThreadTitleCache: vi.fn(), generateThreadTitle: vi.fn(), persistThreadTitle: vi.fn() }))
vi.mock('../api/threadReadGateway', () => ({
  invalidateThreadResumeCache: vi.fn(), getThreadGroupsPage: vi.fn(), getBackgroundThreadListLimit: vi.fn(() => 100),
}))
vi.mock('../api/threadQueueGateway', () => ({ getThreadQueueState: api.queue, getDeliveryStatuses: api.receipts }))
vi.mock('../api/runtimeGateway', () => ({ getPendingServerRequests: api.pending }))
vi.mock('../api/codexRpcClient', () => ({ subscribeRpcNotifications: api.subscribe }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const config = (model: string, providerId = 'openai') => ({ model, providerId, reasoningEffort: '', speedMode: '' })
const models = (...ids: string[]) => ids.map(id => normalizeModelCapability(id)!)
const refreshOptions = { includeThreads: false, includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true }

function setup() {
  const storage = new Map<string, string>()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
    },
    setTimeout, clearTimeout,
  })
  const state = useDesktopState()
  state.primeSelectedThread('current')
  return { state, storage, refresh: () => state.refreshAll(refreshOptions) }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  api.config.mockResolvedValue(config('current-model'))
  api.models.mockResolvedValue(models('current-model'))
  api.queue.mockResolvedValue({})
  api.receipts.mockResolvedValue([])
  api.pending.mockResolvedValue([])
  api.subscribe.mockReturnValue(vi.fn())
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('desktop model lifecycle composition', () => {
  it.each(['config', 'catalog'])('coordinates route selection with scheduled ancillary refresh during %s', async phase => {
    const test = setup()
    test.state.primeSelectedThread('')
    const pendingConfig = deferred<ReturnType<typeof config>>()
    const pendingModels = deferred<ModelCapability[]>()
    if (phase === 'config') api.config.mockReturnValueOnce(pendingConfig.promise)
    else api.models.mockReturnValueOnce(pendingModels.promise)
    const selection = test.state.selectThread('')
    await vi.waitFor(() => expect(phase === 'config' ? api.config : api.models).toHaveBeenCalledOnce())
    await test.state.refreshAll({ ...refreshOptions, awaitAncillaryRefreshes: false })
    await vi.advanceTimersByTimeAsync(1)
    expect(api.config).toHaveBeenCalledOnce()
    if (phase === 'config') pendingConfig.resolve(config('current-model'))
    else pendingModels.resolve(models('current-model'))
    expect(await selection).toBe('ok')
    expect(api.models).toHaveBeenCalledOnce()
    expect(test.state.selectedModelId.value).toBe('current-model')
    test.state.stopPolling()
  })

  it.each(['config', 'catalog'].flatMap(phase => ['stop', 'account', 'selection'].flatMap(transition => ['success', 'failure'].map(outcome => ({ phase, transition, outcome })))))
    ('rejects old $phase $outcome after $transition', async ({ phase, transition, outcome }) => {
      const test = setup()
      const oldConfig = deferred<ReturnType<typeof config>>()
      const oldModels = deferred<ModelCapability[]>()
      if (phase === 'config') api.config.mockReturnValueOnce(oldConfig.promise)
      else api.models.mockReturnValueOnce(oldModels.promise)
      const oldRead = test.refresh()
      await vi.waitFor(() => expect(phase === 'config' ? api.config : api.models).toHaveBeenCalledOnce())
      if (transition === 'stop') {
        test.state.stopPolling()
        test.state.startPolling()
      } else if (transition === 'selection') {
        test.state.primeSelectedThread('other')
      }
      await test.state.refreshAll({ ...refreshOptions, accountChanged: transition === 'account' })
      const catalogCalls = api.models.mock.calls.length
      const stored = test.storage.get('codex-web-local.selected-model-by-context.v1')
      if (outcome === 'failure') (phase === 'config' ? oldConfig : oldModels).reject(new Error('Codex CLI is not available'))
      else if (phase === 'config') oldConfig.resolve(config('old-model', 'openrouter'))
      else oldModels.resolve(models('old-model'))
      await oldRead
      expect(test.state.availableModelIds.value).toEqual(['current-model'])
      expect(test.state.selectedModelId.value).toBe('current-model')
      expect(test.state.modelCatalogError.value).toBe('')
      expect(test.state.codexCliMissingError.value).toBe('')
      expect(api.models).toHaveBeenCalledTimes(catalogCalls)
      expect(test.storage.get('codex-web-local.selected-model-by-context.v1')).toBe(stored)
      const configCalls = api.config.mock.calls.length
      await vi.advanceTimersByTimeAsync(3000)
      expect(api.config).toHaveBeenCalledTimes(configCalls)
      test.state.stopPolling()
    })

  it('does no model IO after stop, then starts a new lifecycle immediately', async () => {
    const test = setup()
    test.state.stopPolling()
    await test.refresh()
    expect(api.config).not.toHaveBeenCalled()
    expect(api.models).not.toHaveBeenCalled()
    test.state.startPolling()
    await test.refresh()
    expect(api.config).toHaveBeenCalledOnce()
    expect(api.models).toHaveBeenCalledExactlyOnceWith({ accountScoped: true, includeProviderModels: false, requireProviderModels: false, providerId: undefined })
    test.state.stopPolling()
  })

  it('retries a current failure once at 3000ms and does not loop on a second failure', async () => {
    const test = setup()
    api.config.mockRejectedValue(new Error('offline'))
    await test.refresh()
    expect(test.state.modelCatalogError.value).toBeTruthy()
    await vi.advanceTimersByTimeAsync(2999)
    expect(api.config).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(api.config).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(api.config).toHaveBeenCalledTimes(2)
    test.state.stopPolling()
  })

  it.each(['stop', 'selection', 'fresh-read'])('does not run the old scheduled retry after %s', async transition => {
    const test = setup()
    api.config.mockRejectedValueOnce(new Error('offline'))
    await test.refresh()
    if (transition === 'stop') test.state.stopPolling()
    else if (transition === 'selection') test.state.primeSelectedThread('other')
    else await test.refresh()
    const count = api.config.mock.calls.length
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.config).toHaveBeenCalledTimes(count)
    test.state.stopPolling()
  })

  it('keeps remembered Codex model intent through a temporary account catalog fallback', async () => {
    const test = setup()
    test.state.setSelectedModelId('gpt-6-astra')
    api.config.mockResolvedValue(config('gpt-5.6-sol'))
    api.models.mockResolvedValue(models('gpt-5.6-sol', 'gpt-5.6-luna'))
    await test.refresh()
    expect(test.state.selectedModelId.value).toBe('gpt-5.6-sol')
    expect(JSON.parse(test.storage.get(WEB_CONVERSATION_PREFERENCES_KEY)!).threads.current.saved.model).toBe('gpt-6-astra')
    api.models.mockResolvedValue(models('gpt-6-astra', 'gpt-5.6-sol'))
    await test.state.refreshAll({ ...refreshOptions, accountChanged: true })
    expect(test.state.selectedModelId.value).toBe('gpt-6-astra')
    test.state.stopPolling()
  })
})
