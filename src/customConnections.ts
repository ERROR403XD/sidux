import type { ModelCapability } from './modelCapabilities'
export type CustomEndpoint = '/v1/models' | '/v1/responses' | '/v1/chat/completions'
export type CustomConnection = {
  storageId: string
  alias: string
  provider: string
  baseUrl: string
  model: string
  wireApi: 'chat' | 'responses'
  supportedEndpoints?: CustomEndpoint[]
  testedAt?: string
  models: ModelCapability[]
  revision: number
  hasApiKey: boolean
}
export type CustomConnectionDraft = Pick<CustomConnection, 'alias' | 'provider' | 'baseUrl' | 'model' | 'wireApi'> & { storageId?: string; apiKey: string }
export type CustomConnectionSnapshot = { activeId: string | null; connections: CustomConnection[] }
export const customProviderPresets = [
  { value: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { value: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { value: 'opencode', label: 'OpenCode', baseUrl: 'https://opencode.ai/zen/v1' },
  { value: 'custom', label: '自定义', baseUrl: '' },
]
export function customConnectionModels(connection: CustomConnection) {
  return connection.models.map(model => ({
    id: model.id, model: model.model, displayName: model.displayName, isDefault: model.id === connection.model,
    supportedReasoningEfforts: (model.efforts || []).map(effort => ({ reasoningEffort: effort.value, description: effort.description })),
    defaultReasoningEffort: model.defaultEffort,
    serviceTiers: (model.serviceTiers || []).map(tier => ({ id: tier.value, name: tier.label, description: tier.description })),
    defaultServiceTier: model.defaultServiceTier, inputModalities: model.inputModalities,
  }))
}

export function customConnectionEndpoints(connection: Pick<CustomConnection, 'wireApi' | 'supportedEndpoints'>): CustomEndpoint[] {
  return connection.supportedEndpoints || ['/v1/models', connection.wireApi === 'responses' ? '/v1/responses' : '/v1/chat/completions']
}
