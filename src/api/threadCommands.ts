import { rpcCall } from './codexRpcClient'
import { readThreadGoal, type ThreadGoal } from '../threadGoal'
export { goalStatusLabels, type ThreadGoal } from '../threadGoal'
export function parseGoalTokenBudget(value: string): number | null {
  const input = value.trim()
  if (!input) return null
  const match = /^(\d+(?:\.\d*)?|\.\d+)\s*([KMB])?$/i.exec(input)
  if (!match || input.length > 50) throw new Error('预算请输入 token 数量，可使用 k、M、B')
  const [whole = '0', fraction = ''] = match[1]!.split('.')
  const scale = ({ K: 3, M: 6, B: 9 } as Record<string, number>)[match[2]?.toUpperCase() || ''] ?? 0
  const digits = BigInt((whole || '0') + fraction)
  const shift = scale - fraction.length
  const divisor = 10n ** BigInt(Math.max(0, -shift))
  if (digits % divisor !== 0n) throw new Error('预算换算后需至少为 1 个完整 token')
  const tokens = shift >= 0 ? digits * 10n ** BigInt(shift) : digits / divisor
  if (tokens <= 0n || tokens > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('预算需为有效正数，且不能超过可精确表示的 token 数量')
  return Number(tokens)
}
export function formatGoalTokenBudget(value: number | null | undefined): string {
  if (value == null) return ''
  if (value < 1000) return String(value)
  const unit = value >= 1_000_000_000 ? 'B' : value >= 1_000_000 ? 'M' : 'k'
  const scale = unit === 'B' ? 9 : unit === 'M' ? 6 : 3
  const divisor = 10n ** BigInt(scale), tokens = BigInt(value)
  const fraction = (tokens % divisor).toString().padStart(scale, '0').replace(/0+$/, '')
  return `${tokens / divisor}${fraction ? `.${fraction}` : ''}${unit}`
}
export function validateGoalInput(objective: string, budget: string): { objective: string; tokenBudget: number | null } {
  const text = objective.trim()
  if (!text || [...text].length > 4000) throw new Error('目标需为 1–4000 个字符')
  return { objective: text, tokenBudget: parseGoalTokenBudget(budget) }
}
export async function getThreadGoal(threadId: string) {
  return readThreadGoal((await rpcCall<{ goal: ThreadGoal | null }>('thread/goal/get', { threadId })).goal, threadId)
}
export async function setThreadGoal(threadId: string, patch: { objective?: string; tokenBudget?: number | null; status?: 'active' | 'paused' }) {
  const goal = readThreadGoal((await rpcCall<{ goal: ThreadGoal }>('thread/goal/set', { threadId, ...patch })).goal, threadId)
  if (!goal) throw new Error('持续目标保存结果缺失，请重新读取')
  return goal
}
export async function clearThreadGoal(threadId: string) { await rpcCall('thread/goal/clear', { threadId }) }
export { compactThread } from './threadCompaction'
export async function getLatestCompletedReply(threadId: string): Promise<string> {
  const result = await rpcCall<{ thread: { turns?: { status?: string; items?: { type?: string; text?: string }[] }[] } }>('thread/read', { threadId, includeTurns: true })
  const turn = [...(result.thread.turns ?? [])].reverse().find(turn => turn.status === 'completed' && turn.items?.some(item => item.type === 'agentMessage' && item.text?.trim()))
  const text = [...(turn?.items ?? [])].reverse().find(item => item.type === 'agentMessage' && item.text?.trim())?.text
  if (!text) throw new Error('当前没有已完成的助手回复可复制')
  return text
}

export type GoalModelSettings = { model: string; effort: string }
export async function getGoalModelSettings(threadId: string): Promise<GoalModelSettings> {
  const { thread } = await rpcCall<{ thread: { model?: string | null; reasoningEffort?: string | null } }>('thread/read', { threadId, includeTurns: false })
  return { model: thread.model ?? '', effort: thread.reasoningEffort ?? '' }
}
export async function applyGoalModelSettings(threadId: string, settings: GoalModelSettings): Promise<void> {
  await rpcCall('thread/settings/update', { threadId, ...(settings.model ? { model: settings.model } : {}), ...(settings.effort ? { effort: settings.effort } : {}) })
}
