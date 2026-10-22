import type { RpcNotification } from '../api/codexRpcClient'

type ThreadEventSyncStateOptions = {
  delayMs: number
  hasPendingMessageThreadIds: () => boolean
  takePendingMessageThreadIds: () => string[]
  isBusy: () => boolean
  run: () => Promise<void> | void
  scheduleTimeout: (callback: () => void, delay: number) => number
  cancelTimeout: (timer: number) => void
}

type ThreadEventSyncRequest = {
  threadIds: string[]
  refreshThreads: boolean
  forceThreads: boolean
}

function shouldRefreshMessages(method: string): boolean {
  return method === 'turn/started' ||
    method === 'turn/completed' ||
    method === 'turn/cancelled' ||
    method === 'thread/status/changed' ||
    method === 'error'
}

function shouldRefreshThreads(method: string): boolean {
  return method === 'thread/name/updated' || method === 'turn/completed'
}

export function createThreadEventSyncState({
  delayMs,
  hasPendingMessageThreadIds,
  takePendingMessageThreadIds,
  isBusy,
  run,
  scheduleTimeout,
  cancelTimeout,
}: ThreadEventSyncStateOptions) {
  let pendingThreadsRefresh = false
  let pendingThreadsRefreshForce = false
  let eventSyncTimer: number | null = null
  let active = true
  let lifecycleGeneration = 0

  function hasPendingWork(): boolean {
    return pendingThreadsRefresh || hasPendingMessageThreadIds()
  }

  function schedule(): void {
    if (!active || eventSyncTimer !== null || isBusy()) return
    const generation = lifecycleGeneration
    eventSyncTimer = scheduleTimeout(() => {
      if (!active || generation !== lifecycleGeneration) return
      eventSyncTimer = null
      void run()
    }, delayMs)
  }

  function clearPending(): void {
    pendingThreadsRefresh = false
    pendingThreadsRefreshForce = false
  }

  return {
    queue: (notification: RpcNotification, markMessagesDirty: (threadId: string | null) => void, extractThreadId: () => string | null) => {
      if (!active) return
      if (notification.method === 'thread/tokenUsage/updated' || notification.method.startsWith('thread/goal/')) return
      const method = notification.method
      const shouldMarkMessages = shouldRefreshMessages(method)
      const shouldRefresh = shouldRefreshThreads(method)
      if (!shouldMarkMessages && !shouldRefresh) return
      if (shouldMarkMessages) markMessagesDirty(extractThreadId())
      if (shouldRefresh) {
        pendingThreadsRefresh = true
        pendingThreadsRefreshForce = true
      }
      schedule()
    },
    markBridgeRecovery: (reconnected: boolean, threadsLoaded: boolean) => {
      if (!active) return
      pendingThreadsRefresh ||= reconnected || !threadsLoaded
      pendingThreadsRefreshForce ||= reconnected
    },
    markThreadsDirty: () => {
      if (!active) return
      pendingThreadsRefresh = true
    },
    schedule,
    take: (): ThreadEventSyncRequest => {
      const request = {
        threadIds: takePendingMessageThreadIds(),
        refreshThreads: pendingThreadsRefresh,
        forceThreads: pendingThreadsRefreshForce,
      }
      clearPending()
      return request
    },
    clearPending,
    start: () => {
      active = true
    },
    stop: () => {
      active = false
      lifecycleGeneration++
      if (eventSyncTimer !== null) cancelTimeout(eventSyncTimer)
      eventSyncTimer = null
      clearPending()
    },
    get hasPendingWork() {
      return hasPendingWork()
    },
  }
}
