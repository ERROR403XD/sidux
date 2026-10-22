import { isReadonly, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeModelCapability, type ModelCapability } from '../modelCapabilities'
import { WEB_CONVERSATION_PREFERENCES_KEY, type ConversationChoice } from '../webConversationPreferences'
import { createThreadModelController } from './threadModelController'

const api = vi.hoisted(() => ({ config: vi.fn(), models: vi.fn(), invalidate: vi.fn(), read: vi.fn(), write: vi.fn() }))
vi.mock('../api/threadCommandGateway', () => ({ getCurrentModelConfig: api.config, getAvailableModels: api.models }))
vi.mock('../api/modelCatalog', () => ({ invalidateModelCatalog: api.invalidate }))

vi.mock('../api/threadPreferencesGateway', () => ({ getConversationPreferences: api.read, persistConversationPreferences: api.write }))

const modelKey = 'codex-web-local.selected-model-by-context.v1'
const settingsKey = 'codexapp.model-settings.v1'
const config = (model = 'gpt-6-astra', providerId = 'openai', reasoningEffort = '', speedMode = '') => ({ model, providerId, reasoningEffort, speedMode })
const model = (id: string, provider = 'codex', details = {}) => normalizeModelCapability({ id, ...details }, provider)!
const choice = (model = 'gpt-6-astra', provider = 'codex', effort = '', tier = ''): ConversationChoice => ({ model, provider, effort, tier })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function setup(initial: Record<string, string> = {}, initialThread = 'thread') {
  const storage = new Map(Object.entries(initial))
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => { storage.set(key, value) }),
    removeItem: (key: string) => { storage.delete(key) },
  }
  vi.stubGlobal('window', { localStorage })
  const selected = ref(initialThread)
  let accountRevision = 0
  const setPageError = vi.fn()
  const setCliMissingError = vi.fn()
  const controller = createThreadModelController({
    getAccountRevision: () => accountRevision,
    getSelectedThreadId: () => selected.value,
    setPageError, setCliMissingError,
  })
  return {
    controller, storage, localStorage, selected, setPageError, setCliMissingError,
    switchAccount: () => { accountRevision++; controller.invalidateForAccountChange() },
    select: (id: string) => { selected.value = id; controller.projectSelectedThread(id) },
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  api.read.mockRejectedValue(new Error('offline'))
  api.write.mockResolvedValue(undefined)
  api.config.mockResolvedValue(config())
  api.models.mockResolvedValue([model('gpt-6-astra')])
})
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('complete model and preference resource owner', () => {
  it('restores manually selected model and effort per historical conversation across reload', async () => {
    const test = setup()
    api.models.mockResolvedValue([model('gpt-6-astra'), model('gpt-5.6-sol')])
    await test.controller.refreshModelPreferences()
    test.controller.setSelectedModelId('gpt-6-astra')
    test.controller.setSelectedReasoningEffort('high')
    test.select('other')
    await test.controller.refreshModelPreferences()
    test.controller.setSelectedModelId('gpt-6-astra')
    test.controller.setSelectedReasoningEffort('low')
    test.select('third')
    await test.controller.refreshModelPreferences()
    test.controller.setSelectedModelId('gpt-5.6-sol')
    test.controller.setSelectedReasoningEffort('medium')
    test.select('thread')
    expect(test.controller.selectedModelId.value).toBe('gpt-6-astra')
    expect(test.controller.selectedReasoningEffort.value).toBe('high')
    const reloaded = setup(Object.fromEntries(test.storage))
    await reloaded.controller.refreshModelPreferences()
    expect(reloaded.controller.selectedReasoningEffort.value).toBe('high')
    reloaded.select('other')
    expect(reloaded.controller.selectedReasoningEffort.value).toBe('low')
    reloaded.select('third')
    expect(reloaded.controller.selectedModelId.value).toBe('gpt-5.6-sol')
    expect(reloaded.controller.selectedReasoningEffort.value).toBe('medium')
  })

  it('preserves a manually chosen provider model through a temporary catalog fallback', async () => {
    const test = setup()
    test.controller.setThreadModelProviderId('thread', 'custom')
    api.config.mockResolvedValue(config('custom-a', 'custom'))
    api.models.mockResolvedValue([model('custom-a', 'custom'), model('custom-b', 'custom')])
    await test.controller.refreshModelPreferences()
    expect(test.controller.webPreferenceState.value.threads).toEqual({})
    test.controller.setSelectedModelId('custom-b')
    test.controller.setSelectedReasoningEffort('high')
    api.models.mockResolvedValue([model('custom-a', 'custom')])
    await test.controller.refreshModelPreferences()
    expect(test.controller.selectedModelId.value).toBe('custom-a')
    api.models.mockResolvedValue([model('custom-a', 'custom'), model('custom-b', 'custom')])
    await test.controller.refreshModelPreferences()
    expect(test.controller.selectedModelId.value).toBe('custom-b')
    expect(test.controller.selectedReasoningEffort.value).toBe('high')
  })

  it('keeps the current effort when selecting the same model again', async () => {
    const test = setup()
    await test.controller.refreshModelPreferences()
    test.controller.setSelectedReasoningEffort('high')
    test.controller.setSelectedModelId('gpt-6-astra')
    expect(test.controller.selectedReasoningEffort.value).toBe('high')
  })

  it('captures an effort-only choice without registering conversations during background reads', async () => {
    const test = setup()
    await test.controller.refreshModelPreferences()
    api.config.mockResolvedValue(config('other-model'))
    api.models.mockResolvedValue([model('other-model')])
    await test.controller.refreshModelPreferences()
    expect(test.controller.webPreferenceState.value.threads).toEqual({})
    test.localStorage.setItem.mockClear()
    test.controller.setSelectedReasoningEffort('high')
    expect(test.controller.webPreferenceState.value.threads.thread.saved).toEqual(choice('other-model', 'codex', 'high'))
    expect(test.localStorage.setItem).toHaveBeenCalledOnce()
  })

  it('respects disabled memory on reentry and restores saved intent when reenabled', async () => {
    const saved = choice('gpt-6-astra', 'codex', 'high')
    const defaults = choice('gpt-5.6-sol', 'codex', 'medium')
    const test = setup({ [WEB_CONVERSATION_PREFERENCES_KEY]: JSON.stringify({ defaults, remember: true, threads: { thread: { source: 'web', saved } } }) })
    api.models.mockResolvedValue([model('gpt-6-astra'), model('gpt-5.6-sol')])
    await test.controller.refreshModelPreferences()
    test.controller.configureWebDefaults(defaults, false)
    test.controller.setSelectedModelId('gpt-5.6-sol')
    test.controller.setSelectedReasoningEffort('low')
    expect(test.controller.selectedReasoningEffort.value).toBe('low')
    expect(test.controller.webPreferenceState.value.threads.thread.saved).toEqual(saved)
    test.select('other')
    test.select('thread')
    expect(test.controller.selectedModelId.value).toBe(defaults.model)
    expect(test.controller.selectedReasoningEffort.value).toBe(defaults.effort)
    test.controller.configureWebDefaults(defaults, true)
    test.select('other')
    test.select('thread')
    expect(test.controller.selectedModelId.value).toBe(saved.model)
    expect(test.controller.selectedReasoningEffort.value).toBe(saved.effort)
  })

  it.each(['thread', ''])('keeps a manual choice in context %s while the catalog is loading', async context => {
    const test = setup({}, context)
    const catalog = [model('gpt-6-astra'), model('gpt-5.6-sol')]
    api.models.mockResolvedValue(catalog)
    await test.controller.refreshModelPreferences()
    const pending = deferred<ModelCapability[]>()
    api.models.mockReturnValueOnce(pending.promise)
    const refreshing = test.controller.refreshModelPreferences()
    await vi.waitFor(() => expect(api.models).toHaveBeenCalledTimes(2))
    test.controller.setSelectedModelId('gpt-5.6-sol')
    test.controller.setSelectedReasoningEffort('low')
    pending.resolve(catalog)
    await refreshing
    expect(test.controller.selectedModelId.value).toBe('gpt-5.6-sol')
    expect(test.controller.selectedReasoningEffort.value).toBe('low')
    expect(api.models).toHaveBeenCalledTimes(2)
  })

  it.each(['config', 'catalog'])('removes the previous connection options when the replacement %s fails', async phase => {
    const test = setup({}, '')
    await test.controller.refreshModelPreferences()
    api.config.mockResolvedValue(config('custom-model', 'custom'))
    api.models.mockRejectedValue(new Error('unreachable'))
    if (phase === 'config') api.config.mockRejectedValue(new Error('unreachable'))
    await test.controller.refreshModelPreferences({ providerChanged: true })
    expect(test.controller.availableModels.value).toEqual([])
    expect(test.controller.availableModelIds.value).toEqual([])
    expect(test.controller.modelCatalogError.value).toBeTruthy()
  })

  it('clears the old account catalog even when the replacement config fails', async () => {
    const test = setup()
    await test.controller.refreshModelPreferences()
    test.switchAccount()
    api.config.mockRejectedValue(new Error('offline'))
    await test.controller.refreshModelPreferences()
    expect(test.controller.availableModels.value).toEqual([])
    expect(test.controller.availableModelIds.value).toEqual([])
  })

  it('keeps an active temporary choice when another device changes defaults', async () => {
    const defaults = choice('gpt-6-astra', 'codex', 'high')
    const saved = choice('gpt-6-astra', 'codex', 'medium')
    const state = { defaults, remember: false, threads: { thread: { source: 'web', saved } } }
    const test = setup({ [WEB_CONVERSATION_PREFERENCES_KEY]: JSON.stringify(state) })
    api.read.mockResolvedValue(state)
    api.models.mockResolvedValue([model('gpt-6-astra'), model('gpt-5.6-sol')])
    await test.controller.refreshModelPreferences()
    test.controller.setSelectedModelId('gpt-5.6-sol')
    test.controller.setSelectedReasoningEffort('low')
    api.read.mockResolvedValue({ ...state, defaults: { ...defaults, effort: 'ultra' } })
    await test.controller.refreshModelPreferences()
    expect(test.controller.selectedModelId.value).toBe('gpt-5.6-sol')
    expect(test.controller.selectedReasoningEffort.value).toBe('low')
    test.select('other')
    test.select('thread')
    expect(test.controller.selectedReasoningEffort.value).toBe('ultra')
  })

  it('loads account catalog and runtime defaults, translates Fast to priority and checks send settings', async () => {
    const test = setup()
    api.config.mockResolvedValue(config('gpt-6-astra', 'openai', 'high', 'fast'))
    api.models.mockResolvedValue([model('gpt-6-astra', 'codex', { model: 'wire-model', serviceTiers: [{ id: 'priority' }], supportedReasoningEfforts: [{ reasoningEffort: 'high' }] })])
    await test.controller.refreshModelPreferences()
    expect(api.models).toHaveBeenCalledExactlyOnceWith({ accountScoped: true, includeProviderModels: false, requireProviderModels: false, providerId: undefined })
    expect(test.controller.selectedReasoningEffort.value).toBe('high')
    expect(test.controller.selectedSpeedMode.value).toBe('priority')
    expect(test.controller.checkedModelSettings('gpt-6-astra')).toEqual({ model: 'wire-model', effort: 'high', serviceTier: 'priority' })
  })

  it('restores each provider pending choice when the live provider changes', async () => {
    const test = setup({}, '')
    api.models.mockResolvedValue([model('gpt-6-astra'), model('gpt-5.6-sol')])
    await test.controller.refreshModelPreferences()
    test.controller.setSelectedModelId('gpt-5.6-sol')
    api.config.mockResolvedValue(config('router-a', 'openrouter_free'))
    api.models.mockResolvedValue([model('router-a', 'openrouter-free'), model('router-b', 'openrouter-free')])
    await test.controller.refreshModelPreferences({ providerChanged: true })
    expect(api.models).toHaveBeenLastCalledWith({ includeProviderModels: true, requireProviderModels: true, providerId: 'openrouter-free' })
    test.controller.setSelectedModelId('router-b')
    api.config.mockResolvedValue(config())
    api.models.mockResolvedValue([model('gpt-6-astra'), model('gpt-5.6-sol')])
    await test.controller.refreshModelPreferences({ providerChanged: true })
    expect(test.controller.selectedModelId.value).toBe('gpt-5.6-sol')
    api.config.mockResolvedValue(config('router-a', 'openrouter_free'))
    api.models.mockResolvedValue([model('router-a', 'openrouter-free'), model('router-b', 'openrouter-free')])
    await test.controller.refreshModelPreferences({ providerChanged: true })
    expect(test.controller.selectedModelId.value).toBe('router-b')
    expect(JSON.parse(test.storage.get(modelKey)!)).toEqual({ '__new-thread-provider__::codex': 'gpt-5.6-sol', '__new-thread-provider__::openrouter-free': 'router-b' })
    expect(api.invalidate).toHaveBeenCalledTimes(3)
  })

  it('uses the thread provider for catalog reads without appending a different live provider model', async () => {
    const test = setup()
    test.controller.setThreadModelProviderId('thread', 'custom')
    api.config.mockResolvedValue(config('router-runtime', 'openrouter'))
    api.models.mockResolvedValue([model('thread-model', 'custom')])
    await test.controller.refreshModelPreferences()
    expect(api.models).toHaveBeenCalledExactlyOnceWith({ includeProviderModels: true, requireProviderModels: true, providerId: 'custom' })
    expect(test.controller.availableModelIds.value).toEqual(['thread-model'])
    expect(test.controller.readProviderIdForThread('thread')).toBe('custom')
    expect(test.controller.getActiveProviderId()).toBe('openrouter')
  })

  it('reloads the OAI account catalog after leaving a custom connection and after refresh', async () => {
    const test = setup()
    test.controller.setThreadModelProviderId('thread', 'custom')
    api.config.mockResolvedValue(config('custom-model', 'custom'))
    api.models.mockImplementation(async options => options.accountScoped
      ? [model('gpt-6-astra')] : [model('custom-model', 'custom')])
    await test.controller.refreshModelPreferences()
    expect(test.controller.availableModelIds.value).toEqual(['custom-model'])
    test.switchAccount()
    api.config.mockResolvedValue(config())
    await test.controller.refreshModelPreferences()
    await test.controller.refreshModelPreferences()
    expect(api.models).toHaveBeenLastCalledWith({ accountScoped: true, includeProviderModels: false, requireProviderModels: false, providerId: undefined })
    expect(test.controller.availableModelIds.value).toEqual(['gpt-6-astra'])
    expect(test.controller.selectedModelId.value).toBe('gpt-6-astra')
    expect(test.controller.readProviderIdForThread('thread')).toBe('custom')
  })

  it.each([false, true])('preserves the configured extra provider ID only when providerChanged=%s allows it', async providerChanged => {
    const test = setup({}, '')
    api.config.mockResolvedValue(config('configured', 'openrouter'))
    api.models.mockResolvedValue([model('listed', 'openrouter')])
    await test.controller.refreshModelPreferences({ providerChanged })
    expect(test.controller.availableModelIds.value).toEqual(providerChanged ? ['listed'] : ['listed', 'configured'])
    expect(test.controller.selectedModelId.value).toBe(providerChanged ? 'listed' : 'configured')
  })

  it('rebinds pending web source before a failed catalog and keeps saved defaults intact', async () => {
    const saved = choice('gpt-6-astra', 'codex', 'ultra', 'priority')
    const test = setup({ [WEB_CONVERSATION_PREFERENCES_KEY]: JSON.stringify({ defaults: saved, remember: true, threads: {} }) }, '')
    test.controller.initializeWebConversation('')
    api.config.mockResolvedValue(config('router', 'openrouter'))
    api.models.mockRejectedValue(new Error('offline'))
    await test.controller.refreshModelPreferences({ providerChanged: true })
    expect(test.controller.getNewThreadChoice()?.provider).toBe('openrouter')
    expect(test.controller.webDefaultChoice.value).toEqual(saved)
    expect(test.controller.webPreferenceState.value.defaults).toEqual(saved)
    expect(test.controller.modelCatalogError.value).toBeTruthy()
    test.controller.stop()
  })

  it('falls back web model, effort and tier without persisting them, then restores saved intent', async () => {
    const saved = choice('gpt-6-astra', 'codex', 'ultra', 'priority')
    const test = setup({ [WEB_CONVERSATION_PREFERENCES_KEY]: JSON.stringify({ defaults: null, remember: true, threads: { thread: { source: 'web', saved } } }) })
    const stored = test.storage.get(WEB_CONVERSATION_PREFERENCES_KEY)
    api.models.mockResolvedValue([model('gpt-5.6-sol', 'codex', { supportedReasoningEfforts: [{ reasoningEffort: 'high' }], serviceTiers: [] })])
    await test.controller.refreshModelPreferences()
    expect(test.controller.selectedModelId.value).toBe('gpt-5.6-sol')
    expect(test.controller.selectedReasoningEffort.value).toBe('high')
    expect(test.controller.selectedSpeedMode.value).toBe('')
    expect(test.storage.get(WEB_CONVERSATION_PREFERENCES_KEY)).toBe(stored)
    api.models.mockResolvedValue([model('gpt-6-astra', 'codex', { supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }], serviceTiers: [{ id: 'priority' }] })])
    test.switchAccount()
    await test.controller.refreshModelPreferences()
    expect(test.controller.selectedModelId.value).toBe('gpt-6-astra')
    expect(test.controller.selectedReasoningEffort.value).toBe('ultra')
    expect(test.controller.selectedSpeedMode.value).toBe('priority')
    expect(test.storage.get(WEB_CONVERSATION_PREFERENCES_KEY)).toBe(stored)
  })

  it('keeps saved existing web source while using the bound runtime source for sending', async () => {
    const saved = choice('gpt-6-astra')
    const test = setup({ [WEB_CONVERSATION_PREFERENCES_KEY]: JSON.stringify({ defaults: null, remember: true, threads: { thread: { source: 'web', saved } } }) })
    test.controller.initializeWebConversation('thread')
    test.controller.setThreadModelProviderId('thread', 'openrouter')
    api.config.mockResolvedValue(config('router', 'openrouter'))
    api.models.mockResolvedValue([model('router', 'openrouter')])
    await test.controller.refreshModelPreferences()
    expect(test.controller.checkedModelSettings('router').model).toBe('router')
    expect(test.controller.webPreferenceState.value.threads.thread.saved).toEqual(saved)
    expect(test.controller.readProviderIdForThread('thread')).toBe('openrouter')
  })

  it('isolates effort and tier by provider/model and preserves writable compatibility setters', async () => {
    const test = setup({}, '')
    await test.controller.refreshModelPreferences()
    test.controller.selectedReasoningEffort.value = 'high'
    test.controller.selectedSpeedMode.value = 'priority'
    test.controller.setSelectedModelId('gpt-5.6-sol')
    expect(test.controller.selectedReasoningEffort.value).toBe('')
    test.controller.setSelectedReasoningEffort('medium')
    test.controller.setSelectedModelId('gpt-6-astra')
    expect(test.controller.selectedReasoningEffort.value).toBe('high')
    expect(test.controller.selectedSpeedMode.value).toBe('priority')
    api.config.mockResolvedValue(config('gpt-6-astra', 'custom'))
    api.models.mockResolvedValue([model('gpt-6-astra', 'custom')])
    await test.controller.refreshModelPreferences({ providerChanged: true })
    expect(test.controller.selectedReasoningEffort.value).toBe('')
    expect(JSON.parse(test.storage.get(settingsKey)!)['["codex","gpt-6-astra"]']).toEqual({ effort: 'high', tier: 'priority' })
  })

  it('bounds model settings at 200 and retains the newest selected entry', () => {
    const test = setup({}, '')
    for (let i = 0; i < 205; i++) {
      test.controller.setSelectedModelId(`model-${i}`)
      test.controller.saveCurrentModelSettings({ effort: 'high' })
    }
    const settings = JSON.parse(test.storage.get(settingsKey)!)
    expect(Object.keys(settings)).toHaveLength(200)
    expect(settings['["codex","model-0"]']).toBeUndefined()
    expect(settings['["codex","model-204"]']).toEqual({ effort: 'high', tier: '' })
  })

  it('rejects unsupported tier and image settings before sending', async () => {
    const test = setup()
    api.models.mockResolvedValue([model('gpt-6-astra', 'codex', { serviceTiers: [], inputModalities: ['text'] })])
    await test.controller.refreshModelPreferences()
    await test.controller.updateSelectedSpeedMode('priority')
    expect(test.controller.selectedSpeedMode.value).toBe('')
    expect(test.setPageError).toHaveBeenLastCalledWith(expect.stringContaining('priority'))
    expect(() => test.controller.checkedModelSettings('gpt-6-astra', true)).toThrow('当前模型不支持图片。')
    expect(api.config).toHaveBeenCalledOnce()
    expect(api.models).toHaveBeenCalledOnce()
  })

  it('reports storage errors for web defaults while retaining the old saved choice', () => {
    const test = setup()
    test.localStorage.setItem.mockImplementation(() => { throw new Error('quota') })
    test.controller.configureWebDefaults(choice(), true)
    expect(test.controller.webPreferenceError.value).toBeTruthy()
    expect(test.controller.webPreferenceState.value.defaults).toBeNull()
  })

  it.each(['config', 'catalog'])('shares an overlapping %s refresh through catalog completion', async phase => {
    const test = setup()
    const pendingConfig = deferred<ReturnType<typeof config>>()
    const pendingCatalog = deferred<ModelCapability[]>()
    if (phase === 'config') api.config.mockReturnValueOnce(pendingConfig.promise)
    else api.models.mockReturnValueOnce(pendingCatalog.promise)
    const first = test.controller.refreshModelPreferences({ includeProviderModels: true })
    await Promise.resolve()
    let joinedFinished = false
    const joined = test.controller.refreshModelPreferences({ includeProviderModels: false }).then(() => { joinedFinished = true })
    await Promise.resolve()
    expect(api.config).toHaveBeenCalledOnce()
    expect(joinedFinished).toBe(false)
    if (phase === 'config') pendingConfig.resolve(config())
    else pendingCatalog.resolve([model('gpt-6-astra')])
    await Promise.all([first, joined])
    expect(test.controller.selectedModelId.value).toBe('gpt-6-astra')
    expect(api.models).toHaveBeenCalledOnce()
    expect(joinedFinished).toBe(true)
    await test.controller.refreshModelPreferences()
    expect(api.config).toHaveBeenCalledTimes(2)
    expect(api.models).toHaveBeenCalledTimes(2)
    test.controller.stop()
  })

  it.each(['config', 'catalog'])('starts a forced provider refresh during an older %s read', async phase => {
    const test = setup({}, '')
    const oldConfig = deferred<ReturnType<typeof config>>()
    const oldCatalog = deferred<ModelCapability[]>()
    if (phase === 'config') api.config.mockReturnValueOnce(oldConfig.promise)
    else api.models.mockReturnValueOnce(oldCatalog.promise)
    const old = test.controller.refreshModelPreferences({ providerChanged: true })
    if (phase === 'catalog') await vi.waitFor(() => expect(api.models).toHaveBeenCalledOnce())
    else await Promise.resolve()
    api.config.mockResolvedValue(config('router', 'openrouter'))
    api.models.mockResolvedValue([model('router', 'openrouter')])
    await test.controller.refreshModelPreferences({ providerChanged: true })
    const calls = api.models.mock.calls.length
    if (phase === 'config') oldConfig.resolve(config())
    else oldCatalog.resolve([model('gpt-6-astra')])
    await old
    expect(api.config).toHaveBeenCalledTimes(2)
    expect(api.invalidate).toHaveBeenCalledTimes(2)
    expect(api.models).toHaveBeenCalledTimes(calls)
    expect(test.controller.selectedModelId.value).toBe('router')
    expect(test.controller.getActiveProviderId()).toBe('openrouter')
    test.controller.stop()
  })

  it.each(['success', 'failure'])('keeps a new account flight after the old flight ends with %s', async outcome => {
    const test = setup()
    const oldConfig = deferred<ReturnType<typeof config>>()
    const currentConfig = deferred<ReturnType<typeof config>>()
    api.config.mockReturnValueOnce(oldConfig.promise).mockReturnValueOnce(currentConfig.promise)
    const old = test.controller.refreshModelPreferences()
    test.switchAccount()
    const current = test.controller.refreshModelPreferences()
    if (outcome === 'success') oldConfig.resolve(config('old'))
    else oldConfig.reject(new Error('Codex CLI is not available'))
    await old
    const joined = test.controller.refreshModelPreferences()
    expect(api.config).toHaveBeenCalledTimes(2)
    currentConfig.resolve(config())
    await Promise.all([current, joined])
    expect(api.models).toHaveBeenCalledOnce()
    expect(test.controller.modelCatalogError.value).toBe('')
    expect(test.setCliMissingError).not.toHaveBeenCalledWith(expect.stringContaining('Codex CLI not found'))
    expect(vi.getTimerCount()).toBe(0)
    test.controller.stop()
  })

  it('shares a failure and schedules only one bounded retry for all waiters', async () => {
    const test = setup()
    const pendingConfig = deferred<ReturnType<typeof config>>()
    api.config.mockReturnValueOnce(pendingConfig.promise)
    const first = test.controller.refreshModelPreferences()
    const joined = test.controller.refreshModelPreferences()
    pendingConfig.reject(new Error('offline'))
    await Promise.all([first, joined])
    expect(api.config).toHaveBeenCalledOnce()
    expect(test.controller.modelCatalogError.value).toBeTruthy()
    expect(vi.getTimerCount()).toBe(1)
    api.config.mockRejectedValue(new Error('offline again'))
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.config).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10000)
    expect(api.config).toHaveBeenCalledTimes(2)
    test.controller.stop()
  })

  it('keeps a current retry when an old canceled callback is delivered', async () => {
    const test = setup()
    const schedule = vi.spyOn(globalThis, 'setTimeout')
    api.config.mockRejectedValue(new Error('offline'))
    await test.controller.refreshModelPreferences()
    const oldCallback = schedule.mock.calls[0]![0] as () => void
    await test.controller.refreshModelPreferences()
    expect(vi.getTimerCount()).toBe(1)
    oldCallback()
    expect(api.config).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.config).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('invalidates an old account retry even when no replacement refresh starts', async () => {
    const test = setup()
    api.config.mockRejectedValue(new Error('Codex CLI is not available'))
    await test.controller.refreshModelPreferences()
    expect(test.setCliMissingError).toHaveBeenLastCalledWith(expect.stringContaining('Codex CLI not found'))
    test.switchAccount()
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.config).toHaveBeenCalledOnce()
    test.controller.stop()
  })

  it('does not retain active retry timers across ten stop/start cycles', async () => {
    const test = setup()
    api.config.mockRejectedValue(new Error('offline'))
    for (let i = 0; i < 10; i++) {
      await test.controller.refreshModelPreferences()
      expect(vi.getTimerCount()).toBe(1)
      test.controller.stop()
      expect(vi.getTimerCount()).toBe(0)
      test.controller.start()
    }
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.config).toHaveBeenCalledTimes(10)
    expect(api.models).not.toHaveBeenCalled()
  })

  it('prunes legacy and observed thread metadata while retaining pending provider preferences', async () => {
    const test = setup({ [modelKey]: JSON.stringify({ thread: 'gpt-6-astra', removed: 'old', '__new-thread-provider__::custom': 'custom-model' }) })
    test.controller.setReportedModel('thread', 'reported')
    test.controller.setThreadModelProviderId('removed', 'custom')
    test.controller.prunePreferences(new Set(['thread']))
    test.controller.pruneThreadMetadata(new Set(['thread']))
    expect(JSON.parse(test.storage.get(modelKey)!)).toEqual({ thread: 'gpt-6-astra', '__new-thread-provider__::custom': 'custom-model' })
    expect(test.controller.reportedModel.value).toBe('reported')
    expect(test.controller.readProviderIdForThread('removed')).toBe('codex')
    test.controller.setThreadModelId('thread', 'observed')
    expect(test.controller.readModelIdForThread('thread')).toBe('gpt-6-astra')
    expect(test.controller.reportedModel.value).toBe('observed')
    test.controller.setThreadModelProviderId('thread', 'opencode_zen')
    expect(test.controller.resolveThreadModelForProvider('thread', 'gpt-5.6', 'opencode_zen')).toBe('big-pickle')
    test.controller.setSelectedModelId('zen-model')
    expect(test.controller.resolveThreadModelForProvider('thread', 'gpt-5.6', 'opencode_zen')).toBe('zen-model')
  })

  it('exposes readonly resource projections and keeps mutable maps and request lifecycle private', () => {
    const test = setup()
    for (const value of [test.controller.availableModels, test.controller.availableModelIds, test.controller.modelCatalogError, test.controller.reportedModel, test.controller.selectedModelId, test.controller.isUpdatingSpeedMode, test.controller.webPreferenceState, test.controller.webPreferenceError]) expect(isReadonly(value)).toBe(true)
    for (const name of ['webPreferences', 'savedModelSettings', 'configuredModelSettings', 'selectedModelIdByContext', 'reportedModelByThreadId', 'threadModelProviderByThreadId', 'modelRetryTimer', 'modelRefreshGeneration']) expect(test.controller).not.toHaveProperty(name)
  })
})
