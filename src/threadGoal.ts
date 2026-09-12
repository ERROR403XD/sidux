export type ThreadGoal = {
  threadId: string
  objective: string
  status: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete'
  tokenBudget?: number | null
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
}

export const goalStatusLabels = {
  active: '运行中', paused: '已暂停', blocked: '需要处理',
  usageLimited: '用量受限', budgetLimited: '预算已用尽', complete: '已完成',
}

export function readThreadGoal(value: unknown, threadId: string): ThreadGoal | null {
  if (value === null) return null
  const goal = value as ThreadGoal | undefined
  if (!goal || goal.threadId !== threadId || typeof goal.objective !== 'string'
    || !Object.hasOwn(goalStatusLabels, goal.status)
    || ![goal.tokensUsed, goal.timeUsedSeconds, goal.createdAt, goal.updatedAt].every(value => Number.isSafeInteger(value) && value >= 0)
    || (goal.tokenBudget != null && (!Number.isSafeInteger(goal.tokenBudget) || goal.tokenBudget < 0))) {
    throw new Error('持续目标数据不完整，请重新读取')
  }
  return goal
}

export function goalBudgetRemaining(goal: ThreadGoal): number | null {
  return goal.tokenBudget == null || goalUsageUnreported(goal) ? null : Math.max(0, goal.tokenBudget - goal.tokensUsed)
}

export function goalUsageUnreported(goal: ThreadGoal): boolean {
  return goal.tokensUsed === 0 && goal.timeUsedSeconds > 0
}

export function goalResumeProblem(goal: ThreadGoal): string {
  return goal.tokenBudget != null && goal.tokensUsed >= goal.tokenBudget
    ? '预算已用尽'
    : ''
}

export function goalStatusHint(goal: ThreadGoal): string {
  switch (goal.status) {
    case 'blocked': return '目标已阻塞，请查看最后回复。'
    case 'budgetLimited': return goalResumeProblem(goal) || '预算已调整'
    case 'usageLimited': return '用量受限'
    default: return ''
  }
}

// Omitting an unchanged objective preserves native accounting, including terminal goals.
// A changed objective starts a new goal; inactive goals remain paused until explicitly resumed.
export function goalSavePatch(goal: ThreadGoal | null, input: { objective: string; tokenBudget: number | null }) {
  if (goal?.objective === input.objective) return { tokenBudget: input.tokenBudget }
  return { ...input, status: !goal || goal.status === 'active' ? 'active' as const : 'paused' as const }
}
