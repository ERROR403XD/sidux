import { rpcCall } from './codexRpcClient'
export type ThreadGoal = {
  threadId: string; objective: string; status: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete'
  tokenBudget?: number | null; tokensUsed: number; timeUsedSeconds: number; createdAt: number; updatedAt: number
}
export function validateGoalInput(objective: string, budget: string): { objective: string; tokenBudget: number | null } {
  const text = objective.trim()
  if (!text || [...text].length > 4000) throw new Error('目标需为 1–4000 个字符')
  const tokenBudget = budget.trim() ? Number(budget) : null
  if (tokenBudget !== null && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)) throw new Error('Token 预算需为正整数，留空表示不设预算')
  return { objective: text, tokenBudget }
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
