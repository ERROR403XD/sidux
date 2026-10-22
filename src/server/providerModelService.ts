import { join } from 'node:path'
import { customConnectionModels } from '../customConnections.js'
import { ensureDefaultFreeModeStateForMissingAuthSync } from './appServerRuntimeDependencies.js'
import type { AppServerProcess } from './appServerProcess.js'
import type { CustomConnectionStore } from './customConnectionStore.js'
import { filterOpenCodeZenModelsForAuthState, FREE_MODE_STATE_FILE, getFreeModels, OPENCODE_ZEN_DEFAULT_MODEL } from './freeMode.js'
import { asRecord, getErrorMessage } from './httpUtils.js'
import { getCodexHomeDir, readNonEmptyString } from './runtimePaths.js'

type ProviderModelsResponse = { data: string[]; providerId: string; source: 'provider' }
const PROVIDER_MODELS_FETCH_TIMEOUT_MS = 5_000

function logProviderModelDiscoveryWarning(message: string, details: Record<string, unknown>): void {
  console.warn('[codex-provider-models]', message, details)
}

function isTimeoutError(payload: unknown): boolean {
  return payload instanceof Error && (payload.name === 'AbortError' || payload.name === 'TimeoutError')
}

function normalizeHeaderValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return null
}

function normalizeQueryParams(value: unknown): URLSearchParams {
  const params = new URLSearchParams()
  const record = asRecord(value)
  if (!record) return params

  for (const [key, rawValue] of Object.entries(record)) {
    const normalized = normalizeHeaderValue(rawValue)
    if (!normalized) continue
    params.set(key, normalized)
  }

  return params
}

function buildProviderModelsUrl(baseUrl: string, queryParams: unknown): URL {
  const url = new URL(baseUrl)
  url.pathname = url.pathname.endsWith('/') ? `${url.pathname}models` : `${url.pathname}/models`
  const extraParams = normalizeQueryParams(queryParams)
  for (const [key, value] of extraParams.entries()) {
    url.searchParams.set(key, value)
  }
  return url
}

export function normalizeProviderModelsData(payload: unknown): string[] {
  const record = asRecord(payload)
  const dataRows = Array.isArray(record?.data) ? record.data : null
  const modelRows = Array.isArray(record?.models) ? record.models : null
  const rows = dataRows?.length ? dataRows : modelRows?.length ? modelRows : dataRows ?? modelRows
  if (!rows) {
    throw new Error('provider /models payload is missing a data/models array')
  }

  const ids: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const candidateFromString = readNonEmptyString(row)
    const entry = asRecord(row)
    const candidate = candidateFromString
      || readNonEmptyString(entry?.id)
      || readNonEmptyString(entry?.model)
      || readNonEmptyString(entry?.slug)
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    ids.push(candidate)
  }
  return ids
}

export async function fetchCustomEndpointDefaultModel(baseUrl: string, apiKey: string): Promise<string> {
  const normalizedBaseUrl = baseUrl.trim()
  if (!normalizedBaseUrl) return ''

  try {
    const modelsUrl = buildProviderModelsUrl(normalizedBaseUrl, null)
    const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
    const response = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(PROVIDER_MODELS_FETCH_TIMEOUT_MS) })
    if (!response.ok) return ''
    const payload = await response.json() as unknown
    const modelIds = normalizeProviderModelsData(payload)
    return modelIds[0] ?? ''
  } catch {
    return ''
  }
}

export async function fetchOpenCodeZenModelIds(apiKey: string | null | undefined): Promise<string[]> {
  const headers: Record<string, string> = {}
  if (apiKey && apiKey !== 'dummy') {
    headers.Authorization = `Bearer ${apiKey}`
  }
  const response = await fetch('https://opencode.ai/zen/v1/models', {
    headers,
    signal: AbortSignal.timeout(PROVIDER_MODELS_FETCH_TIMEOUT_MS),
  })
  if (!response.ok) return []
  return normalizeProviderModelsData(await response.json() as unknown)
}

export function sortOpenCodeZenModelIds(modelIds: string[]): string[] {
  const freeIds = modelIds.filter((id) => id.endsWith('-free') || id === OPENCODE_ZEN_DEFAULT_MODEL)
  const paidIds = modelIds.filter((id) => !id.endsWith('-free') && id !== OPENCODE_ZEN_DEFAULT_MODEL)
  return [...freeIds, ...paidIds]
}

async function readProviderBackedModelIds(appServer: Pick<AppServerProcess, 'rpc'>): Promise<ProviderModelsResponse> {
  const configPayload = asRecord(await appServer.rpc('config/read', {}))
  const config = asRecord(configPayload?.config)
  const providerId = readNonEmptyString(config?.model_provider)
  if (!providerId) {
    return { data: [], providerId: '', source: 'provider' }
  }

  const providers = asRecord(config?.model_providers)
  const provider = asRecord(providers?.[providerId])
  if (!provider) {
    logProviderModelDiscoveryWarning('configured provider is missing from model_providers', { providerId })
    return { data: [], providerId, source: 'provider' }
  }

  const wireApi = readNonEmptyString(provider.wire_api)
  if (wireApi !== 'responses') {
    return { data: [], providerId, source: 'provider' }
  }

  const baseUrl = readNonEmptyString(provider.base_url)
  if (!baseUrl) {
    logProviderModelDiscoveryWarning('responses provider is missing base_url', { providerId })
    return { data: [], providerId, source: 'provider' }
  }

  const headers = new Headers()
  const configuredHeaders = asRecord(provider.http_headers)
  if (configuredHeaders) {
    for (const [key, rawValue] of Object.entries(configuredHeaders)) {
      const normalized = normalizeHeaderValue(rawValue)
      if (!normalized) continue
      headers.set(key, normalized)
    }
  }

  const bearerToken = readNonEmptyString(provider.experimental_bearer_token)
  if (bearerToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${bearerToken}`)
  }

  const envKey = readNonEmptyString(provider.env_key)
  const envHttpHeaders = asRecord(provider.env_http_headers)
  if (envKey || envHttpHeaders) {
    logProviderModelDiscoveryWarning('provider discovery skipped env-backed auth/header expansion', {
      providerId,
      hasEnvKey: Boolean(envKey),
      hasEnvHttpHeaders: Boolean(envHttpHeaders),
    })
  }

  let requestUrl: URL
  try {
    requestUrl = buildProviderModelsUrl(baseUrl, provider.query_params)
  } catch (error) {
    logProviderModelDiscoveryWarning('provider /models URL was invalid', {
      providerId,
      error: getErrorMessage(error, 'invalid url'),
    })
    return { data: [], providerId, source: 'provider' }
  }

  let response: Response
  try {
    response = await fetch(requestUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(PROVIDER_MODELS_FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    logProviderModelDiscoveryWarning('provider /models request failed', {
      providerId,
      error: isTimeoutError(error) ? `request timed out after ${PROVIDER_MODELS_FETCH_TIMEOUT_MS}ms` : getErrorMessage(error, 'network error'),
    })
    return { data: [], providerId, source: 'provider' }
  }

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch (error) {
    logProviderModelDiscoveryWarning('provider /models response was not valid JSON', {
      providerId,
      status: response.status,
      error: getErrorMessage(error, 'invalid json'),
    })
    return { data: [], providerId, source: 'provider' }
  }

  if (!response.ok) {
    logProviderModelDiscoveryWarning('provider /models request returned non-2xx', {
      providerId,
      status: response.status,
      statusText: response.statusText,
    })
    return { data: [], providerId, source: 'provider' }
  }

  try {
    return {
      data: normalizeProviderModelsData(payload),
      providerId,
      source: 'provider',
    }
  } catch (error) {
    logProviderModelDiscoveryWarning('provider /models payload was invalid', {
      providerId,
      error: getErrorMessage(error, 'invalid payload'),
    })
    return { data: [], providerId, source: 'provider' }
  }
}

async function readProviderModelIdsForProvider(
  appServer: Pick<AppServerProcess, 'rpc'>,
  providerId: string,
): Promise<ProviderModelsResponse> {
  const normalizedProviderId = providerId.trim().toLowerCase().replace(/_/g, '-')
  if (!normalizedProviderId || normalizedProviderId === 'codex' || normalizedProviderId === 'openai') {
    return { data: [], providerId: '', source: 'provider' }
  }

  const fmState = ensureDefaultFreeModeStateForMissingAuthSync(join(getCodexHomeDir(), FREE_MODE_STATE_FILE))
  if (normalizedProviderId === 'opencode-zen') {
    try {
      const modelIds = filterOpenCodeZenModelsForAuthState(
        sortOpenCodeZenModelIds(await fetchOpenCodeZenModelIds(fmState?.provider === 'opencode-zen' ? fmState.apiKey : null)),
        fmState?.provider === 'opencode-zen' ? fmState.apiKey : null,
      )
      if (modelIds.length > 0) {
        return { data: modelIds, providerId: 'opencode-zen', source: 'provider' }
      }
    } catch {
      // Fall through to the offline Zen defaults.
    }
    return {
      data: ['big-pickle', 'minimax-m2.5-free', 'nemotron-3-super-free', 'trinity-large-preview-free'],
      providerId: 'opencode-zen',
      source: 'provider',
    }
  }

  if (normalizedProviderId === 'openrouter-free' || normalizedProviderId === 'openrouter') {
    return {
      data: await getFreeModels(),
      providerId: 'openrouter-free',
      source: 'provider',
    }
  }

  return readProviderBackedModelIds(appServer)
}


export function createProviderModelService(appServer: Pick<AppServerProcess, 'rpc'>, getConnections: () => Pick<CustomConnectionStore, 'get' | 'active'> & Partial<Pick<CustomConnectionStore, 'refreshModels'>>) {
  async function readAccountModels(storageId: string | null) {
    const connections = getConnections()
    const custom = storageId ? connections.get(storageId) : connections.active()
    if (!custom) return null
    await connections.refreshModels?.(custom.storageId)
    const current = connections.get(custom.storageId)
    return current ? { data: customConnectionModels({ ...current, hasApiKey: true }), source: 'custom' } : null
  }
  async function readModels(requestedProvider: string) {
    try {
      const connections = getConnections()
      const custom = connections.active()
      if (custom) {
        const catalog = await readAccountModels(custom.storageId)
        if (catalog) return { ...catalog, exclusive: true }
      }
      if (requestedProvider) {
        return ({
          ...(await readProviderModelIdsForProvider(appServer, requestedProvider)),
          exclusive: true,
        })
      }
      const fmState = ensureDefaultFreeModeStateForMissingAuthSync(join(getCodexHomeDir(), FREE_MODE_STATE_FILE))
      if (fmState?.enabled) {
        if (fmState.provider === 'opencode-zen') {
          try {
            const modelIds = filterOpenCodeZenModelsForAuthState(
              sortOpenCodeZenModelIds(await fetchOpenCodeZenModelIds(fmState.apiKey)),
              fmState.apiKey,
            )
            if (modelIds.length > 0) {
              return ({ data: modelIds, exclusive: true, source: 'opencode-zen' })
            }
          } catch {
            // OpenCode Zen model fetch failed
          }
          return ({ data: ['big-pickle', 'minimax-m2.5-free', 'nemotron-3-super-free', 'trinity-large-preview-free'], exclusive: true, source: 'opencode-zen' })
        }
        if (fmState.provider === 'custom' && fmState.customBaseUrl) {
          try {
            const modelsUrl = fmState.customBaseUrl.replace(/\/+$/, '') + '/models'
            const headers: Record<string, string> = {}
            if (fmState.apiKey && fmState.apiKey !== 'dummy') {
              headers['Authorization'] = `Bearer ${fmState.apiKey}`
            }
            const resp = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(8000) })
            if (resp.ok) {
              const json = await resp.json() as unknown
              const ids = normalizeProviderModelsData(json)
              const currentModel = fmState.model?.trim() ?? ''
              const orderedIds = currentModel && ids.includes(currentModel)
                ? [currentModel, ...ids.filter((id) => id !== currentModel)]
                : ids
              return ({ data: orderedIds, exclusive: true, source: 'custom' })
            }
          } catch {
            // Custom endpoint model fetch failed — return empty list
          }
          return ({ data: [], exclusive: true, source: 'custom' })
        }
        const freeModels = await getFreeModels()
        return ({ data: freeModels, exclusive: true })
      }
    } catch {
      // No free-mode state — proceed normally
    }
    const data = await readProviderBackedModelIds(appServer)
    return (data)
  }
  return { readAccountModels, readModels }
}
