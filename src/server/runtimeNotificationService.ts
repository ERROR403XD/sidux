import { asRecord } from './httpUtils.js'
import { readNonEmptyString } from './runtimePaths.js'
import type { AutomationEngine } from './automationEngine.js'
import type { ProcessActivityStore } from './processActivityStore.js'
import type { ThreadCompletionList } from './threadCompletionList.js'
import type { ThreadCompactionGate } from './threadCompactionGate.js'
import type { ThreadGoalReader } from './threadGoalReader.js'
import type { ThreadInterruptionList } from './threadInterruptionList.js'
import type { ThreadQuotaResume } from './threadQuotaResume.js'
import type { ThreadScheduledResume } from './threadScheduledResume.js'

type RuntimeNotificationDependencies = {
  completions: Pick<ThreadCompletionList, 'complete'>
  interruptions: Pick<ThreadInterruptionList, 'observe'>
  quotaResume: Pick<ThreadQuotaResume, 'observe'>
  scheduledResume?: Pick<ThreadScheduledResume, 'observe'>
  observeAccountQuota: (params: unknown) => Promise<void>
  automationEngine: Pick<AutomationEngine, 'notification'>
  threadGoalReader: Pick<ThreadGoalReader, 'observe'>
  threadCompactionGate: Pick<ThreadCompactionGate, 'observe'>
  processActivity: Pick<ProcessActivityStore, 'observe'>
}

export function createRuntimeNotificationObserver(dependencies: RuntimeNotificationDependencies) {
  const { completions, interruptions, quotaResume, observeAccountQuota, automationEngine, threadGoalReader, threadCompactionGate, processActivity } = dependencies
  return (notification: { method: string; params: unknown }) => {
    if (notification.method === 'turn/completed') {
      const params = asRecord(notification.params)
      const threadId = readNonEmptyString(params?.threadId)
      const turnId = readNonEmptyString(asRecord(params?.turn)?.id) || readNonEmptyString(params?.turnId)
      const completion = params?.completionKind === 'background'
        ? completions.complete(threadId, turnId, 'background')
        : completions.complete(threadId, turnId)
      void completion.catch(() => console.error('Failed to persist completion list'))
    }
    if (['turn/started', 'turn/completed', 'turn/cancelled', 'error', 'thread/status/changed'].includes(notification.method)) {
      void interruptions.observe(notification.method, notification.params).catch(() => console.error('Failed to persist conversation problem indicators'))
    }
    quotaResume.observe(notification)
    dependencies.scheduledResume?.observe(notification)
    if (notification.method === 'account/rateLimits/updated') void observeAccountQuota(notification.params).catch(() => undefined)
    automationEngine.notification(notification)
    threadGoalReader.observe(notification)
    threadCompactionGate.observe(notification)
    processActivity.observe(notification)
  }
}
