export type ScheduledResumeChoice = { model: string; effort: string; tier: string }
export type ScheduledResumeMark = {
  at: number
  status: 'scheduled' | 'submitted' | 'unknown' | 'failed'
  // Empty until the first durable claim; legacy scheduled marks may already have an ID.
  attemptId: string
  attemptedAt?: number
  turnId?: string
  choice: ScheduledResumeChoice
  contextId: string
  error?: string
}
