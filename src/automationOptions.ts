export const AUTOMATION_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
export type AutomationModelSettings = { model?: string; reasoningEffort?: typeof AUTOMATION_EFFORTS[number] }
export function normalizeAutomationModelSettings(input: { model?: unknown; reasoningEffort?: unknown }, fallback: AutomationModelSettings = {}): AutomationModelSettings {
  const model = input.model === undefined ? fallback.model : input.model == null || input.model === '' ? undefined : input.model
  const effort = input.reasoningEffort === undefined ? fallback.reasoningEffort : input.reasoningEffort == null || input.reasoningEffort === '' ? undefined : input.reasoningEffort
  if (model !== undefined && (typeof model !== 'string' || !model.trim() || model.length > 200)) throw new Error('请选择有效的模型')
  if (effort !== undefined && !AUTOMATION_EFFORTS.includes(effort as AutomationModelSettings['reasoningEffort'] & string)) throw new Error('请选择有效的思考强度')
  return { model: typeof model === 'string' ? model.trim() : undefined, reasoningEffort: effort as AutomationModelSettings['reasoningEffort'] }
}
