import type { IgnoredQuotaErrors } from './ignoredQuotaErrors.js'
import type { SidebarThreadStatusReader } from './sidebarThreadStatusReader.js'
import type { ThreadGoalReader } from './threadGoalReader.js'
import type { ThreadInterruptionList } from './threadInterruptionList.js'
import type { ThreadQuotaResume } from './threadQuotaResume.js'

type ThreadStatusDependencies = {
  quotaResume: Pick<ThreadQuotaResume, 'set' | 'snapshot'>
  interruptions: Pick<ThreadInterruptionList, 'snapshot' | 'publish'>
  ignoredErrors: Pick<IgnoredQuotaErrors, 'set' | 'list'>
  sidebarStatus: Pick<SidebarThreadStatusReader, 'snapshot'>
  goals: Pick<ThreadGoalReader, 'snapshot'>
  notifyErrorIgnored: (threadId: string) => void
}

export function createThreadStatusService(dependencies: ThreadStatusDependencies) {
  const { quotaResume, interruptions, ignoredErrors, sidebarStatus, goals, notifyErrorIgnored } = dependencies

  async function setQuotaResume(threadId: string, enabled: boolean) {
    await quotaResume.set(threadId, enabled)
    return quotaResume.snapshot()
  }

  async function setErrorIgnored(threadId: string, turnId: string, ignored: boolean) {
    await ignoredErrors.set(threadId, turnId, ignored)
    await interruptions.publish(threadId)
    notifyErrorIgnored(threadId)
    return ignoredErrors.list(threadId)
  }

  return {
    readQuotaResume: () => quotaResume.snapshot(),
    setQuotaResume,
    readInterruptions: () => interruptions.snapshot(),
    readIgnoredErrors: (threadId: string) => ignoredErrors.list(threadId),
    setErrorIgnored,
    readSidebarStatus: (threadIds: string[], versions: Record<string, string>) => sidebarStatus.snapshot(threadIds, versions),
    readGoals: (threadIds: string[], refreshId: string) => goals.snapshot(threadIds, refreshId),
  }
}
