export function normalizeThreadModelFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const model = (payload as Record<string, unknown>).model
  return typeof model === 'string' ? model.trim() : ''
}

export function normalizeThreadModelProviderFromPayload(payload: unknown): string {
  const value = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null
  if (!value) return ''
  const modelProvider = typeof value.modelProvider === 'string' && value.modelProvider.length > 0
    ? value.modelProvider
    : null
  if (modelProvider) return modelProvider.trim()
  const thread = value.thread && typeof value.thread === 'object' && !Array.isArray(value.thread)
    ? (value.thread as Record<string, unknown>)
    : null
  return typeof thread?.modelProvider === 'string' && thread.modelProvider.length > 0
    ? thread.modelProvider.trim()
    : ''
}
