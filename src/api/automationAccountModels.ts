import { normalizeModelCapability, type ModelCapability } from '../modelCapabilities'

export async function loadAutomationAccountModels(storageId: string, signal: AbortSignal): Promise<ModelCapability[]> {
  const response = await fetch(`/codex-api/accounts/models?storageId=${encodeURIComponent(storageId)}`, { signal })
  const data = await response.json()
  if (!response.ok || !Array.isArray(data?.data)) throw new Error('所选账号模型目录读取失败')
  return data.data.map((row: unknown) => normalizeModelCapability(row, data.source || 'codex'))
    .filter((model: ModelCapability | null): model is ModelCapability => model !== null)
}
