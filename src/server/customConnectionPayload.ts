export type PayloadModelCapability = {
  id: string
  efforts?: Array<{ value: string }> | null
  serviceTiers?: Array<{ value: string }> | null
}

export type CustomConnectionPayload = Record<string, unknown>

export type PayloadConnection = {
  model: string
  models: readonly PayloadModelCapability[]
  manualModels?: readonly string[] | null
  reasoningEfforts?: readonly string[] | null
  allowFast?: boolean
}

export function sanitizeCustomConnectionRequest(
  payload: CustomConnectionPayload,
  connection: PayloadConnection,
): CustomConnectionPayload {
  const model = typeof payload.model === 'string' && payload.model ? payload.model : connection.model
  const probedEfforts = connection.reasoningEfforts?.length
    ? [{ value: connection.reasoningEfforts[0]! }]
    : null
  return sanitizeCustomConnectionPayload({ ...payload, model }, [
    ...connection.models,
    ...(connection.manualModels ?? []).map(id => ({
      id,
      efforts: probedEfforts,
      serviceTiers: [],
    })),
  ], connection.allowFast === true)
}

export function sanitizeCustomConnectionPayload(
  payload: CustomConnectionPayload,
  models: readonly PayloadModelCapability[],
  allowFast = false,
): CustomConnectionPayload {
  const result = { ...payload }
  const model = models.find(row => row.id === result.model)
  if (!model?.efforts?.length) {
    delete result.reasoning
    delete result.reasoning_effort
  }
  const declaredTier = model?.serviceTiers?.some(tier => tier.value === result.service_tier)
  if (!declaredTier && !(allowFast && result.service_tier === 'priority')) delete result.service_tier
  return result
}
