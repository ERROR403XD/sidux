import { computed, ref } from 'vue'
import {
  getOlderThreadMessages,
  getThreadDetail,
  type ThreadHistoryPosition,
} from '../api/threadReadGateway'
import { bindMessageTurnOrder, mergeTurnOrder, orderedTurnIds } from '../historyOrder'
import {
  areMessageArraysEqual,
  hasOptimisticUserMessages,
  mergeMessages,
  removeRedundantLiveAgentMessages,
} from '../messageIdentity'
import type { UiMessage, UiThread } from '../types/codex'
import { createThreadHistoryRequestState } from './threadHistoryRequestState'
import { createThreadHistoryState } from './threadHistoryState'
import { createThreadLoadedState } from './threadLoadedState'
import { createThreadOlderPageState } from './threadOlderPageState'
import { pruneThreadContextStateMap } from './threadContextState'

type ThreadHistoryControllerOptions = {
  getAccountRevision: () => number
  getSelectedThreadId: () => string
  getThreadVersion: (threadId: string) => string
  reuseMs: number
  metadata: {
    setProvider: (threadId: string, provider: string) => void
    setModel: (threadId: string, model: string, provider: string) => void
  }
  status: {
    isInProgress: (threadId: string) => boolean
    setInProgress: (threadId: string, inProgress: boolean) => void
    hasTransientError: (threadId: string) => boolean
    setTransientError: (threadId: string, message: string) => void
    clearTransientError: (threadId: string) => void
    setPageError: (message: string) => void
  }
  turns: {
    getLookup: (threadId: string) => Record<string, number>
    replaceLookup: (threadId: string, lookup: Record<string, number>) => void
    markMessagesPersisted: (threadId: string, messages: UiMessage[]) => void
    rebindLiveFileChanges: (threadId: string) => void
    getActiveTurnId: (threadId: string) => string | undefined
    setActiveTurnId: (threadId: string, turnId: string) => void
    clearActiveTurn: (threadId: string) => void
  }
  live: {
    getAgentMessages: (threadId: string) => readonly Readonly<UiMessage>[]
    setAgentMessages: (threadId: string, messages: readonly UiMessage[]) => void
    clearAgentMessages: (threadId: string) => void
    removePersistedCommands: (threadId: string, messages: UiMessage[]) => void
    removePersistedFileChanges: (threadId: string, messages: UiMessage[]) => void
    clearCompleted: (threadId: string) => void
  }
  deliveries: {
    refresh: () => void
    refreshReceipts: (threadId: string) => Promise<void>
    observe: (threadId: string, messages: readonly UiMessage[]) => void
  }
  scheduleEventSync: () => void
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

function pruneThreadStateMap<T>(record: Record<string, T>, threadIds: Set<string>): Record<string, T> {
  const entries = Object.entries(record).filter(([threadId]) => threadIds.has(threadId))
  return entries.length === Object.keys(record).length ? record : Object.fromEntries(entries)
}

export function createThreadHistoryController({
  getAccountRevision,
  getSelectedThreadId,
  getThreadVersion,
  reuseMs,
  metadata,
  status,
  turns,
  live,
  deliveries,
  scheduleEventSync,
}: ThreadHistoryControllerOptions) {
  const snapshotThreads = ref<Record<string, UiThread>>({})
  const persistedMessagesByThreadId = ref<Record<string, UiMessage[]>>({})
  const loadedVersionByThreadId = ref<Record<string, string>>({})
  const loadedMessagesByThreadId = ref<Record<string, boolean>>({})
  const loadingMessagesByThreadId = ref<Record<string, boolean>>({})
  const historyPositionByThreadId = ref<Record<string, ThreadHistoryPosition>>({})
  const hasMoreOlderMessagesByThreadId = ref<Record<string, boolean>>({})
  const loadingOlderMessagesByThreadId = ref<Record<string, boolean>>({})
  const resumedThreadById = ref<Record<string, boolean>>({})
  const lastMessageLoadAtByThreadId = new Map<string, number>()
  const lastMessageLoadFailureAtByThreadId = new Map<string, number>()
  let messageLoadLifecycleRevision = 0
  const threadHistoryState = createThreadHistoryState()
  const threadLoadedState = createThreadLoadedState({ loadedByThreadId: loadedMessagesByThreadId })
  const threadOlderPageState = createThreadOlderPageState({
    hasMoreByThreadId: hasMoreOlderMessagesByThreadId,
    loadingByThreadId: loadingOlderMessagesByThreadId,
  })
  const threadHistoryRequestState = createThreadHistoryRequestState({
    getAccountRevision,
    getLifecycleRevision: () => messageLoadLifecycleRevision,
  })

  // Request, identity validation and snapshot commit stay inside this owner.
  // Cross-domain ports receive commands, never writable history refs.

  function setPersistedMessagesForThread(threadId: string, nextMessages: readonly UiMessage[]): void {
    deliveries.observe(threadId, nextMessages)
    const failedCompactionTurns = new Set(nextMessages.filter(message => message.compaction?.status === 'failed' && message.id === `${message.turnId}-compaction`).map(message => message.turnId))
    if (failedCompactionTurns.size) nextMessages = nextMessages.filter(message => !failedCompactionTurns.has(message.turnId)
      || (message.messageType !== 'turnError' && (message.compaction?.status !== 'failed' || message.id === `${message.turnId}-compaction`)))
    const orderedMessages = bindMessageTurnOrder(nextMessages, turns.getLookup(threadId))
    const previous = persistedMessagesByThreadId.value[threadId] ?? []
    if (areMessageArraysEqual(previous, orderedMessages)) return
    persistedMessagesByThreadId.value = {
      ...persistedMessagesByThreadId.value,
      [threadId]: orderedMessages,
    }
  }

  function getFirstPersistedTurnId(threadId: string): string {
    const persisted = persistedMessagesByThreadId.value[threadId] ?? []
    for (const message of persisted) {
      const turnId = message.turnId?.trim() ?? ''
      if (turnId) return turnId
    }
    return ''
  }

  async function loadMessages(threadId: string, options: { silent?: boolean; retry?: boolean } = {}) {
    if (!threadId) {
      return
    }
    deliveries.refresh()
    void deliveries.refreshReceipts(threadId)
    const recentLoadFailure =
      Date.now() - (lastMessageLoadFailureAtByThreadId.get(threadId) ?? 0) < reuseMs
    if (!options.retry && status.hasTransientError(threadId) && (options.silent === true || recentLoadFailure)) {
      return
    }

    await threadHistoryRequestState.loadHistory(threadId, async () => {
      const identityRevision = getAccountRevision()
      const lifecycleRevision = messageLoadLifecycleRevision
      const isCurrent = () => identityRevision === getAccountRevision() && lifecycleRevision === messageLoadLifecycleRevision
      const requestedRevision = threadHistoryState.getRevision(threadId)
      const alreadyLoaded = threadLoadedState.isLoaded(threadId)
      const shouldShowLoading = options.silent !== true && !alreadyLoaded
      let loadedSnapshot = false
      if (shouldShowLoading) {
        loadingMessagesByThreadId.value = { ...loadingMessagesByThreadId.value, [threadId]: true }
      }
      try {
        const version = getThreadVersion(threadId)
        const loadedVersion = loadedVersionByThreadId.value[threadId] ?? ''
        const loadedRecently =
          Date.now() - (lastMessageLoadAtByThreadId.get(threadId) ?? 0) < reuseMs
        const canReuseLoadedMessages =
          alreadyLoaded && !status.hasTransientError(threadId) &&
          requestedRevision === threadHistoryState.getLoadedRevision(threadId) &&
          (
            loadedRecently ||
            (
              (version.length === 0 || loadedVersion === version) &&
              !status.isInProgress(threadId)
            )
          )

        if (canReuseLoadedMessages) {
          return
        }

        // Viewing is read-only. Resume only when a message is actually submitted.
        const detail = await getThreadDetail(threadId)
        if (!isCurrent()) return
        if (detail.thread) snapshotThreads.value = { ...snapshotThreads.value, [threadId]: detail.thread }

        if (detail.modelProvider && resumedThreadById.value[threadId] !== true) {
          metadata.setProvider(threadId, detail.modelProvider)
        }
        if (detail.model) {
          metadata.setModel(threadId, detail.model, detail.modelProvider)
        }
        const { messages: nextMessages, inProgress, activeTurnId, turnIndexByTurnId } = detail
        const previousLookup = turns.getLookup(threadId)
        const firstLoaded = orderedTurnIds(previousLookup)[0]
        const keepOlder = alreadyLoaded && !!firstLoaded && !(firstLoaded in turnIndexByTurnId)
        if (!keepOlder) {
          threadOlderPageState.setHasMore(threadId, detail.hasMoreOlder === true)
          if (detail.historyPosition) historyPositionByThreadId.value = { ...historyPositionByThreadId.value, [threadId]: detail.historyPosition }
        }
        turns.markMessagesPersisted(threadId, nextMessages)
        turns.replaceLookup(threadId, mergeTurnOrder(previousLookup, turnIndexByTurnId))
        turns.rebindLiveFileChanges(threadId)
        const previousPersisted = persistedMessagesByThreadId.value[threadId] ?? []
        const mergedMessages = mergeMessages(previousPersisted, nextMessages, {
          preserveMissing: alreadyLoaded || options.silent === true || hasOptimisticUserMessages(previousPersisted),
        })
        setPersistedMessagesForThread(threadId, mergedMessages)

        const previousLiveAgent = live.getAgentMessages(threadId)
        if (inProgress || requestedRevision !== threadHistoryState.getRevision(threadId)) {
          const nextLiveAgent = removeRedundantLiveAgentMessages(previousLiveAgent, nextMessages)
          live.setAgentMessages(threadId, nextLiveAgent)
        } else {
          live.clearAgentMessages(threadId)
        }
        live.removePersistedCommands(threadId, nextMessages)
        live.removePersistedFileChanges(threadId, nextMessages)

        threadLoadedState.markLoaded(threadId)
        loadedSnapshot = true
        threadHistoryState.setLoadedRevision(threadId, requestedRevision)
        lastMessageLoadAtByThreadId.set(threadId, Date.now())
        lastMessageLoadFailureAtByThreadId.delete(threadId)

        if (version) {
          loadedVersionByThreadId.value = {
            ...loadedVersionByThreadId.value,
            [threadId]: version,
          }
        }
        const snapshotIsCurrent = requestedRevision === threadHistoryState.getRevision(threadId)
        if (snapshotIsCurrent) status.setInProgress(threadId, inProgress)
        status.clearTransientError(threadId)
        if (snapshotIsCurrent && activeTurnId) {
          turns.setActiveTurnId(threadId, activeTurnId)
        } else if (snapshotIsCurrent && turns.getActiveTurnId(threadId)) {
          turns.clearActiveTurn(threadId)
        }
        if (snapshotIsCurrent && !inProgress) {
          live.clearCompleted(threadId)
        }
      } catch (unknownError) {
        if (!isCurrent()) return
        const message = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
        if (getSelectedThreadId() === threadId) {
          status.setTransientError(threadId, message)
        }
        lastMessageLoadFailureAtByThreadId.set(threadId, Date.now())
        throw unknownError
      } finally {
        if (isCurrent()) {
          if (shouldShowLoading) {
            loadingMessagesByThreadId.value = omitKey(loadingMessagesByThreadId.value, threadId)
          }
          if (loadedSnapshot && requestedRevision !== threadHistoryState.getRevision(threadId)
            && getSelectedThreadId() === threadId && typeof window !== 'undefined') {
            threadHistoryState.queueRefresh(threadId)
            scheduleEventSync()
          }
        }
      }
      return undefined
    })
  }

  async function loadOlderMessages(threadId: string = getSelectedThreadId()): Promise<void> {
    if (!threadId) return
    if (!threadOlderPageState.begin(threadId)) return

    const beforeTurnId = orderedTurnIds(turns.getLookup(threadId))[0] || getFirstPersistedTurnId(threadId)
    if (!beforeTurnId) {
      threadOlderPageState.complete(threadId, false)
      threadOlderPageState.finish(threadId)
      return
    }

    const identityRevision = getAccountRevision()
    const lifecycleRevision = messageLoadLifecycleRevision
    const isCurrent = () => identityRevision === getAccountRevision() && lifecycleRevision === messageLoadLifecycleRevision

    try {
      const page = await getOlderThreadMessages(threadId, beforeTurnId, undefined, historyPositionByThreadId.value[threadId])
      if (!isCurrent()) return
      const previousPersisted = persistedMessagesByThreadId.value[threadId] ?? []
      const mergedMessages = mergeMessages(page.messages, previousPersisted, { preserveMissing: true })
      turns.replaceLookup(threadId, mergeTurnOrder(turns.getLookup(threadId), page.turnIndexByTurnId, true))
      setPersistedMessagesForThread(threadId, mergedMessages)
      if (page.historyPosition) historyPositionByThreadId.value = { ...historyPositionByThreadId.value, [threadId]: page.historyPosition }
      turns.rebindLiveFileChanges(threadId)
      threadOlderPageState.complete(threadId, page.hasMoreOlder)
    } catch (loadError) {
      if (!isCurrent()) return
      status.setPageError(loadError instanceof Error ? loadError.message : 'Failed to load earlier messages')
      throw loadError
    } finally {
      if (isCurrent()) threadOlderPageState.finish(threadId)
    }
  }

  async function ensureThreadMessagesLoaded(threadId: string, options: { silent?: boolean } = {}): Promise<void> {
    if (!threadId) return
    if (threadLoadedState.isLoaded(threadId)) return
    if (options.silent === true && status.hasTransientError(threadId)) return
    await loadMessages(threadId, options)
  }

  function markResumed(threadId: string): void {
    resumedThreadById.value = { ...resumedThreadById.value, [threadId]: true }
  }

  function invalidateForAccountChange(additionalThreadIds: Iterable<string>): void {
    threadOlderPageState.resetLoading()
    const ids = new Set([...Object.keys(loadedMessagesByThreadId.value), ...threadHistoryRequestState.threadIds, ...additionalThreadIds])
    const resumed = { ...resumedThreadById.value }
    for (const id of ids) {
      if (!id || status.isInProgress(id)) continue
      delete resumed[id]
      threadHistoryState.invalidateForAccountChange([id])
      lastMessageLoadFailureAtByThreadId.delete(id)
      status.clearTransientError(id)
    }
    resumedThreadById.value = resumed
  }

  function invalidateForRollback(threadId: string): void {
    historyPositionByThreadId.value = omitKey(historyPositionByThreadId.value, threadId)
    threadOlderPageState.setHasMore(threadId, false)
    lastMessageLoadAtByThreadId.delete(threadId)
    threadLoadedState.clear(threadId)
  }

  function prune(activeThreadIds: Set<string>): void {
    threadLoadedState.prune(activeThreadIds)
    threadHistoryState.prune(activeThreadIds)
    loadedVersionByThreadId.value = pruneThreadStateMap(loadedVersionByThreadId.value, activeThreadIds)
    resumedThreadById.value = pruneThreadStateMap(resumedThreadById.value, activeThreadIds)
    historyPositionByThreadId.value = pruneThreadStateMap(historyPositionByThreadId.value, activeThreadIds)
    persistedMessagesByThreadId.value = pruneThreadStateMap(persistedMessagesByThreadId.value, activeThreadIds)
  }

  function stop(): void {
    messageLoadLifecycleRevision++
    threadOlderPageState.reset()
    threadLoadedState.reset()
    loadedVersionByThreadId.value = {}
    lastMessageLoadAtByThreadId.clear()
    lastMessageLoadFailureAtByThreadId.clear()
    persistedMessagesByThreadId.value = {}
    historyPositionByThreadId.value = {}
    loadingMessagesByThreadId.value = {}
  }

  return {
    getSnapshot: (threadId: string): UiThread | undefined => snapshotThreads.value[threadId],
    pruneSnapshots: (threadIds: Set<string>): void => {
      snapshotThreads.value = pruneThreadContextStateMap(snapshotThreads.value, threadIds)
    },
    resetSnapshots: (): void => { snapshotThreads.value = {} },
    persistedMessagesByThreadId: computed<Readonly<Record<string, readonly Readonly<UiMessage>[]>>>(() => persistedMessagesByThreadId.value),
    loadingMessagesByThreadId: computed<Readonly<Record<string, boolean>>>(() => loadingMessagesByThreadId.value),
    hasMoreOlderMessagesByThreadId: computed<Readonly<Record<string, boolean>>>(() => hasMoreOlderMessagesByThreadId.value),
    loadingOlderMessagesByThreadId: computed<Readonly<Record<string, boolean>>>(() => loadingOlderMessagesByThreadId.value),
    history: {
      markDirty: threadHistoryState.markDirty,
      getRevision: threadHistoryState.getRevision,
      takePendingThreadIds: threadHistoryState.takePendingThreadIds,
      get pendingThreadIds() {
        return threadHistoryState.pendingThreadIds
      },
    },
    isLoaded: threadLoadedState.isLoaded,
    getLoadedVersion: (threadId: string) => loadedVersionByThreadId.value[threadId] ?? '',
    isResumed: (threadId: string) => resumedThreadById.value[threadId] === true,
    markResumed,
    setPersistedMessagesForThread,
    loadMessages,
    loadOlderMessages,
    ensureThreadMessagesLoaded,
    invalidateForAccountChange,
    invalidateForRollback,
    prune,
    stop,
  }
}
