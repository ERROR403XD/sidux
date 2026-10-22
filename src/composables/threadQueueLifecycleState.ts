import type { ThreadQueueOperation, ThreadQueueResult, ThreadQueueState } from '../threadQueue'
import type { DeliveryPreparationGuard } from '../api/deliveryOutbox'

type ThreadQueueLifecycleStateOptions = {
  getQueueState: () => Promise<ThreadQueueState>
  mutateQueueState: (operation: ThreadQueueOperation, options?: { canPrepare?: DeliveryPreparationGuard }) => Promise<ThreadQueueResult>
  applyQueueState: (state: ThreadQueueState) => void
  markRemoved: (messageId: string) => void
  markMutationSucceeded: (operation: ThreadQueueOperation, result: ThreadQueueResult) => void
  markMutationFailed: (operation: ThreadQueueOperation, cause: unknown) => void
  scheduleTimeout: (callback: () => void, delay: number) => number
  cancelTimeout: (timer: number) => void
  delayMs?: number
}


export function createThreadQueueLifecycleState({
  getQueueState,
  mutateQueueState,
  applyQueueState,
  markRemoved,
  markMutationSucceeded,
  markMutationFailed,
  scheduleTimeout,
  cancelTimeout,
  delayMs = 650,
}: ThreadQueueLifecycleStateOptions) {
  let mutationChain: Promise<unknown> = Promise.resolve()
  let requestGeneration = 0
  let lifecycleGeneration = 0
  let active = true
  let hasLoadedPersistedState = false
  const refreshTimers = new Set<number>()

  function invalidate(): void {
    lifecycleGeneration += 1
    requestGeneration += 1
    hasLoadedPersistedState = false
    for (const timer of refreshTimers) cancelTimeout(timer)
    refreshTimers.clear()
  }

  async function runRefresh(): Promise<boolean> {
    if (!active) return false
    const generation = ++requestGeneration
    const lifecycle = lifecycleGeneration
    await mutationChain
    if (!active || lifecycle !== lifecycleGeneration || generation !== requestGeneration) return false
    try {
      const state = await getQueueState()
      if (!active || lifecycle !== lifecycleGeneration || generation !== requestGeneration) return false
      applyQueueState(state)
      return true
    } catch (cause) {
      if (!active || lifecycle !== lifecycleGeneration || generation !== requestGeneration) return false
      throw cause
    }
  }

  return {
    captureContext: (): (() => boolean) => {
      const lifecycle = lifecycleGeneration
      return () => active && lifecycle === lifecycleGeneration
    },
    invalidateForAccountChange: invalidate,
    refresh: async (): Promise<void> => { await runRefresh() },
    runMutation: (operation: ThreadQueueOperation, canPrepare?: DeliveryPreparationGuard): Promise<ThreadQueueResult> => {
      requestGeneration += 1
      const lifecycle = lifecycleGeneration
      const admittedWhileActive = active
      // Capture admission before waiting for earlier intents, not after the account changes.
      const preparationOptions = operation.type === 'add'
        ? { canPrepare: () => admittedWhileActive && active && lifecycle === lifecycleGeneration && (canPrepare?.() ?? true) }
        : undefined
      const pending = mutationChain.then(async () => {
        try {
          const result = preparationOptions
            ? await mutateQueueState(operation, preparationOptions)
            : await mutateQueueState(operation)
          if (active && lifecycle === lifecycleGeneration) {
            applyQueueState(result.state)
            if (result.removed) markRemoved(result.removed.id)
            markMutationSucceeded(operation, result)
          }
          return result
        } catch (cause) {
          if (active && lifecycle === lifecycleGeneration) markMutationFailed(operation, cause)
          throw cause
        }
      })
      mutationChain = pending.catch(() => {})
      return pending
    },
    loadPersistedStateIfNeeded: async (): Promise<void> => {
      if (hasLoadedPersistedState) return
      try {
        if (await runRefresh()) hasLoadedPersistedState = true
      } catch {
        // Retry at the next refresh; a temporary read failure must not erase queues.
      }
    },
    scheduleRefresh: (threadId: string, process: (threadId: string) => Promise<void>): void => {
      if (!active) return
      const lifecycle = lifecycleGeneration
      void process(threadId)
      const callback = () => {
        if (!active || lifecycle !== lifecycleGeneration) return
        refreshTimers.delete(timer)
        void process(threadId)
      }
      const timer = scheduleTimeout(callback, delayMs)
      refreshTimers.add(timer)
    },
    stop: (): void => {
      active = false
      // Preserve accepted intents and their order; stop only detaches their UI results.
      invalidate()
    },
    start: (): void => {
      active = true
    },
  }
}
