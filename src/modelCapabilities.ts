// Shared by browser, queue and automation adapters. Missing metadata means unknown.
export type ModelCapability = {
  id: string
  model: string
  displayName: string
  providerId: string
  isDefault: boolean
  efforts: Array<{ value: string; description: string }> | null
  defaultEffort: string
  serviceTiers: Array<{ value: string; label: string; description: string }> | null
  defaultServiceTier: string
  inputModalities: string[] | null
}

export function capabilityValue(value: unknown): string {
  return typeof value === 'string' && value.trim().length <= 128 && !/[\u0000-\u001f\u007f]/.test(value)
    ? value.trim() : ''
}

export function normalizeModelCapability(value: unknown, providerId = 'codex'): ModelCapability | null {
  const row = typeof value === 'string' ? { id: value } : value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const id = capabilityValue(row.id) || capabilityValue(row.model)
  if (!id) return null
  const efforts = Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts.flatMap(value => {
    const item = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    const effort = capabilityValue(item.reasoningEffort)
    return effort ? [{ value: effort, description: typeof item.description === 'string' ? item.description.slice(0, 500) : '' }] : []
  }) : null
  const serviceTiers = Array.isArray(row.serviceTiers) ? row.serviceTiers.flatMap(value => {
    const item = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    const tier = capabilityValue(item.id)
    return tier ? [{ value: tier, label: capabilityValue(item.name) || tier, description: typeof item.description === 'string' ? item.description.slice(0, 500) : '' }] : []
  }) : Array.isArray(row.additionalSpeedTiers) ? row.additionalSpeedTiers.flatMap(value => {
    const tier = capabilityValue(value)
    return tier ? [{ value: tier, label: tier, description: '' }] : []
  }) : null
  return {
    id, model: capabilityValue(row.model) || id, displayName: capabilityValue(row.displayName) || id,
    providerId, isDefault: row.isDefault === true,
    efforts: efforts?.filter((item, index) => efforts.findIndex(other => other.value === item.value) === index) ?? null,
    defaultEffort: capabilityValue(row.defaultReasoningEffort),
    serviceTiers: serviceTiers?.filter((item, index) => serviceTiers.findIndex(other => other.value === item.value) === index) ?? null,
    defaultServiceTier: capabilityValue(row.defaultServiceTier),
    inputModalities: Array.isArray(row.inputModalities) ? [...new Set(row.inputModalities.map(capabilityValue).filter(Boolean))] : null,
  }
}

export function reasoningUnavailable(model: ModelCapability | null | undefined): boolean {
  return model?.providerId === 'custom' && !model.efforts?.length
}

export function effortOptions(model: ModelCapability | null | undefined, selected = '') {
  if (reasoningUnavailable(model)) return [{ value: '', label: 'N/A' }]
  const labels: Record<string, string> = { none: '无', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高' }
  const options = (model?.efforts ?? []).map(item => ({ value: item.value, label: model?.providerId === 'custom' ? item.value : labels[item.value] || item.value }))
  if (selected && !options.some(item => item.value === selected)) options.push({ value: selected, label: `${selected}（已保存，目录未确认）` })
  return [{ value: '', label: model?.defaultEffort ? `模型默认（${labels[model.defaultEffort] || model.defaultEffort}）` : '跟随运行时默认强度' }, ...options]
}

export function tierOptions(model: ModelCapability | null | undefined, selected = '') {
  const options = (model?.serviceTiers ?? []).map(item => ({ value: item.value, label: item.label }))
  if (selected && !options.some(item => item.value === selected)) options.push({ value: selected, label: `${selected}（已保存，目录未确认）` })
  return [{ value: '', label: model?.defaultServiceTier ? `模型默认（${model.defaultServiceTier}）` : '标准速度' }, ...options]
}

export function fastModeControl(model: ModelCapability | null | undefined, selected = '') {
  if (model?.providerId === 'custom' && !model.serviceTiers?.length) return { checked: false, disabled: true, nextValue: '', hint: 'N/A' }
  const fast = model?.serviceTiers?.find(tier => tier.value === 'priority' || /^fast$/i.test(tier.label))
  const standard = model?.serviceTiers?.find(tier => /^(default|standard)$/i.test(tier.value))
  const checked = !!fast && (selected || model?.defaultServiceTier) === fast.value
  const onlyDefault = checked && model?.defaultServiceTier === fast?.value && !standard
  const offValue = model?.defaultServiceTier === fast?.value ? standard?.value || '' : ''
  return {
    checked,
    disabled: onlyDefault || (!fast && !selected),
    nextValue: checked || !fast ? offValue : fast.value,
    hint: onlyDefault ? '此模型仅提供快速模式' : !fast ? (selected ? '恢复默认速度' : '此模型未提供快速模式') : '快速模式',
  }
}

export function modelSettingsProblem(model: ModelCapability | null | undefined, effort: string, tier: string, hasImages = false): string {
  if (effort && !reasoningUnavailable(model) && model?.efforts && !model.efforts.some(item => item.value === effort)) return `模型未公布思考强度 ${effort}，请重新选择或使用模型默认。`
  if (tier && !(model?.providerId === 'custom' && !model.serviceTiers?.length) && model?.serviceTiers && !model.serviceTiers.some(item => item.value === tier)) return `模型未公布服务档位 ${tier}，请重新选择或使用标准速度。`
  if (hasImages && model?.inputModalities && !model.inputModalities.includes('image')) return '当前模型不支持图片。'
  return ''
}
