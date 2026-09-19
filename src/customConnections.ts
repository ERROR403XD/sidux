import type { ModelCapability } from './modelCapabilities'
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
  /** Reasoning effort levels declared for this provider; empty keeps the catalog default (no reasoning param). */
  reasoningEfforts?: string[]
  supportedEndpoints?: CustomEndpoint[]
  testedAt?: string
  models: ModelCapability[]
  revision: number
  hasApiKey: boolean
}
export type CustomConnectionDraft = Pick<CustomConnection, 'alias' | 'provider' | 'baseUrl' | 'model' | 'wireApi'> & { storageId?: string; apiKey: string; protocolBridge?: boolean; reasoningEfforts?: string[] }
export type CustomConnectionSnapshot = { activeId: string | null; connections: CustomConnection[] }
export const customProviderPresets = [
  { value: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { value: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { value: 'opencode', label: 'OpenCode', baseUrl: 'https://opencode.ai/zen/v1' },
  { value: 'custom', label: '自定义', baseUrl: '' },
]
/** Levels accepted on the wire for OpenAI-compatible providers, in slider order. */
export const customReasoningEffortLevels = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const
export function normalizeReasoningEfforts(value: unknown): string[] {
  const allowed = new Set<string>(customReasoningEffortLevels)
  const declared = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && allowed.has(item)) : []
  return customReasoningEffortLevels.filter(level => declared.includes(level))
}
/** A saved declaration overrides whatever the provider catalog exposed, so the composer picker matches the wire. */
export function applyDeclaredEfforts(models: ModelCapability[], efforts: string[]): ModelCapability[] {
  if (!efforts.length) return models
  const declared = efforts.map(value => ({ value, description: '' }))
  return models.map(model => ({ ...model, efforts: declared }))
}
export function customConnectionModels(connection: CustomConnection) {
  return connection.models.map(model => ({
    id: model.id, model: model.model, displayName: model.displayName, isDefault: model.id === connection.model,
    supportedReasoningEfforts: (model.efforts || []).map(effort => ({ reasoningEffort: effort.value, description: effort.description })),
    defaultReasoningEffort: model.defaultEffort,
    serviceTiers: (model.serviceTiers || []).map(tier => ({ id: tier.value, name: tier.label, description: tier.description })),
    defaultServiceTier: model.defaultServiceTier, inputModalities: model.inputModalities,
  }))
}

/** Endpoints the connection probe confirmed natively (no bridge involved). */
export function customConnectionNativeEndpoints(connection: Pick<CustomConnection, 'wireApi' | 'supportedEndpoints'>): CustomEndpoint[] {
  return connection.supportedEndpoints || ['/v1/models', connection.wireApi === 'responses' ? '/v1/responses' : '/v1/chat/completions']
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
export function customConnectionEndpoints(connection: Pick<CustomConnection, 'wireApi' | 'protocolBridge' | 'supportedEndpoints'>): CustomEndpoint[] {
  const native = customConnectionNativeEndpoints(connection)
  const bridged = customConnectionBridgedEndpoints(connection)
  return bridged.length > 0 ? [...native, ...bridged] : native
}
