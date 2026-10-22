import { computed, ref } from 'vue'
import { effectiveConversationChoice, useWebConversationPreferences, type ConversationChoice } from '../webConversationPreferences'
import { capabilityValue, modelSettingsProblem, type ModelCapability } from '../modelCapabilities'
import { getAvailableModels, getCurrentModelConfig } from '../api/threadCommandGateway'
import { invalidateModelCatalog } from '../api/modelCatalog'
import { CODEX_CLI_MISSING_MESSAGE, isCodexCliMissingError } from '../api/codexErrors'
import { omitKey } from './threadNotificationValues'
import { createConversationPreferenceSync } from './conversationPreferenceSync'
import {
  areStringArraysEqual, cloneStringKeyedRecord, createStringKeyedRecord,
  NEW_THREAD_COLLABORATION_MODE_CONTEXT, NEW_THREAD_PROVIDER_MODEL_CONTEXT_PREFIX,
  omitStringKeyedRecordKey, pruneThreadContextStateMap, pruneThreadStateMap, toThreadContextId,
} from './threadContextState'
import type { ReasoningEffort, SpeedMode } from '../types/codex'

const SELECTED_MODEL_BY_CONTEXT_STORAGE_KEY = 'codex-web-local.selected-model-by-context.v1'
const LEGACY_SELECTED_MODEL_STORAGE_KEY = 'codex-web-local.selected-model-id.v1'
const OPENCODE_ZEN_DEFAULT_MODEL = 'big-pickle'

type ModelRefreshOptions = { providerChanged?: boolean; includeProviderModels?: boolean; retry?: boolean }

function normalizeStoredModelId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeProviderContextId(providerId: string): string {
  const normalized = providerId.trim().toLowerCase().replace(/_/g, '-')
  if (!normalized || normalized === 'openai') return 'codex'
  return normalized
}

function toProviderModelContextId(providerId: string): string {
  const normalizedProviderId = normalizeProviderContextId(providerId)
  if (!normalizedProviderId) return ''
  return `${NEW_THREAD_PROVIDER_MODEL_CONTEXT_PREFIX}${normalizedProviderId}`
}

function loadSelectedModelMap(): Record<string, string> {
  if (typeof window === 'undefined') return createStringKeyedRecord<string>()

  try {
    const raw = window.localStorage.getItem(SELECTED_MODEL_BY_CONTEXT_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return createStringKeyedRecord<string>()

      const next = createStringKeyedRecord<string>()
      for (const [contextId, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof contextId !== 'string' || contextId.length === 0) continue
        const normalizedModelId = normalizeStoredModelId(value)
        if (normalizedModelId) {
          next[contextId] = normalizedModelId
        }
      }
      return next
    }
  } catch {
    // Fall back to the legacy global preference below.
  }

  const legacyModelId = normalizeStoredModelId(window.localStorage.getItem(LEGACY_SELECTED_MODEL_STORAGE_KEY))
  const next = createStringKeyedRecord<string>()
  if (legacyModelId) {
    next[NEW_THREAD_COLLABORATION_MODE_CONTEXT] = legacyModelId
  }
  return next
}

function readSelectedModel(
  state: Record<string, string>,
  threadId: string,
): string {
  const contextId = toThreadContextId(threadId)
  const contextModelId = normalizeStoredModelId(state[contextId])
  if (contextModelId) return contextModelId
  return normalizeStoredModelId(state[NEW_THREAD_COLLABORATION_MODE_CONTEXT])
}

function saveSelectedModelMap(state: Record<string, string>): void {
  if (typeof window === 'undefined') return
  try {
    if (Object.keys(state).length === 0) {
      window.localStorage.removeItem(SELECTED_MODEL_BY_CONTEXT_STORAGE_KEY)
    } else {
      window.localStorage.setItem(SELECTED_MODEL_BY_CONTEXT_STORAGE_KEY, JSON.stringify(state))
    }
    window.localStorage.removeItem(LEGACY_SELECTED_MODEL_STORAGE_KEY)
  } catch {
    // Keep in-memory selection working even if localStorage writes fail.
  }
}

export type ThreadModelControllerOptions = {
  getAccountRevision: () => number
  getSelectedThreadId: () => string
  setPageError: (message: string) => void
  setCliMissingError: (message: string) => void
}

export function createThreadModelController({ getAccountRevision, getSelectedThreadId, setPageError, setCliMissingError }: ThreadModelControllerOptions) {
  const webPreferences = useWebConversationPreferences(typeof window !== 'undefined' ? window.localStorage : undefined, patch => preferenceSync.save(patch))
  const preferenceSync = createConversationPreferenceSync(webPreferences)
  const webPreferenceState = webPreferences.state
  const webPreferenceError = webPreferences.error
  const webDefaultChoice = computed<ConversationChoice>(() => webPreferences.state.value.defaults || {
    model: configuredModelSettings.value.model || readSelectedModel(selectedModelIdByContext.value, ''),
    provider: configuredModelSettings.value.provider || activeProviderId.value,
    effort: configuredModelSettings.value.effort, tier: configuredModelSettings.value.tier,
  })
  const availableModelIds = ref<string[]>([])
  const availableModels = ref<ModelCapability[]>([])
  const modelCatalogError = ref('')
  const reportedModelByThreadId = ref<Record<string, string>>({})
  const reportedModel = computed(() => reportedModelByThreadId.value[getSelectedThreadId()] || '')
  let modelRefreshGeneration = 0
  let selectionRevision = 0
  let modelRetryTimer: ReturnType<typeof setTimeout> | null = null
  let modelRefreshFlight: { promise: Promise<void>; isCurrent: () => boolean; providerChanged: boolean; retry: boolean } | null = null
  const selectedModelIdByContext = ref<Record<string, string>>(loadSelectedModelMap())
  const selectedModelId = ref(readSelectedModel(selectedModelIdByContext.value, getSelectedThreadId()))
  const modelSettingsStorageKey = 'codexapp.model-settings.v1'
  const savedModelSettings = ref<Record<string, { effort: string; tier: string }>>((() => {
    try {
      const value = JSON.parse(window.localStorage.getItem(modelSettingsStorageKey) || '{}')
      return Object.fromEntries(Object.entries(value).flatMap(([key, row]) => row && typeof row === 'object'
        ? [[key, { effort: capabilityValue((row as Record<string, unknown>).effort), tier: capabilityValue((row as Record<string, unknown>).tier) }]] : []))
    } catch { return {} }
  })())
  const configuredModelSettings = ref({ model: '', provider: '', effort: '', tier: '' })
  const modelSettingsKey = computed(() => JSON.stringify([readProviderIdForThread(getSelectedThreadId()), selectedModelId.value]))
  const selectedModelCapability = computed(() => availableModels.value.find(model => model.id === selectedModelId.value))
  const currentModelSettings = computed(() => {
    const session = webPreferences.sessions.value[getSelectedThreadId()]
    const stored = session ? effectiveConversationChoice(session, availableModels.value) : savedModelSettings.value[modelSettingsKey.value]
    const defaults = configuredModelSettings.value
    const matches = defaults.model === selectedModelId.value && defaults.provider === readProviderIdForThread(getSelectedThreadId())
    const settings = stored || (matches ? defaults : { effort: '', tier: '' })
    const tier = settings.tier === 'fast' && selectedModelCapability.value?.serviceTiers?.some(item => item.value === 'priority') ? 'priority' : settings.tier
    return { effort: settings.effort, tier }
  })
  const selectedReasoningEffort = computed({ get: () => currentModelSettings.value.effort, set: (effort: string) => saveCurrentModelSettings({ effort }) })
  const selectedSpeedMode = computed({ get: () => currentModelSettings.value.tier, set: (tier: string) => saveCurrentModelSettings({ tier }) })
  const activeProviderId = ref('')
  const threadModelProviderByThreadId = ref<Record<string, string>>({})
  const isUpdatingSpeedMode = ref(false)
  let modelStopped = false
  let modelLifecycleRevision = 0
  let listeningForFocus = false

  function refreshOnFocus(): void {
    void refreshModelPreferences()
  }

  function initializeWebConversation(threadId: string): void {
    if (!threadId && !webPreferences.state.value.defaults) return
    webPreferences.enter(threadId, webDefaultChoice.value)
    if (!threadId) bindPendingConversationChoiceToActiveProvider()
    const value = webPreferences.sessions.value[threadId]
    if (value?.model) selectedModelId.value = effectiveConversationChoice(value, availableModels.value).model
  }

  function configureWebDefaults(value: ConversationChoice, remember: boolean): void {
    try {
      webPreferences.configure(value, remember)
    } catch { /* The settings page exposes the storage error. */ }
  }

  function saveCurrentModelSettings(patch: Partial<{ effort: string; tier: string }>): void {
    selectionRevision++
    const threadId = getSelectedThreadId()
    const session = webPreferences.sessions.value[threadId]
    const current = session || {
      model: selectedModelId.value,
      provider: readProviderIdForThread(threadId),
      ...currentModelSettings.value,
    }
    if (selectConversationChoice(threadId, { ...current, ...patch })) {
      return
    }
    saveLegacyModelSettings(patch)
  }

  function saveLegacyModelSettings(patch: Partial<{ effort: string; tier: string }>): void {
    savedModelSettings.value = { ...savedModelSettings.value, [modelSettingsKey.value]: { ...currentModelSettings.value, ...patch } }
    // Bound preferences without pruning the selected entry.
    const entries = Object.entries(savedModelSettings.value)
    if (entries.length > 200) savedModelSettings.value = Object.fromEntries(entries.slice(-200))
    try { window.localStorage.setItem(modelSettingsStorageKey, JSON.stringify(savedModelSettings.value)) } catch { /* In-memory choices remain usable. */ }
  }

  // A manual composer choice opts an existing conversation into complete preference memory.
  // Merely reading history or projecting a catalog fallback must never register it.
  function selectConversationChoice(threadId: string, value: ConversationChoice): boolean {
    const session = webPreferences.sessions.value[threadId]
    if (!session) {
      if (!threadId || !value.model) return false
      const previousModel = readModelIdForThread(threadId) || value.model
      const provider = readProviderIdForThread(threadId)
      const previousSettings = threadId === getSelectedThreadId()
        ? currentModelSettings.value
        : savedModelSettings.value[JSON.stringify([provider, previousModel])] || { effort: '', tier: '' }
      const previous = { model: previousModel, provider, ...previousSettings }
      webPreferences.register(threadId, webPreferences.state.value.remember ? value : previous)
      if (!webPreferences.state.value.remember) webPreferences.select(threadId, value)
    } else {
      webPreferences.select(threadId, value)
    }
    return true
  }

  function checkedModelSettings(modelId: string, hasImages = false) {
    const model = availableModels.value.find(item => item.id === modelId)
    const effort = selectedReasoningEffort.value
    const tier = selectedSpeedMode.value
    const session = webPreferences.sessions.value[getSelectedThreadId()]
    if (session) adoptLiveConversationSource(getSelectedThreadId())
    if (session?.model && availableModels.value.length && !model) throw new Error('保存的模型暂不可用，请重新选择模型。')
    const problem = modelSettingsProblem(model, effort, tier, hasImages)
    if (problem) throw new Error(problem)
    return { model: model?.model || modelId, effort: effort || model?.defaultEffort || '', serviceTier: session ? tier || null : tier || model?.defaultServiceTier || null }
  }

  function readModelIdForThread(threadId: string): string {
    const session = webPreferences.sessions.value[threadId === NEW_THREAD_COLLABORATION_MODE_CONTEXT ? '' : threadId]
    if (session) return effectiveConversationChoice(session, availableModels.value).model
    const contextId = toThreadContextId(threadId)
    if (contextId === NEW_THREAD_COLLABORATION_MODE_CONTEXT) {
      const normalizedProviderId = normalizeProviderContextId(activeProviderId.value)
      const providerContextId = toProviderModelContextId(normalizedProviderId)
      const providerModelId = providerContextId
        ? normalizeStoredModelId(selectedModelIdByContext.value[providerContextId])
        : ''
      if (providerModelId) return providerModelId
    }
    const preferred = readSelectedModel(selectedModelIdByContext.value, threadId).trim()
    if (threadId && selectedModelIdByContext.value[threadId] && availableModels.value.length) {
      return effectiveConversationChoice({ model: preferred, provider: readProviderIdForThread(threadId), effort: '', tier: '' }, availableModels.value).model
    }
    return preferred
  }

  function readProviderIdForThread(threadId: string): string {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return normalizeProviderContextId(activeProviderId.value)
    return normalizeProviderContextId(threadModelProviderByThreadId.value[normalizedThreadId] ?? activeProviderId.value)
  }

  // Only the effective source follows the live connection; saved defaults remain user intent.
  function bindPendingConversationChoiceToActiveProvider(): void {
    const session = webPreferences.sessions.value['']
    if (!session || !activeProviderId.value.trim()) return
    const providerId = normalizeProviderContextId(activeProviderId.value)
    if (normalizeProviderContextId(session.provider) === providerId) return
    webPreferences.select('', { ...session, provider: providerId })
  }

  // Resumed conversations use the runtime source while preserving their saved model choice.
  function adoptLiveConversationSource(contextId: string): void {
    const session = webPreferences.sessions.value[contextId]
    if (!session) return
    const providerId = readProviderIdForThread(contextId)
    if (!providerId || normalizeProviderContextId(session.provider) === providerId) return
    webPreferences.bindSource(contextId, providerId)
  }

  function ensureAvailableModelIds(...modelIds: string[]): void {
    const nextModelIds = [...availableModelIds.value]
    for (const modelId of modelIds) {
      const normalizedModelId = modelId.trim()
      if (normalizedModelId && !nextModelIds.includes(normalizedModelId)) {
        nextModelIds.push(normalizedModelId)
      }
    }
    if (!areStringArraysEqual(availableModelIds.value, nextModelIds)) {
      availableModelIds.value = nextModelIds
    }
  }

  function readProviderCompatibleSelectedModel(modelId: string): string {
    const normalizedModelId = modelId.trim()
    if (availableModelIds.value.length === 0) return normalizedModelId
    if (normalizedModelId && availableModelIds.value.includes(normalizedModelId)) return normalizedModelId
    return availableModelIds.value[0] ?? ''
  }

  function setSelectedModelIdForThread(threadId: string, modelId: string): void {
    selectionRevision++
    const normalizedModelId = modelId.trim()
    const webSessionId = threadId === NEW_THREAD_COLLABORATION_MODE_CONTEXT ? '' : threadId
    const session = webPreferences.sessions.value[webSessionId]
    const previousModel = session?.model || readModelIdForThread(threadId)
    const settings = session || (webSessionId === getSelectedThreadId() ? currentModelSettings.value : null)
    const next = {
      model: normalizedModelId,
      provider: readProviderIdForThread(threadId),
      effort: previousModel === normalizedModelId ? settings?.effort || '' : '',
      tier: previousModel === normalizedModelId ? settings?.tier || '' : '',
    }
    if (selectConversationChoice(webSessionId, next)) {
      if (webSessionId === getSelectedThreadId()) selectedModelId.value = normalizedModelId
      return
    }
    applySelectedModelIdForThread(threadId, normalizedModelId)
  }

  function applySelectedModelIdForThread(threadId: string, normalizedModelId: string): void {
    if (configuredModelSettings.value.model && selectedModelId.value && selectedModelId.value !== normalizedModelId && !savedModelSettings.value[modelSettingsKey.value]) saveLegacyModelSettings({})
    const contextId = toThreadContextId(threadId)
    const normalizedProviderId = normalizeProviderContextId(activeProviderId.value)
    const providerContextId =
      contextId === NEW_THREAD_COLLABORATION_MODE_CONTEXT
        ? toProviderModelContextId(normalizedProviderId)
        : ''
    const selectedContextId = providerContextId || contextId
    if (normalizedModelId) {
      const nextModelMap = cloneStringKeyedRecord(selectedModelIdByContext.value)
      nextModelMap[selectedContextId] = normalizedModelId
      if (providerContextId) {
        delete nextModelMap[contextId]
      }
      selectedModelIdByContext.value = nextModelMap
    } else {
      let nextModelMap = omitStringKeyedRecordKey(selectedModelIdByContext.value, selectedContextId)
      if (providerContextId) {
        nextModelMap = omitStringKeyedRecordKey(nextModelMap, contextId)
      }
      selectedModelIdByContext.value = nextModelMap
    }
    if (threadId.trim() === getSelectedThreadId()) {
      selectedModelId.value = readModelIdForThread(getSelectedThreadId())
      ensureAvailableModelIds(selectedModelId.value)
    } else {
      ensureAvailableModelIds(normalizedModelId)
    }
    saveSelectedModelMap(selectedModelIdByContext.value)
  }

  function setSelectedModelId(modelId: string): void {
    setSelectedModelIdForThread(getSelectedThreadId(), modelId)
  }

  function setThreadModelId(threadId: string, modelId: string): void {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return

    const normalizedModelId = modelId.trim()
    if (normalizedModelId) reportedModelByThreadId.value = { ...reportedModelByThreadId.value, [normalizedThreadId]: normalizedModelId }
    if (selectedModelIdByContext.value[normalizedThreadId]) return
    if (normalizedModelId) {
      const nextModelMap = cloneStringKeyedRecord(selectedModelIdByContext.value)
      nextModelMap[normalizedThreadId] = normalizedModelId
      selectedModelIdByContext.value = nextModelMap
    } else {
      selectedModelIdByContext.value = omitStringKeyedRecordKey(selectedModelIdByContext.value, normalizedThreadId)
    }
    ensureAvailableModelIds(normalizedModelId)
    if (getSelectedThreadId() === normalizedThreadId) {
      selectedModelId.value = readModelIdForThread(getSelectedThreadId())
    }
    saveSelectedModelMap(selectedModelIdByContext.value)
  }

  function setThreadModelProviderId(threadId: string, providerId: string): void {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return

    const normalizedProviderId = normalizeProviderContextId(providerId)
    if (normalizedProviderId) {
      threadModelProviderByThreadId.value = {
        ...threadModelProviderByThreadId.value,
        [normalizedThreadId]: normalizedProviderId,
      }
    } else if (threadModelProviderByThreadId.value[normalizedThreadId]) {
      threadModelProviderByThreadId.value = omitKey(threadModelProviderByThreadId.value, normalizedThreadId)
    }
  }

  function resolveThreadModelForProvider(threadId: string, modelId: string, providerId: string): string {
    const normalizedModelId = modelId.trim()
    const normalizedProviderId = normalizeProviderContextId(providerId)
    if (normalizedProviderId !== 'opencode-zen') {
      return normalizedModelId
    }

    const previousThreadModel = readModelIdForThread(threadId).trim()
    if (previousThreadModel && !/^gpt-/i.test(previousThreadModel)) {
      return previousThreadModel
    }
    if (normalizedModelId && !/^gpt-/i.test(normalizedModelId)) {
      return normalizedModelId
    }
    return OPENCODE_ZEN_DEFAULT_MODEL
  }

  function setSelectedReasoningEffort(effort: ReasoningEffort | ''): void {
    if (effort && !capabilityValue(effort)) {
      return
    }
    selectedReasoningEffort.value = effort
  }

  async function updateSelectedSpeedMode(mode: SpeedMode): Promise<void> {
    const nextMode = capabilityValue(mode)
    if (isUpdatingSpeedMode.value || selectedSpeedMode.value === nextMode) {
      return
    }

    const problem = modelSettingsProblem(selectedModelCapability.value, selectedReasoningEffort.value, nextMode)
    if (problem) { setPageError(problem); return }
    try {
      selectedSpeedMode.value = nextMode
      setPageError('')
    } catch (cause) { setPageError(cause instanceof Error ? cause.message : 'Fast 设置保存失败') }

  }

  async function refreshModelPreferences(options: ModelRefreshOptions = {}): Promise<void> {
    const isContextCurrent = captureModelContext()
    if (!isContextCurrent()) return
    // The bound provider determines catalog scope; includeProviderModels is a compatibility hint.
    // Explicit provider changes must observe fresh config even if a prior change is still loading.
    if (!options.providerChanged && modelRefreshFlight?.isCurrent()
      && !modelRefreshFlight.providerChanged && modelRefreshFlight.retry === (options.retry === true)) {
      await modelRefreshFlight.promise
      return
    }
    if (modelRetryTimer) clearTimeout(modelRetryTimer)
    modelRetryTimer = null
    const generation = ++modelRefreshGeneration
    const threadContext = getSelectedThreadId()
    const isCurrent = () => isContextCurrent() && generation === modelRefreshGeneration && threadContext === getSelectedThreadId()
    const request = { promise: Promise.resolve(), isCurrent, providerChanged: options.providerChanged === true, retry: options.retry === true }
    modelRefreshFlight = request
    request.promise = runModelRefresh(options, generation, threadContext, isCurrent).finally(() => {
      if (modelRefreshFlight === request) modelRefreshFlight = null
    })
    await request.promise
  }

  async function runModelRefresh(options: ModelRefreshOptions, generation: number, threadContext: string, isCurrent: () => boolean): Promise<void> {
    const startedSelectionRevision = selectionRevision
    if (options?.providerChanged) {
      invalidateModelCatalog()
      availableModels.value = []
      availableModelIds.value = []
    }
    setCliMissingError('')
    try {
      const currentConfig = await getCurrentModelConfig()
      if (!isCurrent()) return
      const previousPreferences = webPreferences.state.value
      const preferenceChanged = await preferenceSync.refresh(threadContext, isCurrent)
      if (!isCurrent()) return
      const preferences = webPreferences.state.value
      const savedChoiceChanged = preferences.remember && JSON.stringify(previousPreferences.threads[threadContext]) !== JSON.stringify(preferences.threads[threadContext])
      if (preferenceChanged && startedSelectionRevision === selectionRevision
        && (!webPreferences.sessions.value[threadContext] || savedChoiceChanged)) initializeWebConversation(threadContext)
      const normalizedConfiguredModelId = currentConfig.model.trim()
      const normalizedProviderId = normalizeProviderContextId(currentConfig.providerId)
      activeProviderId.value = normalizedProviderId
      // Rebind before the catalog request so a failed or slow catalog cannot leave the pending
      // conversation reporting another connection's model source.
      if (!getSelectedThreadId()) bindPendingConversationChoiceToActiveProvider()
      else adoptLiveConversationSource(getSelectedThreadId())
      // A disconnected custom source has no independently addressable catalog.
      // After returning to OAI, read its account catalog without rewriting rollout provenance.
      const threadProviderId = readProviderIdForThread(getSelectedThreadId())
      const targetProviderId = normalizedProviderId === 'codex'
        && (threadProviderId === 'custom' || threadProviderId.startsWith('custom-'))
        ? normalizedProviderId : threadProviderId
      availableModels.value = availableModels.value.filter(model => model.providerId === targetProviderId)
      availableModelIds.value = availableModels.value.map(model => model.id)
      const isProviderBacked = targetProviderId !== 'codex'
      const models = await getAvailableModels({
        ...(!isProviderBacked ? { accountScoped: true } : {}),
        includeProviderModels: isProviderBacked,
        requireProviderModels: isProviderBacked,
        providerId: isProviderBacked ? targetProviderId : undefined,
      })
      if (!isCurrent()) return
      const normalizedSelectedModelId = readModelIdForThread(getSelectedThreadId())
      availableModels.value = models
      modelCatalogError.value = ''
      const modelIds = models.map(model => model.id)
      const providerModelContextId = toProviderModelContextId(targetProviderId)
      const providerScopedModelId = providerModelContextId
        ? normalizeStoredModelId(selectedModelIdByContext.value[providerModelContextId])
        : ''
      const nextModelIds = [...modelIds]
      if (
        !options?.providerChanged
        && isProviderBacked
        && targetProviderId === normalizedProviderId
        && normalizedConfiguredModelId
        && !nextModelIds.includes(normalizedConfiguredModelId)
      ) {
        nextModelIds.push(normalizedConfiguredModelId)
      }
      availableModelIds.value = nextModelIds

      configuredModelSettings.value = { model: normalizedConfiguredModelId, provider: normalizedProviderId, effort: currentConfig.reasoningEffort, tier: currentConfig.speedMode }
      if (!webPreferences.sessions.value[getSelectedThreadId()]) initializeWebConversation(getSelectedThreadId())
      const webSession = webPreferences.sessions.value[getSelectedThreadId()]
      if (webSession?.model) {
        selectedModelId.value = effectiveConversationChoice(webSession, models).model
        return
      }
      const rememberedModel = selectedModelIdByContext.value[getSelectedThreadId()]
      if (getSelectedThreadId() && rememberedModel && targetProviderId === 'codex') {
        // Catalog fallback is effective state, never a new user preference.
        selectedModelId.value = effectiveConversationChoice({ model: rememberedModel, provider: targetProviderId, effort: '', tier: '' }, models).model
        return
      }
      const currentModelInNewList = normalizedSelectedModelId && modelIds.includes(normalizedSelectedModelId)
      if (!normalizedSelectedModelId || !currentModelInNewList || (options?.providerChanged && startedSelectionRevision === selectionRevision)) {
        if (options?.providerChanged && nextModelIds.length > 0) {
          if (providerScopedModelId && modelIds.includes(providerScopedModelId)) {
            applySelectedModelIdForThread(getSelectedThreadId(), providerScopedModelId)
          } else if (targetProviderId === normalizedProviderId && normalizedConfiguredModelId && nextModelIds.includes(normalizedConfiguredModelId)) {
            applySelectedModelIdForThread(getSelectedThreadId(), normalizedConfiguredModelId)
          } else {
            applySelectedModelIdForThread(getSelectedThreadId(), nextModelIds[0])
          }
        } else if (targetProviderId === normalizedProviderId && normalizedConfiguredModelId && nextModelIds.includes(normalizedConfiguredModelId)) {
          applySelectedModelIdForThread(getSelectedThreadId(), currentConfig.model)
        } else if (nextModelIds.length > 0) {
          applySelectedModelIdForThread(getSelectedThreadId(), nextModelIds[0])
        } else {
          applySelectedModelIdForThread(getSelectedThreadId(), '')
        }
      } else if (selectedModelId.value.trim() !== normalizedSelectedModelId) {
        applySelectedModelIdForThread(getSelectedThreadId(), normalizedSelectedModelId)
      }
      if (providerModelContextId && selectedModelId.value.trim().length > 0) {
        const nextModelMap = cloneStringKeyedRecord(selectedModelIdByContext.value)
        nextModelMap[providerModelContextId] = selectedModelId.value.trim()
        const activeProviderModelContextId = toProviderModelContextId(normalizedProviderId)
        if (
          activeProviderModelContextId
          && activeProviderModelContextId !== providerModelContextId
          && normalizedConfiguredModelId
        ) {
          nextModelMap[activeProviderModelContextId] = normalizedConfiguredModelId
        }
        selectedModelIdByContext.value = nextModelMap
        saveSelectedModelMap(selectedModelIdByContext.value)
      }

      configuredModelSettings.value = { model: normalizedConfiguredModelId, provider: normalizedProviderId, effort: currentConfig.reasoningEffort, tier: currentConfig.speedMode }

    } catch (unknownError) {
      if (!isCurrent()) return
      if (isCodexCliMissingError(unknownError)) {
        setCliMissingError(CODEX_CLI_MISSING_MESSAGE)
      } else {
        setCliMissingError('')
      }
      if (generation === modelRefreshGeneration) modelCatalogError.value = '模型目录暂时不可用'
      if (!options?.retry && generation === modelRefreshGeneration) {
        modelRetryTimer = setTimeout(() => {
          if (!isCurrent()) return
          modelRetryTimer = null
          if (generation === modelRefreshGeneration && threadContext === getSelectedThreadId()) {
            void refreshModelPreferences({ ...options, retry: true })
          }
        }, 3000)
      }
      // Keep chat UI usable even if model metadata is temporarily unavailable.
    }
  }

  function captureModelContext(): () => boolean {
    const accountRevision = getAccountRevision()
    const lifecycleRevision = modelLifecycleRevision
    return () => !modelStopped && accountRevision === getAccountRevision() && lifecycleRevision === modelLifecycleRevision
  }

  function projectSelectedThread(threadId: string): void {
    modelRefreshGeneration++
    modelRefreshFlight = null
    clearRetry()
    selectedModelId.value = readProviderCompatibleSelectedModel(readModelIdForThread(threadId))
    initializeWebConversation(threadId)
  }

  function prunePreferences(threadIds: Set<string>): void {
    const nextSelectedModelMap = pruneThreadContextStateMap(selectedModelIdByContext.value, threadIds)
    if (nextSelectedModelMap !== selectedModelIdByContext.value) {
      selectedModelIdByContext.value = nextSelectedModelMap
      selectedModelId.value = readProviderCompatibleSelectedModel(readModelIdForThread(getSelectedThreadId()))
      saveSelectedModelMap(nextSelectedModelMap)
    }
  }

  function pruneThreadMetadata(threadIds: Set<string>): void {
    reportedModelByThreadId.value = pruneThreadStateMap(reportedModelByThreadId.value, threadIds)
    threadModelProviderByThreadId.value = pruneThreadStateMap(threadModelProviderByThreadId.value, threadIds)
  }

  function clearRetry(): void {
    if (modelRetryTimer) clearTimeout(modelRetryTimer)
    modelRetryTimer = null
  }

  function stop(): void {
    modelStopped = true
    modelLifecycleRevision++
    clearRetry()
    modelRefreshGeneration++
    modelRefreshFlight = null
    invalidateModelCatalog()
    availableModels.value = []
    availableModelIds.value = []
    if (listeningForFocus) window.removeEventListener?.('focus', refreshOnFocus)
    listeningForFocus = false
  }

  return {
    readConversationChoice: (threadId: string) => {
      if (threadId === getSelectedThreadId() && availableModels.value.length) {
        const settings = checkedModelSettings(readModelIdForThread(threadId))
        return { model: settings.model, effort: settings.effort, tier: settings.serviceTier || '' }
      }
      const session = webPreferences.sessions.value[threadId] || webPreferences.state.value.threads[threadId]?.saved
      if (session) return { model: session.model, effort: session.effort, tier: session.tier }
      const model = selectedModelIdByContext.value[threadId] || reportedModelByThreadId.value[threadId]
      if (!model) return undefined
      const provider = readProviderIdForThread(threadId)
      const settings = savedModelSettings.value[JSON.stringify([provider, model])]
        || (configuredModelSettings.value.model === model && configuredModelSettings.value.provider === provider ? configuredModelSettings.value : null)
      // Let the server recover the last turn context when no effort has been selected locally.
      return settings ? { model, effort: settings.effort, tier: settings.tier } : undefined
    },
    webPreferenceState: computed(() => webPreferenceState.value),
    webPreferenceError: computed(() => webPreferenceError.value),
    webDefaultChoice,
    webDefaultsProvider: computed(() => readProviderIdForThread(getSelectedThreadId())),
    availableModelIds: computed(() => availableModelIds.value),
    availableModels: computed(() => availableModels.value),
    modelCatalogError: computed(() => modelCatalogError.value),
    reportedModel,
    selectedModelId: computed(() => selectedModelId.value),
    selectedReasoningEffort,
    selectedSpeedMode,
    isUpdatingSpeedMode: computed(() => isUpdatingSpeedMode.value),
    initializeWebConversation, configureWebDefaults, refreshModelPreferences,
    readModelIdForThread, readProviderIdForThread, resolveThreadModelForProvider,
    setSelectedModelIdForThread, setSelectedModelId, setThreadModelId, setThreadModelProviderId,
    setSelectedReasoningEffort, updateSelectedSpeedMode, checkedModelSettings, saveCurrentModelSettings,
    projectSelectedThread, prunePreferences, pruneThreadMetadata,
    getActiveProviderId: () => activeProviderId.value,
    getCatalog: () => availableModels.value as readonly ModelCapability[],
    replaceCatalog: (models: ModelCapability[]) => { availableModels.value = models },
    ensureAvailableModelIds,
    setModelProjection: (model: string) => { selectedModelId.value = model },
    setReportedModel: (threadId: string, model: string) => {
      reportedModelByThreadId.value = { ...reportedModelByThreadId.value, [threadId]: model }
    },
    getNewThreadChoice: () => webPreferences.sessions.value[''],
    registerWebConversation: webPreferences.register,
    invalidateCatalog: invalidateModelCatalog,
    resetCatalog: () => {
      invalidateModelCatalog()
      availableModels.value = []
      availableModelIds.value = []
    },
    invalidateForAccountChange: () => {
      modelRefreshGeneration++
      modelRefreshFlight = null
      clearRetry()
      availableModels.value = []
      availableModelIds.value = []
    },
    start: () => {
      modelStopped = false
      if (!listeningForFocus && typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('focus', refreshOnFocus)
        listeningForFocus = true
      }
    },
    stop,
  }
}
