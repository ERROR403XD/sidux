import type { ThreadQuotaResume } from './threadQuotaResume.js'
import type { ThreadScheduledResume } from './threadScheduledResume.js'
import type { ScheduledResumeChoice } from '../threadScheduledResume.js'

export class ThreadResumeConflictError extends Error {}

export function createThreadResumeControlService(
  quotaResume: Pick<ThreadQuotaResume, 'has' | 'set' | 'snapshot'>,
  scheduledResume: Pick<ThreadScheduledResume, 'has' | 'set' | 'snapshot'>,
) {
  const changes = new Map<string, Promise<void>>()

  function change(threadId: string, work: () => Promise<void>): Promise<void> {
    const previous = changes.get(threadId) ?? Promise.resolve()
    const operation = previous.then(work)
    const settled = operation.catch(() => {})
    changes.set(threadId, settled)
    void settled.then(() => {
      if (changes.get(threadId) === settled) changes.delete(threadId)
    })
    return operation
  }

  return {
    quotaResume: {
      snapshot: () => quotaResume.snapshot(),
      set: (threadId: string, enabled: boolean) => change(threadId, async () => {
        if (enabled && await scheduledResume.has(threadId)) {
          throw new ThreadResumeConflictError('已设置定时续跑，请先取消。')
        }
        await quotaResume.set(threadId, enabled)
      }),
    },
    scheduledResume: {
      snapshot: () => scheduledResume.snapshot(),
      set: (threadId: string, at: number | null, choice?: ScheduledResumeChoice) => change(threadId, async () => {
        if (at !== null && await quotaResume.has(threadId)) {
          throw new ThreadResumeConflictError('已设置额度恢复续跑，请先取消。')
        }
        await scheduledResume.set(threadId, at, choice)
      }),
    },
  }
}
