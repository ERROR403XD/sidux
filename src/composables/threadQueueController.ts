import { computed, ref } from 'vue'
import { getDeliveryStatuses, getThreadQueueState, mutateThreadQueueState } from '../api/threadQueueGateway'
import { createDeliveryId } from '../delivery'
import { resolveUserMessageOrdinal, type ConversationDelivery } from '../conversationDelivery'
import type { StoredQueuedMessage, StoredQueuedMessageView, ThreadQueueOperation, ThreadQueueResult } from '../threadQueue'
import type { UiMessage } from '../types/codex'
import type { useConversationDeliveries } from './useConversationDeliveries'
import { createThreadQueueLifecycleState } from './threadQueueLifecycleState'
import { createThreadQueueUiState } from './threadQueueUiState'

type QueuedMessage = StoredQueuedMessage
type QueuedMessageView = StoredQueuedMessageView
type QueueMutationView = {
  readonly state: Readonly<Record<string, readonly QueuedMessageView[]>>
  readonly removed?: QueuedMessageView
  readonly delivered?: Readonly<NonNullable<ThreadQueueResult['delivered']>>
}
type QueueDeliveries = Pick<ReturnType<typeof useConversationDeliveries>, 'syncQueue' | 'begin' | 'patch' | 'observe'>
type ThreadQueueControllerOptions = {
  getAccountRevision: () => number
  getSelectedThreadId: () => string
  getPersistedMessages: (threadId: string) => readonly UiMessage[]
  getActiveTurnId: (threadId: string) => string | undefined
  readNextUserMessageOrdinal: (threadId: string, sourceTurnId?: string) => number
  getDeliveryRows: () => readonly Readonly<ConversationDelivery>[]
  conversationDeliveries: QueueDeliveries
  appendOptimisticUserMessage: (threadId: string, text: string, imageUrls: string[], skills: StoredQueuedMessage['skills'], fileAttachments: StoredQueuedMessage['fileAttachments'], delivery: { id: string; turnId: string; userMessageOrdinal?: number }) => void
  markThreadHistoryDirty: (threadId: string) => void
  scheduleDelayedTurnSync: (threadId: string) => void
  setPageError: (message: string) => void
  notifyQueueError: (message: string, threadId: string) => void
  scheduleTimeout: (callback: () => void, delay: number) => number
  cancelTimeout: (timer: number) => void
}

export function createThreadQueueController({
  getAccountRevision, getSelectedThreadId, getPersistedMessages, getActiveTurnId,
  readNextUserMessageOrdinal, getDeliveryRows, conversationDeliveries, appendOptimisticUserMessage,
  markThreadHistoryDirty, scheduleDelayedTurnSync, setPageError, notifyQueueError, scheduleTimeout, cancelTimeout,
}: ThreadQueueControllerOptions) {
  const queuedMessagesByThreadId = ref<Record<string, QueuedMessage[]>>({})
  const queueErrorByThreadId = ref<Record<string, string>>({})
  const queueStateError = ref('')
  const queueProcessingByThreadId = ref<Record<string, boolean>>({})
  const threadQueueUiState = createThreadQueueUiState({
    queuedMessagesByThreadId,
    errorByThreadId: queueErrorByThreadId,
    globalError: queueStateError,
    processingByThreadId: queueProcessingByThreadId,
  })

  const deliveryReceiptReads = new Map<string, Promise<void>>()
  const threadQueueLifecycleState = createThreadQueueLifecycleState({
    getQueueState: () => getThreadQueueState(),
    mutateQueueState: (operation, options) => options
      ? mutateThreadQueueState(operation, options)
      : mutateThreadQueueState(operation),
    applyQueueState: state => {
      threadQueueUiState.setState(state)
      conversationDeliveries.syncQueue(state)
      void refreshVisibleDeliveryReceipts()
      threadQueueUiState.clearGlobalError()
    },
    markRemoved: messageId => conversationDeliveries.patch(messageId, { status: 'cancelled' }),
    markMutationSucceeded: operation => {
      void refreshVisibleDeliveryReceipts(operation.threadId)
      threadQueueUiState.clearThreadError(operation.threadId)
    },
    markMutationFailed: (operation, cause) => {
      const message = cause instanceof Error ? cause.message : '队列保存失败，请重试'
      setPageError(message)
      threadQueueUiState.setThreadError(operation.threadId, message)
      if (getSelectedThreadId() === operation.threadId) notifyQueueError(message, operation.threadId)
    },
    scheduleTimeout: (callback, delay) => scheduleTimeout(callback, delay),
    cancelTimeout: timer => cancelTimeout(timer),
  })


  function refreshVisibleDeliveryReceipts(threadId = getSelectedThreadId()): Promise<void> {
    if (!threadId) return Promise.resolve()
    const isCurrent = captureQueueContext()
    if (!isCurrent()) return Promise.resolve()
    const pending = deliveryReceiptReads.get(threadId)
    if (pending) return pending
    const queuedIds = new Set(threadQueueUiState.getMessages(threadId).map(row => row.id))
    const ids = getDeliveryRows().filter(row => row.threadId === threadId
      && !['accepted', 'cancelled', 'submitting'].includes(row.status) && !queuedIds.has(row.id)
      && /^[a-zA-Z0-9_-]{1,160}$/.test(row.id)).map(row => row.id).slice(0, 100)
    if (!ids.length) return Promise.resolve()
    const request = (async () => {
      try {
        const receipts = await getDeliveryStatuses(threadId, ids)
        if (!isCurrent()) return
        for (const receipt of receipts) conversationDeliveries.patch(receipt.id, receipt)
        if (receipts.some(receipt => receipt.status === 'accepted')) {
          conversationDeliveries.observe(threadId, getPersistedMessages(threadId))
          markThreadHistoryDirty(threadId)
          scheduleDelayedTurnSync(threadId)
        }
      } catch { /* A failed read is not proof of cancellation or delivery. Keep the content visible. */ }
    })().finally(() => {
      if (deliveryReceiptReads.get(threadId) === request) deliveryReceiptReads.delete(threadId)
    })
    deliveryReceiptReads.set(threadId, request)
    return request
  }

  function commitQueueOperation(operation: ThreadQueueOperation): Promise<ThreadQueueResult> {
    if (operation.type === 'add') {
      return threadQueueLifecycleState.runMutation(operation, captureQueueContext())
    }
    return threadQueueLifecycleState.runMutation(operation)
  }

  function captureQueueContext(): () => boolean {
    const identityRevision = getAccountRevision()
    const isCurrentLifecycle = threadQueueLifecycleState.captureContext()
    return () => identityRevision === getAccountRevision() && isCurrentLifecycle()
  }

  async function refreshQueueState(): Promise<void> {
    const isCurrent = captureQueueContext()
    try {
      await threadQueueLifecycleState.refresh()
    } catch (cause) {
      if (!isCurrent()) return
      threadQueueUiState.setGlobalError(cause instanceof Error ? cause.message : '无法读取发送队列')
      throw cause
    }
  }

  async function processQueuedMessages(threadId: string): Promise<void> {
    const isCurrent = captureQueueContext()
    if (!isCurrent()) return
    if (!threadQueueUiState.beginProcessing(threadId)) return
    try {
      await refreshQueueState()
    } catch {
      // Backend queue state is optional during transient bridge failures.
    } finally {
      if (isCurrent()) threadQueueUiState.finishProcessing(threadId)
    }
  }

  function scheduleQueueStateRefresh(threadId: string): void {
    threadQueueLifecycleState.scheduleRefresh(threadId, processQueuedMessages)
  }

  async function removeQueuedMessage(messageId: string): Promise<QueuedMessageView | null> {
    const threadId = getSelectedThreadId()
    if (!threadId) return null
    const isCurrent = captureQueueContext()
    try {
      const message = threadQueueUiState.findMessage(threadId, messageId)
      const result = await commitQueueOperation({ type: 'remove', threadId, messageId, revision: message?.delivery?.revision })
      if (!isCurrent()) return null
      return result.removed ?? null
    } catch {
      if (!isCurrent()) return null
      void refreshQueueState().catch(() => {})
      return null
    }
  }

  async function reorderQueuedMessage(draggedId: string, targetId: string): Promise<void> {
    const threadId = getSelectedThreadId()
    if (!threadId || draggedId === targetId) return
    const isCurrent = captureQueueContext()
    try {
      const message = threadQueueUiState.findMessage(threadId, draggedId)
      await commitQueueOperation({ type: 'move', threadId, messageId: draggedId, targetId, revision: message?.delivery?.revision })
    } catch {
      if (!isCurrent()) return
      void refreshQueueState().catch(() => {})
    }
  }

  async function changeQueuedMessage(messageId: string, type: 'steer' | 'reconcile' | 'resume' | 'abandon'): Promise<void> {
    const threadId = getSelectedThreadId()
    const message = threadQueueUiState.findMessage(threadId, messageId)
    if (!message) return
    const isCurrent = captureQueueContext()
    const showDelivery = type === 'steer' || message.delivery?.mode === 'steer'
    const previousTurnId = getActiveTurnId(threadId)
    const ordinal = readNextUserMessageOrdinal(threadId, previousTurnId)
    if (type === 'steer') conversationDeliveries.begin(threadId, message, ordinal, true, previousTurnId)
    try {
      const result = await commitQueueOperation({ type, threadId, messageId, revision: message.delivery?.revision })
      if (!isCurrent()) return
      if (result.delivered) {
        if (showDelivery) {
          conversationDeliveries.patch(messageId, { status: 'accepted', turnId: result.delivered.turnId,
            userMessageOrdinal: resolveUserMessageOrdinal(result.delivered.turnId, previousTurnId, ordinal) })
          conversationDeliveries.observe(threadId, getPersistedMessages(threadId))
        } else {
          appendOptimisticUserMessage(threadId, message.text, message.imageUrls, message.skills, message.fileAttachments,
            { ...result.delivered, userMessageOrdinal: resolveUserMessageOrdinal(result.delivered.turnId, previousTurnId, ordinal) })
        }
        markThreadHistoryDirty(threadId)
        scheduleDelayedTurnSync(threadId)
      }
    } catch (cause) {
      if (!isCurrent()) return
      if (showDelivery && getDeliveryRows().find(row => row.id === messageId)?.status === 'submitting') {
        conversationDeliveries.patch(messageId, { status: 'unknown', error: String(cause) })
      }
      void refreshQueueState().catch(() => {})
    }
  }

  async function beginQueuedMessageEdit(messageId: string): Promise<QueuedMessageView | null> {
    const threadId = getSelectedThreadId()
    const message = threadQueueUiState.findMessage(threadId, messageId)
    if (!message?.delivery) return null
    if (message.delivery.status === 'editing') return message
    const isCurrent = captureQueueContext()
    try {
      const result = await commitQueueOperation({ type: 'edit', threadId, messageId, revision: message.delivery.revision, editToken: createDeliveryId() })
      if (!isCurrent()) return null
      return result.state[threadId]?.find(row => row.id === messageId) ?? null
    } catch {
      if (!isCurrent()) return null
      void refreshQueueState().catch(() => {})
      return null
    }
  }

  async function updateQueuedMessage(threadId: string, messageId: string, revision: number, editToken: string, contents: Pick<QueuedMessage, 'text' | 'imageUrls' | 'skills' | 'fileAttachments'>): Promise<void> {
    await commitQueueOperation({ type: 'update', threadId, messageId, revision, editToken, message: { ...contents, id: messageId, collaborationMode: 'default' } })
  }

  function steerQueuedMessage(messageId: string): Promise<void> {
    return changeQueuedMessage(messageId, 'steer')
  }

  const selectedThreadQueueError = computed(() => queueErrorByThreadId.value[getSelectedThreadId()] || queueStateError.value)

  const selectedThreadQueuedMessages = computed<readonly QueuedMessageView[]>(() => {
    const threadId = getSelectedThreadId()
    if (!threadId) return []
    return threadQueueUiState.getMessages(threadId)
  })


  return {
    selectedThreadQueueError,
    selectedThreadQueuedMessages,
    queueStateError: computed(() => queueStateError.value),
    getMessages: (threadId: string): readonly QueuedMessageView[] => threadQueueUiState.getMessages(threadId),
    commitQueueOperation: (operation: ThreadQueueOperation): Promise<QueueMutationView> => commitQueueOperation(operation),
    refreshQueueState, refreshVisibleDeliveryReceipts,
    removeQueuedMessage, reorderQueuedMessage, changeQueuedMessage, beginQueuedMessageEdit, updateQueuedMessage, steerQueuedMessage,
    scheduleQueueStateRefresh,
    loadPersistedStateIfNeeded: threadQueueLifecycleState.loadPersistedStateIfNeeded,
    start: threadQueueLifecycleState.start,
    stop: (): void => {
      threadQueueLifecycleState.stop()
      threadQueueUiState.reset()
      deliveryReceiptReads.clear()
    },
    invalidateForAccountChange: (): void => {
      threadQueueLifecycleState.invalidateForAccountChange()
      deliveryReceiptReads.clear()
      threadQueueUiState.reset()
    },
  }
}
