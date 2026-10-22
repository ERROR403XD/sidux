import { join } from 'node:path'
import type { RuntimeQuiescenceSnapshot } from './accountAuthCoordinator.js'
import { hasUsableCodexAuthSync } from './appServerAuth.js'
import { ensureDefaultFreeModeStateForMissingAuthSync } from './appServerRuntimeDependencies.js'
import {
  FREE_MODE_DEFAULT_MODEL,
  FREE_MODE_STATE_FILE,
  OPENCODE_ZEN_DEFAULT_MODEL,
  OPENCODE_ZEN_PROVIDER_ID,
  type FreeModeState,
} from './freeMode.js'
import { writeFreeModeStateFile } from './freeModeStateFile.js'
import { asRecord, getErrorMessage } from './httpUtils.js'
import { getCodexHomeDir } from './runtimePaths.js'

export type FreeModeServiceDependencies = {
  appServer: { dispose: () => void; getRuntimeQuiescenceSnapshot: () => Promise<RuntimeQuiescenceSnapshot> }
  backendQueueProcessor: { runProviderChange: <T>(change: () => Promise<T>) => Promise<T> }
  getRandomFreeKey: () => string | null
  getFreeKeyCount: () => number
  getFreeModels: () => Promise<string[]>
  getCachedFreeModels: () => string[]
  refreshFreeModelsInBackground: () => void
  fetchOpenCodeZenModelIds: (apiKey: string | null | undefined) => Promise<string[]>
  sortOpenCodeZenModelIds: (modelIds: string[]) => string[]
  filterOpenCodeZenModelsForAuthState: (modelIds: string[], apiKey: string | null | undefined) => string[]
  fetchCustomEndpointDefaultModel: (baseUrl: string, apiKey: string) => Promise<string>
  shouldMarkOpenRouterKeyAsCustom: (current: FreeModeState, apiKey: string) => boolean
}

const OPENCODE_ZEN_FALLBACK_MODELS = [
  OPENCODE_ZEN_DEFAULT_MODEL,
  'minimax-m2.5-free',
  'nemotron-3-super-free',
  'trinity-large-preview-free',
]

function providerChangeBlockedResponse(quiescence: RuntimeQuiescenceSnapshot): { statusCode: 409; body: { error: string } } | null {
  if (quiescence.idle) return null
  return {
    statusCode: 409,
    body: {
      error: quiescence.backgroundThreadIds?.length
        ? '请先处理 Codex 后台终端，再切换供应方或密钥。'
        : '请先结束当前任务并处理队列，再切换供应方或密钥',
    },
  }
}

function previousProviderKeys(state: FreeModeState): Record<string, string> {
  const providerKeys = { ...(state.providerKeys ?? {}) }
  if (state.provider && state.apiKey) providerKeys[state.provider] = state.apiKey
  return providerKeys
}

async function readOpenCodeZenModels(
  apiKey: string | null | undefined,
  dependencies: Pick<FreeModeServiceDependencies, 'fetchOpenCodeZenModelIds' | 'sortOpenCodeZenModelIds' | 'filterOpenCodeZenModelsForAuthState'>,
): Promise<string[]> {
  try {
    const modelIds = dependencies.filterOpenCodeZenModelsForAuthState(
      dependencies.sortOpenCodeZenModelIds(await dependencies.fetchOpenCodeZenModelIds(apiKey)),
      apiKey,
    )
    return modelIds.length > 0 ? modelIds : OPENCODE_ZEN_FALLBACK_MODELS
  } catch {
    return OPENCODE_ZEN_FALLBACK_MODELS
  }
}

async function readFreeModeState(statePath: string): Promise<FreeModeState> {
  return ensureDefaultFreeModeStateForMissingAuthSync(statePath)
    ?? { enabled: false, apiKey: null, model: FREE_MODE_DEFAULT_MODEL }
}

async function readFreeModeStatus(
  dependencies: Pick<FreeModeServiceDependencies, 'getFreeKeyCount' | 'getCachedFreeModels' | 'refreshFreeModelsInBackground' | 'fetchOpenCodeZenModelIds' | 'sortOpenCodeZenModelIds' | 'filterOpenCodeZenModelsForAuthState'>,
): Promise<FreeModeServiceResult> {
  const statePath = join(getCodexHomeDir(), FREE_MODE_STATE_FILE)
  try {
    const state = await readFreeModeState(statePath)
    const maskedKey = state.apiKey && state.customKey
      ? state.apiKey.substring(0, 12) + '...' + state.apiKey.substring(state.apiKey.length - 4)
      : null
    let models = dependencies.getCachedFreeModels()
    let currentModel = state.enabled ? state.model : null
    let wireApi = state.wireApi ?? null
    if (state.provider === OPENCODE_ZEN_PROVIDER_ID) {
      currentModel = state.enabled ? (state.model?.trim() || OPENCODE_ZEN_DEFAULT_MODEL) : null
      models = await readOpenCodeZenModels(state.apiKey, dependencies)
      wireApi = 'responses'
    } else {
      dependencies.refreshFreeModelsInBackground()
    }
    return { statusCode: 200, body: {
      enabled: state.enabled,
      hasCodexAuth: hasUsableCodexAuthSync(),
      keyCount: dependencies.getFreeKeyCount(),
      models,
      currentModel,
      customKey: Boolean(state.customKey),
      maskedKey,
      provider: state.provider ?? 'openrouter',
      customBaseUrl: state.customBaseUrl ?? null,
      wireApi,
    } }
  } catch (error) {
    return { statusCode: 500, body: { error: getErrorMessage(error, 'Failed to read free mode status') } }
  }
}

async function mutateFreeMode(
  action: FreeModeAction,
  readInput: () => Promise<unknown>,
  statePath: string,
  dependencies: Pick<FreeModeServiceDependencies, 'appServer' | 'getRandomFreeKey' | 'getFreeModels' | 'getFreeKeyCount' | 'fetchCustomEndpointDefaultModel' | 'shouldMarkOpenRouterKeyAsCustom'>,
): Promise<FreeModeServiceResult | null> {
  const readState = async () => await readFreeModeState(statePath)
  const saveProviderSwitch = async (state: FreeModeState) => {
    await writeFreeModeStateFile(statePath, state)
    dependencies.appServer.dispose()
  }
  try {
    if (action === 'toggle') {
      const body = asRecord(await readInput())
      const enable = Boolean(body?.enable)
      const prev = await readState()
      const providerKeys = previousProviderKeys(prev)
      if (!enable) {
        await saveProviderSwitch({
          enabled: false,
          apiKey: null,
          model: FREE_MODE_DEFAULT_MODEL,
          wireApi: prev.wireApi === 'chat' ? 'chat' : 'responses',
          providerKeys,
        })
        return { statusCode: 200, body: { ok: true, enabled: false } }
      }

      const apiKey = dependencies.getRandomFreeKey()
      if (!apiKey) {
        return { statusCode: 500, body: { error: 'No free keys available' } }
      }
      await saveProviderSwitch({
        enabled: true,
        apiKey,
        model: FREE_MODE_DEFAULT_MODEL,
        provider: 'openrouter',
        wireApi: prev.wireApi === 'chat' ? 'chat' : 'responses',
        providerKeys,
      })
      return { statusCode: 200, body: {
        ok: true,
        enabled: true,
        model: FREE_MODE_DEFAULT_MODEL,
        keyCount: dependencies.getFreeKeyCount(),
        models: await dependencies.getFreeModels(),
      } }
    }

    if (action === 'rotate') {
      const apiKey = dependencies.getRandomFreeKey()
      if (!apiKey) {
        return { statusCode: 500, body: { error: 'No free keys available' } }
      }
      await saveProviderSwitch({ ...(await readState()), apiKey, customKey: false })
      return { statusCode: 200, body: { ok: true } }
    }

    if (action === 'key') {
      const body = asRecord(await readInput())
      const key = typeof body?.key === 'string' ? body.key.trim() : ''
      const current = await readState()
      const apiKey = key || dependencies.getRandomFreeKey()
      const customKey = key.length > 0
      await saveProviderSwitch({
        ...current,
        apiKey,
        customKey,
        provider: 'openrouter',
        wireApi: current.wireApi === 'chat' ? 'chat' : 'responses',
      })
      return { statusCode: 200, body: { ok: true, customKey } }
    }

    if (action === 'provider') {
      const body = asRecord(await readInput())
      const baseUrl = typeof body?.baseUrl === 'string' ? body.baseUrl.trim() : ''
      const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : ''
      const wireApi = body?.wireApi === 'chat' ? 'chat' as const : 'responses' as const
      const providerType = body?.provider === 'opencode-zen'
        ? 'opencode-zen' as const
        : body?.provider === 'openrouter'
          ? 'openrouter' as const
          : 'custom' as const
      if (providerType === 'custom' && !baseUrl) {
        return { statusCode: 400, body: { error: 'baseUrl is required' } }
      }
      const current = await readState()
      const providerKeys = previousProviderKeys(current)
      const resolvedKey = apiKey || providerKeys[providerType] || ''
      if (resolvedKey) providerKeys[providerType] = resolvedKey
      const currentModel = (current.model ?? '').trim()
      const resolvedModel = providerType === 'openrouter'
        ? (currentModel.includes('/') ? currentModel : FREE_MODE_DEFAULT_MODEL)
        : providerType === 'custom'
          ? await dependencies.fetchCustomEndpointDefaultModel(baseUrl, resolvedKey)
          : OPENCODE_ZEN_DEFAULT_MODEL
      await saveProviderSwitch({
        enabled: true,
        apiKey: resolvedKey,
        model: resolvedModel,
        customKey: providerType === 'openrouter'
          ? dependencies.shouldMarkOpenRouterKeyAsCustom(current, apiKey)
          : true,
        provider: providerType,
        customBaseUrl: providerType === 'custom' ? baseUrl : undefined,
        wireApi,
        providerKeys,
      })
      return { statusCode: 200, body: { ok: true } }
    }
  } catch (error) {
    const fallback = action === 'toggle'
      ? 'Failed to toggle free mode'
      : action === 'rotate'
        ? 'Failed to rotate key'
        : action === 'key'
          ? 'Failed to set custom key'
          : 'Failed to set custom provider'
    return { statusCode: 500, body: { error: getErrorMessage(error, fallback) } }
  }
  return null
}

export type FreeModeAction = 'toggle' | 'rotate' | 'key' | 'provider' | 'unknown'
export type FreeModeServiceResult = { statusCode: number; body: Record<string, unknown> }

export function createFreeModeService(dependencies: FreeModeServiceDependencies) {
  return {
    status: () => readFreeModeStatus(dependencies),
    change: (action: FreeModeAction, readInput: () => Promise<unknown>): Promise<FreeModeServiceResult | null> => (
      dependencies.backendQueueProcessor.runProviderChange(async () => {
        const quiescence = await dependencies.appServer.getRuntimeQuiescenceSnapshot()
        const blocked = providerChangeBlockedResponse(quiescence)
        if (blocked) return blocked
        return mutateFreeMode(action, readInput, join(getCodexHomeDir(), FREE_MODE_STATE_FILE), dependencies)
      })
    ),
  }
}
