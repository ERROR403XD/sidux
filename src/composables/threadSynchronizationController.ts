import type { RpcNotification } from '../api/codexRpcClient'
import { createThreadEventSyncState } from './threadEventSyncState'

type ThreadSynchronizationControllerOptions = {
  getAccountRevision: () => number
  getSelectedThreadId: () => string
  isInProgress: (threadId: string) => boolean
  list: {
    hasLoaded: () => boolean
    getVersion: (threadId: string) => string
    load: (options: { force: boolean }) => Promise<void>
  }
  history: {
    getPendingThreadIds: () => string[]
    takePendingThreadIds: () => string[]
    markDirty: (threadId: string) => void
    isLoaded: (threadId: string) => boolean
    getLoadedVersion: (threadId: string) => string
    load: (threadId: string, options: { silent: boolean }) => Promise<void>
  }
  loadPendingServerRequests: () => Promise<void>
  extractThreadId: (notification: RpcNotification) => string
  delayMs: number
  scheduleTimeout: (callback: () => void, delay: number) => number
  cancelTimeout: (timer: number) => void
}

export function createThreadSynchronizationController({
  getAccountRevision,
  getSelectedThreadId,
  isInProgress,
  list,
  history,
  loadPendingServerRequests,
  extractThreadId,
  delayMs,
  scheduleTimeout,
  cancelTimeout,
}: ThreadSynchronizationControllerOptions) {
  let busy = false
  let synchronizationLifecycleRevision = 0
  const events = createThreadEventSyncState({
    delayMs,
    hasPendingMessageThreadIds: () => history.getPendingThreadIds().length > 0,
    takePendingMessageThreadIds: history.takePendingThreadIds,
    isBusy: () => busy,
    run: syncFromNotifications,
    scheduleTimeout,
    cancelTimeout,
  })

  async function syncFromNotifications(): Promise<void> {
    if (busy) {
      events.schedule()
      return
    }
    busy = true
    const identityRevision = getAccountRevision()
    const lifecycleRevision = synchronizationLifecycleRevision
    const isCurrent = () => identityRevision === getAccountRevision() && lifecycleRevision === synchronizationLifecycleRevision
    const { threadIds: pendingThreadIds, refreshThreads: shouldRefreshThreads, forceThreads: shouldForceThreadRefresh } = events.take()
    const threadIdsToRefresh = new Set(pendingThreadIds)

    try {
      if (shouldRefreshThreads) {
        await list.load({ force: shouldForceThreadRefresh })
      }
      if (!isCurrent()) return

      const activeThreadId = getSelectedThreadId()
      if (!activeThreadId) return
      const isActiveDirty = threadIdsToRefresh.has(activeThreadId)
      const threadIsInProgress = isInProgress(activeThreadId)
      const currentVersion = list.getVersion(activeThreadId)
      const loadedVersion = history.getLoadedVersion(activeThreadId)
      const hasVersionChange = currentVersion.length > 0 && currentVersion !== loadedVersion

      const shouldRefreshActiveThread =
        hasVersionChange ||
        isActiveDirty ||
        (threadIsInProgress && !history.isLoaded(activeThreadId)) ||
        (shouldRefreshThreads && !history.isLoaded(activeThreadId))

      if (shouldRefreshActiveThread) {
        await history.load(activeThreadId, { silent: true })
      }
    } catch {
      // A transient sync failure leaves the last committed view available.
    } finally {
      if (isCurrent()) {
        busy = false
        if (events.hasPendingWork) events.schedule()
      }
    }
  }

  async function recoverBridgeState(reconnected = false): Promise<void> {
    const identityRevision = getAccountRevision()
    const lifecycleRevision = synchronizationLifecycleRevision
    await loadPendingServerRequests()
    if (identityRevision !== getAccountRevision() || lifecycleRevision !== synchronizationLifecycleRevision) return
    events.markBridgeRecovery(reconnected, list.hasLoaded())
    if (getSelectedThreadId() && (reconnected || !history.isLoaded(getSelectedThreadId()))) {
      history.markDirty(getSelectedThreadId())
    }
    await syncFromNotifications()
  }

  return {
    syncFromNotifications,
    recoverBridgeState,
    queue: (notification: RpcNotification) => {
      events.queue(notification, threadId => {
        if (threadId) history.markDirty(threadId)
      }, () => extractThreadId(notification))
    },
    schedule: events.schedule,
    markThreadsDirty: events.markThreadsDirty,
    start: events.start,
    invalidateForAccountChange: () => {
      synchronizationLifecycleRevision++
      busy = false
    },
    stop: () => {
      synchronizationLifecycleRevision++
      busy = false
      events.stop()
    },
  }
}
