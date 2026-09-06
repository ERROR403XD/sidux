import { rpcCall } from './codexRpcClient'
export type ThreadGoal = {
  threadId: string; objective: string; status: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete'
  tokenBudget?: number | null; tokensUsed: number; timeUsedSeconds: number; createdAt: number; updatedAt: number
}
export function parseGoalTokenBudget(value: string): number | null {
  const input = value.trim()
  if (!input) return null
  const match = /^(\d+(?:\.\d*)?|\.\d+)\s*([MB])?$/i.exec(input)
  if (!match || input.length > 50) throw new Error('预算默认按 M，可输入 1、1.5M 或 0.01B')
  const [whole = '0', fraction = ''] = match[1]!.split('.')
  const scale = match[2]?.toUpperCase() === 'B' ? 9 : 6
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
  const unit = value >= 1_000_000_000 ? 'B' : 'M', scale = unit === 'B' ? 9 : 6
  const divisor = 10n ** BigInt(scale), tokens = BigInt(value)
  const fraction = (tokens % divisor).toString().padStart(scale, '0').replace(/0+$/, '')
  return `${tokens / divisor}${fraction ? `.${fraction}` : ''}${unit}`
}
export function validateGoalInput(objective: string, budget: string): { objective: string; tokenBudget: number | null } {
  const text = objective.trim()
  if (!text || [...text].length > 4000) throw new Error('目标需为 1–4000 个字符')
  return { objective: text, tokenBudget: parseGoalTokenBudget(budget) }
}
export async function getThreadGoal(threadId: string) { return (await rpcCall<{ goal: ThreadGoal | null }>('thread/goal/get', { threadId })).goal }
export async function setThreadGoal(threadId: string, patch: { objective?: string; tokenBudget?: number | null; status?: 'active' | 'paused' }) { return (await rpcCall<{ goal: ThreadGoal }>('thread/goal/set', { threadId, ...patch })).goal }
export async function clearThreadGoal(threadId: string) { await rpcCall('thread/goal/clear', { threadId }) }
export async function compactThread(threadId: string) { await rpcCall('thread/compact/start', { threadId }) }
export async function getLatestCompletedReply(threadId: string): Promise<string> {
  const result = await rpcCall<{ thread: { turns?: { status?: string; items?: { type?: string; text?: string }[] }[] } }>('thread/read', { threadId, includeTurns: true })
  const turn = [...(result.thread.turns ?? [])].reverse().find(turn => turn.status === 'completed' && turn.items?.some(item => item.type === 'agentMessage' && item.text?.trim()))
  const text = [...(turn?.items ?? [])].reverse().find(item => item.type === 'agentMessage' && item.text?.trim())?.text
  if (!text) throw new Error('当前没有已完成的助手回复可复制')
  return text
}
