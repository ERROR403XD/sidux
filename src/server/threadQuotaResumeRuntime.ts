import type { AppServerProcess } from './appServerProcess.js'
import type { BackendQueueProcessor } from './backendQueueRuntime.js'
import type { DeliveryService } from './deliveryService.js'
import type { DeliveryStore } from './deliveryStore.js'
import type { ThreadHistory } from './threadHistory.js'
import { getAccountAuthCoordinator, type AccountAuthCoordinator } from './accountAuthCoordinator.js'
import { asRecord } from './httpUtils.js'
import { readNonEmptyString } from './runtimePaths.js'
import { ThreadQuotaResume } from './threadQuotaResume.js'

type QuotaResumeProcess = Pick<AppServerProcess, 'taskAccountBusy' | 'notifyQuotaResumeChanged' | 'notifyAccountQuota'> & {
  listPendingServerRequests: () => Array<{ params: unknown }>
}
type QuotaResumeQueue = Pick<BackendQueueProcessor, 'readState' | 'buildQueuedTurnParams' | 'submit' | 'deliveryContext' | 'readContinuationGoal'> & {
  history: Pick<ThreadHistory, 'page'>
  deliveries: Pick<DeliveryService, 'result' | 'reconcile'>
  store: Pick<DeliveryStore, 'remove'>
}
type QuotaResumeCoordinator = Pick<AccountAuthCoordinator, 'blocksNewSubmissions' | 'assertSubmissionAllowed' | 'subscribeQuotaUpdates'> & {
  store: Pick<AccountAuthCoordinator['store'], 'readState'>
}

export function createThreadQuotaResumeRuntime(
  appServer: QuotaResumeProcess,
  queue: QuotaResumeQueue,
  coordinator: () => QuotaResumeCoordinator = getAccountAuthCoordinator,
): ConstructorParameters<typeof ThreadQuotaResume>[1] {
  return {
    inspect: async threadId => {
      const response = asRecord((await queue.history.page(threadId, { limit: 1 })).result)
      const thread = asRecord(response?.thread)
      const turns = Array.isArray(thread?.turns) ? thread.turns : []
      const last = asRecord(turns.at(-1))
      const active = appServer.taskAccountBusy() || Boolean((await queue.readState())[threadId]?.length)
        || ['active', 'running', 'inProgress'].includes(readNonEmptyString(asRecord(thread?.status)?.type) || String(thread?.status))
        || appServer.listPendingServerRequests().some(request => asRecord(request.params)?.threadId === threadId)
      const turnId = readNonEmptyString(last?.id) || null
      const goal = active ? null : await queue.readContinuationGoal(threadId)
      if (goal) {
        return {
          active: goal.status === 'active', turnId,
          status: goal.status === 'usageLimited' ? 'failed' : goal.status === 'complete' ? 'completed' : goal.status,
          error: goal.status === 'usageLimited' ? 'GOAL usage limit' : '',
        }
      }
      return { active, turnId, status: readNonEmptyString(last?.status), error: JSON.stringify(last?.error || '') }
    },
    available: async () => {
      const accountCoordinator = coordinator()
      if (appServer.taskAccountBusy() || accountCoordinator.blocksNewSubmissions()) return false
      const state = await accountCoordinator.store.readState()
      const account = state.accounts.find(row => row.storageId === state.activeStorageId)
      if (!account || account.quotaStatus !== 'ready' || !account.quotaSnapshot || !account.quotaUpdatedAtIso || Date.now() - Date.parse(account.quotaUpdatedAtIso) > 5 * 60_000) return false
      const windows = [account.quotaSnapshot.primary, account.quotaSnapshot.secondary].filter(Boolean)
      if (!windows.length || windows.some(window => window!.usedPercent >= 100)) return false
      try {
        await accountCoordinator.assertSubmissionAllowed(undefined)
        return true
      } catch {
        return false
      }
    },
    submit: async (threadId, id) => {
      const message = { id, continuation: true as const, resumeSource: 'quota' as const, text: '继续之前的工作', imageUrls: [], skills: [], fileAttachments: [], collaborationMode: 'default' as const }
      let params: Record<string, unknown>
      try {
        params = await queue.buildQueuedTurnParams({ threadId, message })
      } catch {
        throw Object.assign(new Error('续跑参数准备未完成，稍后重试'), { retryableQuota: true })
      }
      const result = await queue.submit({ protocol: 2, threadId, message, params, expectedContextId: await queue.deliveryContext() })
      if (result.status === 'failed') {
        const row = await queue.deliveries.result(id)
        if (row && 'message' in row && /额度|限额/.test(row.error || '')) {
          await queue.store.remove(id, row.revision)
          throw Object.assign(new Error('额度仍受限'), { retryableQuota: true })
        }
        throw new Error('续跑准备失败，请核对会话')
      }
      if (result.status === 'unknown') throw new Error('续跑提交结果未确认，请核对会话，避免重复续跑')
    },
    reconcile: async (threadId, id, attemptedAt) => {
      const row = await queue.deliveries.result(id)
      // A recent durable claim with no ledger record failed before submission.
      // Old missing receipts may have expired; never replay those automatically.
      if (!row) {
        return attemptedAt && Date.now() - attemptedAt < 86400_000 ? 'waiting' : 'unknown'
      }
      if (row.threadId !== threadId) return 'unknown'
      if (!('message' in row) || row.status === 'queued' || row.status === 'sending') return 'submitted'
      if (row.status === 'unknown') {
        const reconciled = await queue.deliveries.reconcile(id)
        return reconciled && !('message' in reconciled) ? 'submitted' : 'unknown'
      }
      return 'unknown'
    },
    cancel: async id => {
      const row = await queue.deliveries.result(id)
      if (row && 'message' in row && ['queued', 'editing', 'failed'].includes(row.status)) {
        await queue.store.remove(id, row.revision)
      }
    },
    changed: () => appServer.notifyQuotaResumeChanged(),
  }
}

export function createThreadQuotaResumeService(
  home: string,
  appServer: QuotaResumeProcess,
  queue: QuotaResumeQueue,
  coordinator: () => QuotaResumeCoordinator = getAccountAuthCoordinator,
  automatic = true,
  previousRuntimeStopped: Promise<void> = Promise.resolve(),
) {
  const quotaResume = new ThreadQuotaResume(home, createThreadQuotaResumeRuntime(appServer, queue, coordinator), automatic, previousRuntimeStopped)
  const lastQuotaUsage = new Map<string, number[]>()
  const unsubscribeQuota = coordinator().subscribeQuotaUpdates(account => {
    appServer.notifyAccountQuota(account)
    const usage = [account.quotaSnapshot?.primary?.usedPercent, account.quotaSnapshot?.secondary?.usedPercent]
      .filter((value): value is number => typeof value === 'number')
    const previous = lastQuotaUsage.get(account.storageId)
    lastQuotaUsage.set(account.storageId, usage)
    if (!previous || usage.some((value, index) => value < (previous[index] ?? Infinity))) {
      void quotaResume.tick().catch(() => undefined)
    }
  })
  return { quotaResume, unsubscribeQuota }
}
