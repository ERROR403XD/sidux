import { subscribeRpcNotifications, type RpcNotification } from '../api/codexRpcClient'
import { observeTaskNotification } from '../subtasks'
import { automaticResumeStartedMethod } from '../threadAutomaticResume'

type ThreadSubscriptionControllerOptions = {
  pending: { load: () => Promise<void> }
  completion: { load: () => Promise<void>; handleChange: (params: unknown) => void }
  queue: { refresh: () => Promise<void> }
  model: { resetCatalog: () => void; refresh: () => Promise<void> }
  quota: { invalidateCache: () => void; refresh: () => Promise<void> }
  status: { clearTransientErrors: () => void }
  realtime: { handle: (notification: RpcNotification) => void }
  notifyBrowser?: (notification: RpcNotification) => void
  synchronization: {
    recover: (reconnected: boolean) => Promise<void>
    queue: (notification: RpcNotification) => void
  }
}

export function createThreadSubscriptionController({
  pending, completion, queue, model, quota, status, realtime, synchronization, notifyBrowser,
}: ThreadSubscriptionControllerOptions) {
  let stopNotificationStream: (() => void) | null = null
  let notificationLifecycleRevision = 0

  function start(): void {
    if (typeof window === 'undefined' || stopNotificationStream) return
    void pending.load()
    let notificationReady = false
    const lifecycleRevision = notificationLifecycleRevision
    stopNotificationStream = subscribeRpcNotifications((notification) => {
      if (lifecycleRevision !== notificationLifecycleRevision) return
      notifyBrowser?.(notification)
      if (notification.method === automaticResumeStartedMethod) return
      if (notification.method === 'codexapp/completions/changed') {
        completion.handleChange(notification.params)
        return
      }
      if (notification.method === 'codexapp/queue/changed') {
        void queue.refresh().catch(() => {})
        return
      }
      if (notification.method === 'ready') {
        void completion.load()
        const reconnected = notificationReady
        if (notificationReady) {
          observeTaskNotification({ method: 'codexapp/reconnected', params: {} })
          model.resetCatalog()
          quota.invalidateCache()
          void model.refresh()
          void quota.refresh()
        }
        notificationReady = true
        status.clearTransientErrors()
        // Queue pushes omit tokens and missed pushes are not replayed after disconnect.
        void queue.refresh().catch(() => {})
        void synchronization.recover(reconnected)
        return
      }
      realtime.handle(notification)
      synchronization.queue(notification)
    })
  }

  function invalidate(): void {
    notificationLifecycleRevision += 1
  }

  // Isolate callbacks before peer teardown, then release transport in its original order.
  function close(): void {
    if (stopNotificationStream) {
      stopNotificationStream()
      stopNotificationStream = null
    }
  }

  return { start, invalidate, close, isStarted: () => stopNotificationStream !== null }
}
