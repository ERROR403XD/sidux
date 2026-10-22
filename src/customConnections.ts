import { capabilityValue, normalizeModelCapability, type ModelCapability } from './modelCapabilities'
export type CustomEndpoint = '/v1/models' | '/v1/responses' | '/v1/chat/completions'
export type CustomConnection = {
  storageId: string
  alias: string
  provider: string
  baseUrl: string
  model: string
  wireApi: 'chat' | 'responses'
  /** Opt-in protocol bridge: serves the endpoint this connection lacks natively. */
  protocolBridge: boolean
  /** Opt in to priority forwarding when the upstream catalog omits Fast support. */
  allowFast?: boolean
  /** Effort levels the connection probe confirmed (levels the upstream explicitly rejected are absent). */
  reasoningEfforts?: string[]
  /** Version 2 preserves missing versus explicitly empty per-model capabilities. */
  capabilitiesVersion?: number
  /** Local model catalog used when the upstream does not serve /v1/models. */
  manualModels?: string[]
  supportedEndpoints?: CustomEndpoint[]
  testedAt?: string
  models: ModelCapability[]
  revision: number
  hasApiKey: boolean
}
export type CustomConnectionDraft = Pick<CustomConnection, 'alias' | 'provider' | 'baseUrl' | 'model' | 'wireApi' | 'manualModels' | 'allowFast'> & { storageId?: string; apiKey: string; protocolBridge?: boolean }
export type CustomConnectionSnapshot = { activeId: string | null; connections: CustomConnection[] }
export const customProviderPresets = [
  { value: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { value: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { value: 'opencode', label: 'OpenCode', baseUrl: 'https://opencode.ai/zen/v1' },
  { value: 'custom', label: '自定义', baseUrl: '' },
]
/** Compatibility probes only for the selected model when its catalog omits reasoning metadata. */
export const customReasoningEffortLevels = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const
export function normalizeReasoningEfforts(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(capabilityValue).filter(Boolean))] : []
}
/** A probe for one model is never evidence about a different model. Catalog declarations win. */
export function applyProbedEfforts(models: ModelCapability[], efforts: string[], probedModel: string): ModelCapability[] {
  if (!efforts.length) return models
  const probed = efforts.map(value => ({ value, description: '' }))
  return models.map(model => model.id === probedModel && model.efforts === null ? { ...model, efforts: probed } : model)
}
export function normalizeManualModels(value: unknown): string[] {
  const rows = Array.isArray(value) ? value : []
  const seen = new Set<string>()
  for (const row of rows) {
    if (typeof row !== 'string') continue
    const model = row.trim().slice(0, 200)
    if (!model || /[\r\n]/.test(model)) continue
    seen.add(model)
    if (seen.size >= 200) break
  }
  return [...seen]
}
export function customConnectionModels(connection: Pick<CustomConnection, 'models' | 'model' | 'manualModels' | 'allowFast'> & { hasApiKey?: boolean }) {
  const models = [...connection.models]
  for (const id of normalizeManualModels(connection.manualModels)) {
    if (!models.some(model => model.id === id)) models.push({ ...normalizeModelCapability(id, 'custom')!, efforts: [], serviceTiers: [] })
  }
  return models.map(model => ({
    id: model.id, model: model.id, displayName: model.id, isDefault: model.id === connection.model,
    supportedReasoningEfforts: (model.efforts || []).map(effort => ({ reasoningEffort: effort.value, description: effort.description })),
    defaultReasoningEffort: model.defaultEffort,
    serviceTiers: [
      ...(model.serviceTiers || []).map(tier => ({ id: tier.value, name: tier.label, description: tier.description })),
      ...(connection.allowFast === true && !model.serviceTiers?.some(tier => tier.value === 'priority' || /^fast$/i.test(tier.label))
        ? [{ id: 'priority', name: 'Fast', description: '' }] : []),
    ],
    defaultServiceTier: model.defaultServiceTier, inputModalities: model.inputModalities,
  }))
}

/** Endpoints the connection probe confirmed natively (no bridge involved). */
export function customConnectionNativeEndpoints(connection: Pick<CustomConnection, 'wireApi' | 'supportedEndpoints'>): CustomEndpoint[] {
  return connection.supportedEndpoints || ['/v1/models', connection.wireApi === 'responses' ? '/v1/responses' : '/v1/chat/completions']
}
/** Endpoints served locally from saved settings rather than upstream. */
export function customConnectionManualEndpoints(connection: Pick<CustomConnection, 'wireApi' | 'supportedEndpoints' | 'manualModels'>): CustomEndpoint[] {
  const native = customConnectionNativeEndpoints(connection)
  return !native.includes('/v1/models') && normalizeManualModels(connection.manualModels).length ? ['/v1/models'] : []
}

/** Endpoints served through the protocol bridge when the toggle is on. */
export function customConnectionBridgedEndpoints(connection: Pick<CustomConnection, 'wireApi' | 'protocolBridge' | 'supportedEndpoints'>): CustomEndpoint[] {
  if (!connection.protocolBridge) return []
  const native = customConnectionNativeEndpoints(connection)
  const bridged: CustomEndpoint[] = []
  if (!native.includes('/v1/responses')) bridged.push('/v1/responses')
  if (!native.includes('/v1/chat/completions')) bridged.push('/v1/chat/completions')
  return bridged
}

/** Servable endpoints: native ones plus bridge-served ones when enabled. */
export function customConnectionEndpoints(connection: Pick<CustomConnection, 'wireApi' | 'protocolBridge' | 'supportedEndpoints' | 'manualModels'>): CustomEndpoint[] {
  const native = customConnectionNativeEndpoints(connection)
  const bridged = customConnectionBridgedEndpoints(connection)
  const manual = customConnectionManualEndpoints(connection)
  return [...native, ...bridged, ...manual]
}
