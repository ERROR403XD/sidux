import { capabilityValue } from './modelCapabilities.js'
export type AutomationModelSettings = { model?: string; reasoningEffort?: string; serviceTier?: string; accountStorageId?: string | null; protected?: boolean }
export function normalizeAutomationModelSettings(input: { model?: unknown; reasoningEffort?: unknown; serviceTier?: unknown; accountStorageId?: unknown; protected?: unknown }, fallback: AutomationModelSettings = {}): AutomationModelSettings {
  const model = input.model === undefined ? fallback.model : input.model == null || input.model === '' ? undefined : input.model
  const effort = input.reasoningEffort === undefined ? fallback.reasoningEffort : input.reasoningEffort == null || input.reasoningEffort === '' ? undefined : input.reasoningEffort
  const tier = input.serviceTier === undefined ? fallback.serviceTier : input.serviceTier == null || input.serviceTier === '' ? undefined : input.serviceTier
  if (tier !== undefined && !capabilityValue(tier)) throw new Error('请选择有效的服务档位')
  if (model !== undefined && (typeof model !== 'string' || !model.trim() || model.length > 200)) throw new Error('请选择有效的模型')
  if (effort !== undefined && !capabilityValue(effort)) throw new Error('请选择有效的思考强度')
  const accountStorageId = input.accountStorageId === undefined ? fallback.accountStorageId : input.accountStorageId
  const protectedTask = input.protected === undefined ? fallback.protected : input.protected
  if (accountStorageId != null && (typeof accountStorageId !== 'string' || !/^[a-f0-9]{64}$/.test(accountStorageId))) throw new Error('请选择有效的账号')
  if (protectedTask !== undefined && typeof protectedTask !== 'boolean') throw new Error('保护选项无效')
  return { ...(accountStorageId !== undefined ? { accountStorageId: accountStorageId as string | null } : {}), ...(protectedTask !== undefined ? { protected: protectedTask as boolean } : {}), model: typeof model === 'string' ? model.trim() : undefined, reasoningEffort: effort as AutomationModelSettings['reasoningEffort'], ...(tier !== undefined ? { serviceTier: capabilityValue(tier) } : {}) }
}
