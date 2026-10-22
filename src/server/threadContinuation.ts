import { createHash } from 'node:crypto'
import { isGoalResumeIdentity, type DeliveryAcceptance, type DeliveryRecord, type GoalResumeIdentity } from '../delivery.js'
import { goalResumeProblem, goalStatusLabels, readThreadGoal, type ThreadGoal } from '../threadGoal.js'
import { asRecord } from './httpUtils.js'

type Rpc = (method: string, params: unknown) => Promise<unknown>

export function goalResumeIdentity(goal: ThreadGoal): GoalResumeIdentity {
  return { createdAt: goal.createdAt, objectiveHash: createHash('sha256').update(goal.objective).digest('hex') }
}

function matchesGoal(goal: ThreadGoal, identity: GoalResumeIdentity): boolean {
  const current = goalResumeIdentity(goal)
  return current.createdAt === identity.createdAt && current.objectiveHash === identity.objectiveHash
}

export async function readContinuationGoal(rpc: Rpc, threadId: string): Promise<ThreadGoal | null> {
  let result: unknown
  try {
    result = await rpc('thread/goal/get', { threadId })
  } catch (cause) {
    // Older runtimes without GOAL support can still continue ordinary conversations.
    if ((cause as { code?: number })?.code === -32601 || /method not found|unknown method/iu.test(cause instanceof Error ? cause.message : '')) return null
    throw cause
  }
  const response = asRecord(result)
  if (!response) throw new Error('无法读取持续目标，请核对会话后重试。')
  return readThreadGoal(response.goal ?? null, threadId)
}

function assertResumable(goal: ThreadGoal): void {
  if (goal.status === 'complete') throw new Error('持续目标已完成，无需续跑。')
  const problem = goalResumeProblem(goal)
  if (problem) throw new Error(problem)
}

export async function prepareGoalContinuation(rpc: Rpc, row: DeliveryRecord): Promise<Record<string, unknown> | null> {
  const goal = await readContinuationGoal(rpc, row.threadId)
  if (!goal) return null
  assertResumable(goal)
  return {
    threadId: row.threadId, input: [], goalResume: goalResumeIdentity(goal),
    goalSettings: {
      ...(row.message.model ? { model: row.message.model } : {}),
      ...(row.message.effort ? { effort: row.message.effort } : {}),
      ...(row.message.serviceTier !== undefined ? { serviceTier: row.message.serviceTier } : {}),
    },
  }
}

export async function resumeGoalContinuation(rpc: Rpc, params: Record<string, unknown>): Promise<DeliveryAcceptance> {
  const threadId = String(params.threadId)
  const identity = params.goalResume
  try {
    if (!isGoalResumeIdentity(identity)) throw new Error('持续目标续跑参数无效。')
    const current = await readContinuationGoal(rpc, threadId)
    if (!current || !matchesGoal(current, identity)) throw new Error('持续目标已修改或清除，请核对后重新设置续跑。')
    assertResumable(current)
    const settings = asRecord(params.goalSettings)
    if (settings && Object.keys(settings).length) await rpc('thread/settings/update', { threadId, ...settings })
  } catch (cause) {
    throw Object.assign(cause instanceof Error ? cause : new Error('目标续跑准备失败'), { submissionNotSent: true })
  }
  // The persisted user's continuation intent authorizes resuming the existing goal.
  // Do not supply objective/budget: native usage accounting must remain intact.
  const response = asRecord(await rpc('thread/goal/set', { threadId, status: 'active', origin: 'user' }))
  const resumed = readThreadGoal(response?.goal, threadId)
  if (!resumed || resumed.status !== 'active' || !matchesGoal(resumed, identity as GoalResumeIdentity)) throw new Error('目标续跑结果未确认，请核对会话。')
  return { goalResume: goalResumeIdentity(resumed) }
}

export async function inspectGoalContinuation(rpc: Rpc, threadId: string, identity: GoalResumeIdentity): Promise<{ status: 'submitted' | 'completed' | 'failed'; error?: string }> {
  const current = await readContinuationGoal(rpc, threadId)
  if (!current || !matchesGoal(current, identity)) return { status: 'failed', error: '持续目标已修改或清除，请核对会话。' }
  if (current.status === 'complete') return { status: 'completed' }
  if (current.status === 'active') return { status: 'submitted' }
  return { status: 'failed', error: `持续目标${goalStatusLabels[current.status]}，请核对后重新设置续跑。` }
}
