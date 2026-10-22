import { computed, ref } from 'vue'
import { normalizeMessageText } from '../messageIdentity'
import { flattenThreads } from '../projectOrganization'
import { areTurnSummariesEqual, type TurnSummaryState } from '../turnSummary'
import type { UiLiveOverlay, UiMessage, UiProjectGroup } from '../types/codex'
import type { TurnActivityState } from './threadRealtimeController'
import { createThreadActiveTurnState } from './threadActiveTurnState'
import { createThreadTurnOrderState } from './threadTurnOrderState'
import { omitKey } from './threadNotificationValues'
import { pruneThreadStateMap } from './threadContextState'

type TurnErrorState = {
  message: string
  transient: boolean
}

type ThreadStatusControllerOptions = {
  getSelectedThreadId: () => string
  getPersistedMessages: (threadId: string) => readonly Readonly<UiMessage>[]
  list: { hasNextPage: () => boolean; scheduleRemainingPages: () => void }
  live: {
    getReasoningText: (threadId: string) => string
    clearPlans: (threadId: string) => void
    clearReasoning: (threadId: string) => void
    clearCommands: (threadId: string) => void
    resetReasoningItem: () => void
  }
  onChanged: () => void
}

function areTurnActivitiesEqual(first?: TurnActivityState, second?: TurnActivityState): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  if (first.label !== second.label) return false
  if (first.details.length !== second.details.length) return false
  for (let index = 0; index < first.details.length; index += 1) {
    if (first.details[index] !== second.details[index]) return false
  }
  return true
}

function sanitizeDisplayText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

export function createThreadStatusController(options: ThreadStatusControllerOptions) {
  const { getSelectedThreadId, getPersistedMessages, list, live, onChanged } = options
  const inProgressById = ref<Record<string, boolean>>({})
  const threadStatusRevision = new Map<string, number>()
  const turnIndexByTurnIdByThreadId = ref<Record<string, Record<string, number>>>({})
  const threadTurnOrderState = createThreadTurnOrderState({ turnIndexByTurnIdByThreadId })
  const turnSummaryByThreadId = ref<Record<string, TurnSummaryState>>({})
  const turnActivityByThreadId = ref<Record<string, TurnActivityState>>({})
  const turnErrorByThreadId = ref<Record<string, TurnErrorState>>({})
  const activeTurnIdByThreadId = ref<Record<string, string>>({})
  const threadActiveTurnState = createThreadActiveTurnState({ turnIdByThreadId: activeTurnIdByThreadId })
  const interruptBlockedUntilPersistedByThreadId = ref<Record<string, boolean>>({})
  const threadListedByServerById = ref<Record<string, boolean>>({})
  const persistedUserMessageByThreadId = ref<Record<string, boolean>>({})
  const isSelectedThreadInterruptPending = computed(() => {
    const threadId = getSelectedThreadId()
    if (!threadId) return false
    return interruptBlockedUntilPersistedByThreadId.value[threadId] === true
  })
  const selectedLiveOverlay = computed<UiLiveOverlay | null>(() => {
    const threadId = getSelectedThreadId()
    if (!threadId) return null

    const isInProgress = inProgressById.value[threadId] === true
    const activity = isInProgress ? turnActivityByThreadId.value[threadId] : undefined
    const reasoningText = isInProgress
      ? live.getReasoningText(threadId).trim()
      : ''
    const liveErrorText = (turnErrorByThreadId.value[threadId]?.message ?? '').trim()
    let latestPersistedTurnErrorText = ''
    if (!isInProgress && liveErrorText) {
      const persistedMessages = getPersistedMessages(threadId)
      for (let index = persistedMessages.length - 1; index >= 0; index -= 1) {
        const message = persistedMessages[index]
        if (message.messageType !== 'turnError') continue
        latestPersistedTurnErrorText = normalizeMessageText(message.text)
        break
      }
    }
    const errorText =
      !isInProgress && liveErrorText && latestPersistedTurnErrorText === liveErrorText
        ? ''
        : liveErrorText

    if (!isInProgress && !activity && !reasoningText && !errorText) return null
    return {
      activityLabel: activity?.label || 'Thinking',
      activityDetails: activity?.details ?? [],
      reasoningText,
      errorText,
    }
  })

  function applyListedStatuses(groups: UiProjectGroup[], revisions: Map<string, number>): void {
    for (const thread of flattenThreads(groups)) {
      if ((revisions.get(thread.id) ?? 0) !== (threadStatusRevision.get(thread.id) ?? 0)) continue
      setThreadInProgress(thread.id, thread.inProgress)
    }
  }

  function setTurnSummaryForThread(threadId: string, summary: TurnSummaryState | null): void {
    if (!threadId) return

    const previous = turnSummaryByThreadId.value[threadId]
    if (summary) {
      if (areTurnSummariesEqual(previous, summary)) return
      turnSummaryByThreadId.value = {
        ...turnSummaryByThreadId.value,
        [threadId]: summary,
      }
    } else {
      if (previous) {
        turnSummaryByThreadId.value = omitKey(turnSummaryByThreadId.value, threadId)
      }
    }
  }

  function setThreadInProgress(threadId: string, nextInProgress: boolean): void {
    if (!threadId) return
    threadStatusRevision.set(threadId, (threadStatusRevision.get(threadId) ?? 0) + 1)
    const currentValue = inProgressById.value[threadId] === true
    if (currentValue === nextInProgress) return
    if (nextInProgress) {
      inProgressById.value = {
        ...inProgressById.value,
        [threadId]: true,
      }
    } else {
      inProgressById.value = omitKey(inProgressById.value, threadId)
      clearCompletedTurnLiveState(threadId)
      clearInterruptPersistenceGate(threadId)
    }
    onChanged()
    if (!nextInProgress && !hasActiveInProgressThreads() && list.hasNextPage()) {
      list.scheduleRemainingPages()
    }
  }

  function clearInterruptPersistenceGate(threadId: string): void {
    if (!threadId) return
    if (interruptBlockedUntilPersistedByThreadId.value[threadId]) {
      interruptBlockedUntilPersistedByThreadId.value = omitKey(interruptBlockedUntilPersistedByThreadId.value, threadId)
    }
    if (threadListedByServerById.value[threadId]) {
      threadListedByServerById.value = omitKey(threadListedByServerById.value, threadId)
    }
    if (persistedUserMessageByThreadId.value[threadId]) {
      persistedUserMessageByThreadId.value = omitKey(persistedUserMessageByThreadId.value, threadId)
    }
  }

  function blockInterruptUntilThreadIsPersisted(threadId: string): void {
    if (!threadId) return
    interruptBlockedUntilPersistedByThreadId.value = {
      ...interruptBlockedUntilPersistedByThreadId.value,
      [threadId]: true,
    }
    if (threadListedByServerById.value[threadId]) {
      threadListedByServerById.value = omitKey(threadListedByServerById.value, threadId)
    }
    if (persistedUserMessageByThreadId.value[threadId]) {
      persistedUserMessageByThreadId.value = omitKey(persistedUserMessageByThreadId.value, threadId)
    }
  }

  function maybeUnblockInterruptForPersistedThread(threadId: string): void {
    if (!threadId) return
    if (interruptBlockedUntilPersistedByThreadId.value[threadId] !== true) return
    if (threadListedByServerById.value[threadId] !== true) return
    if (persistedUserMessageByThreadId.value[threadId] !== true) return
    clearInterruptPersistenceGate(threadId)
  }

  function maybeUnblockInterruptForActiveTurn(threadId: string, turnId: string): void {
    if (!threadId || !turnId) return
    if (interruptBlockedUntilPersistedByThreadId.value[threadId] !== true) return
    clearInterruptPersistenceGate(threadId)
  }

  function markServerListedThreads(serverThreadIds: Set<string>): void {
    const pendingThreadIds = Object.keys(interruptBlockedUntilPersistedByThreadId.value)
    if (pendingThreadIds.length === 0) return

    let nextListedState = threadListedByServerById.value
    let changed = false
    for (const threadId of pendingThreadIds) {
      if (!serverThreadIds.has(threadId) || nextListedState[threadId] === true) continue
      nextListedState = {
        ...nextListedState,
        [threadId]: true,
      }
      changed = true
    }

    if (!changed) return
    threadListedByServerById.value = nextListedState
    for (const threadId of pendingThreadIds) {
      maybeUnblockInterruptForPersistedThread(threadId)
    }
  }

  function markThreadMessagesPersisted(threadId: string, messages: UiMessage[]): void {
    if (!threadId) return
    if (interruptBlockedUntilPersistedByThreadId.value[threadId] !== true) return
    if (!messages.some((message) => message.role === 'user')) return
    if (persistedUserMessageByThreadId.value[threadId] !== true) {
      persistedUserMessageByThreadId.value = {
        ...persistedUserMessageByThreadId.value,
        [threadId]: true,
      }
    }
    maybeUnblockInterruptForPersistedThread(threadId)
  }

  function setTurnActivityForThread(threadId: string, activity: TurnActivityState | null): void {
    if (!threadId) return

    const previous = turnActivityByThreadId.value[threadId]
    if (!activity) {
      if (previous) {
        turnActivityByThreadId.value = omitKey(turnActivityByThreadId.value, threadId)
      }
      return
    }
    const normalizedLabel = sanitizeDisplayText(activity.label) || 'Thinking'
    const incomingDetails = activity.details
      .map((line) => sanitizeDisplayText(line))
      .filter((line) => line.length > 0 && line !== normalizedLabel)
    const mergedDetails = Array.from(new Set([...(previous?.details ?? []), ...incomingDetails])).slice(-3)
    const nextActivity: TurnActivityState = {
      label: normalizedLabel,
      details: mergedDetails,
    }

    if (areTurnActivitiesEqual(previous, nextActivity)) return
    turnActivityByThreadId.value = {
      ...turnActivityByThreadId.value,
      [threadId]: nextActivity,
    }
  }

  function setTurnErrorForThread(
    threadId: string,
    message: string | null,
    options: { transient?: boolean } = {},
  ): void {
    if (!threadId) return

    const previous = turnErrorByThreadId.value[threadId]
    const normalizedMessage = message ? normalizeMessageText(message) : ''
    if (!normalizedMessage) {
      if (previous) {
        turnErrorByThreadId.value = omitKey(turnErrorByThreadId.value, threadId)
      }
      return
    }

    const transient = options.transient === true
    if (previous?.message === normalizedMessage && previous.transient === transient) return

    turnErrorByThreadId.value = {
      ...turnErrorByThreadId.value,
      [threadId]: { message: normalizedMessage, transient },
    }
  }

  function clearTransientTurnErrorForThread(threadId: string): void {
    if (!threadId) return
    if (!turnErrorByThreadId.value[threadId]?.transient) return
    setTurnErrorForThread(threadId, null)
  }

  function clearAllTransientTurnErrors(): void {
    const transientThreadIds = Object.entries(turnErrorByThreadId.value)
      .filter(([, state]) => state?.transient)
      .map(([threadId]) => threadId)
    if (transientThreadIds.length === 0) return

    let nextState = turnErrorByThreadId.value
    for (const threadId of transientThreadIds) {
      nextState = omitKey(nextState, threadId)
    }
    turnErrorByThreadId.value = nextState
  }

  function inferNextTurnIndex(threadId: string): number {
    const persisted = getPersistedMessages(threadId)
    return threadTurnOrderState.nextTurnIndex(threadId, persisted)
  }

  function setTurnIndexForThread(threadId: string, turnId: string, turnIndex: number): void {
    threadTurnOrderState.set(threadId, turnId, turnIndex)
  }

  function replaceTurnIndexLookupForThread(threadId: string, nextLookup: Record<string, number>): void {
    threadTurnOrderState.replace(threadId, nextLookup)
  }

  function clearCompletedTurnLiveState(threadId: string): void {
    if (!threadId) return
    live.clearPlans(threadId)
    live.clearReasoning(threadId)
    setTurnActivityForThread(threadId, null)
    if (threadId === getSelectedThreadId()) {
      live.resetReasoningItem()
    }
    live.clearCommands(threadId)
    threadActiveTurnState.clear(threadId)
  }

  function hasActiveInProgressThreads(): boolean {
    return Object.values(inProgressById.value).some((value) => value === true)
  }

  function pruneTurnState(activeThreadIds: Set<string>): void {
    turnSummaryByThreadId.value = pruneThreadStateMap(turnSummaryByThreadId.value, activeThreadIds)
    turnActivityByThreadId.value = pruneThreadStateMap(turnActivityByThreadId.value, activeThreadIds)
    turnErrorByThreadId.value = pruneThreadStateMap(turnErrorByThreadId.value, activeThreadIds)
    threadActiveTurnState.prune(activeThreadIds)
    interruptBlockedUntilPersistedByThreadId.value = pruneThreadStateMap(
      interruptBlockedUntilPersistedByThreadId.value,
      activeThreadIds,
    )
    threadListedByServerById.value = pruneThreadStateMap(threadListedByServerById.value, activeThreadIds)
    persistedUserMessageByThreadId.value = pruneThreadStateMap(persistedUserMessageByThreadId.value, activeThreadIds)
  }

  function pruneInProgress(activeThreadIds: Set<string>): void {
    inProgressById.value = pruneThreadStateMap(inProgressById.value, activeThreadIds)
  }

  function resetProgress(): void {
    inProgressById.value = {}
    threadStatusRevision.clear()
  }

  function resetTurnState(): void {
    threadTurnOrderState.reset()
    turnActivityByThreadId.value = {}
    turnSummaryByThreadId.value = {}
    turnErrorByThreadId.value = {}
    threadActiveTurnState.reset()
    interruptBlockedUntilPersistedByThreadId.value = {}
    threadListedByServerById.value = {}
    persistedUserMessageByThreadId.value = {}
  }

  return {
    isInProgress: (threadId: string) => inProgressById.value[threadId] === true,
    isInterruptBlocked: (threadId: string) => interruptBlockedUntilPersistedByThreadId.value[threadId] === true,
    hasTransientError: (threadId: string) => turnErrorByThreadId.value[threadId]?.transient === true,
    getInProgressMap: (): Readonly<Record<string, boolean>> => inProgressById.value,
    getSummary: (threadId: string): Readonly<TurnSummaryState> | undefined => turnSummaryByThreadId.value[threadId],
    getErrorThreadIds: () => Object.keys(turnErrorByThreadId.value),
    captureRevisions: () => new Map(threadStatusRevision),
    selectedLiveOverlay, isSelectedThreadInterruptPending,
    applyListedStatuses, setThreadInProgress, hasActiveInProgressThreads,
    setTurnSummaryForThread, setTurnActivityForThread, setTurnErrorForThread,
    clearTransientTurnErrorForThread, clearAllTransientTurnErrors, clearCompletedTurnLiveState,
    blockInterruptUntilThreadIsPersisted, maybeUnblockInterruptForActiveTurn,
    markServerListedThreads, markThreadMessagesPersisted,
    inferNextTurnIndex, setTurnIndexForThread, replaceTurnIndexLookupForThread,
    activeTurn: {
      getTurnId: threadActiveTurnState.getTurnId,
      setTurnId: threadActiveTurnState.setTurnId,
      clear: threadActiveTurnState.clear,
    },
    turnOrder: {
      getLookup: (threadId: string): Readonly<Record<string, number>> => threadTurnOrderState.getLookup(threadId),
      getTurnIndex: threadTurnOrderState.getTurnIndex,
      maxTurnIndex: threadTurnOrderState.maxTurnIndex,
    },
    pruneTurnOrder: threadTurnOrderState.prune, pruneTurnState, pruneInProgress,
    removeThread: (threadId: string) => { inProgressById.value = omitKey(inProgressById.value, threadId) },
    resetProgress, resetTurnState,
  }
}
