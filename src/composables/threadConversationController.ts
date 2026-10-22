import { computed, ref } from 'vue'
import { combineHistoryAndLive, hasEquivalentUserMessage } from '../messageIdentity'
import { insertTurnSummaryMessage, type TurnSummaryState } from '../turnSummary'
import { readQuestionReply } from '../userQuestions'
import type { ConversationDelivery } from '../conversationDelivery'
import type { AuthRecoveryState } from '../authRecovery'
import type { UiMessage, UiServerRequest } from '../types/codex'
import { GLOBAL_SERVER_REQUEST_SCOPE } from './threadPendingRequestController'

type FileAttachment = { label: string; path: string; fsPath: string }
type ThreadConversationControllerOptions = {
  getSelectedThreadId: () => string
  history: {
    getMessages: (threadId: string) => readonly Readonly<UiMessage>[]
    setMessages: (threadId: string, messages: readonly UiMessage[]) => void
    isLoading: (threadId: string) => boolean
    hasMoreOlder: (threadId: string) => boolean
    isLoadingOlder: (threadId: string) => boolean
  }
  live: {
    getPlans: (threadId: string) => readonly Readonly<UiMessage>[]
    getAgents: (threadId: string) => readonly Readonly<UiMessage>[]
    getCommands: (threadId: string) => readonly Readonly<UiMessage>[]
    getFileChanges: (threadId: string) => readonly Readonly<UiMessage>[]
  }
  getSummary: (threadId: string) => Readonly<TurnSummaryState> | undefined
  deliveries: {
    project: (threadId: string, messages: UiMessage[]) => UiMessage[]
    getRows: () => readonly Readonly<ConversationDelivery>[]
  }
  pending: {
    getRequests: (threadId: string) => readonly Readonly<UiServerRequest>[]
    getAuthRecovery: (threadId: string) => Readonly<AuthRecoveryState> | null
  }
}

export function createThreadConversationController({ getSelectedThreadId, history, live, getSummary, deliveries, pending }: ThreadConversationControllerOptions) {
  const threadSearchVersion = ref(0)
  const selectedAuthRecovery = computed(() => pending.getAuthRecovery(getSelectedThreadId()))

  const isLoadingMessages = computed(() => history.isLoading(getSelectedThreadId()))

  const selectedThreadServerRequests = computed<UiServerRequest[]>(() => {
    const rows: UiServerRequest[] = []
    const selected = getSelectedThreadId()
    if (selected && Array.isArray(pending.getRequests(selected))) {
      rows.push(...pending.getRequests(selected))
    }
    if (Array.isArray(pending.getRequests(GLOBAL_SERVER_REQUEST_SCOPE))) {
      rows.push(...pending.getRequests(GLOBAL_SERVER_REQUEST_SCOPE))
    }
    return rows.sort((first, second) => first.receivedAtIso.localeCompare(second.receivedAtIso))
  })

  const messages = computed<UiMessage[]>(() => {
    const threadId = getSelectedThreadId()
    if (!threadId) return []

    const persisted = history.getMessages(threadId)
    const livePlan = live.getPlans(threadId)
    const liveAgent = live.getAgents(threadId)
    const liveCommands = live.getCommands(threadId)
    const liveFileChanges = live.getFileChanges(threadId)
    const combined = combineHistoryAndLive(persisted, [...livePlan, ...liveCommands, ...liveFileChanges, ...liveAgent])

    const summary = getSummary(threadId)
    const summarizedMessages = summary ? insertTurnSummaryMessage(combined, summary) : combined
    return deliveries.project(threadId, summarizedMessages)
  })

  const hasMoreOlderMessages = computed(() => {
    const threadId = getSelectedThreadId()
    return threadId ? history.hasMoreOlder(threadId) : false
  })

  const isLoadingOlderMessages = computed(() => {
    const threadId = getSelectedThreadId()
    return threadId ? history.isLoadingOlder(threadId) : false
  })

  function appendOptimisticUserMessage(
    threadId: string,
    text: string,
    imageUrls: string[] = [],
    skills: Array<{ name: string; path: string }> = [],
    fileAttachments: FileAttachment[] = [],
    delivery?: { id: string; turnId: string; userMessageOrdinal?: number },
  ): void {
    const existing = history.getMessages(threadId)
    const nextMessage: UiMessage = {
      id: delivery ? `optimistic-user:${delivery.id}` : `optimistic-user:${threadId}:${Date.now()}`,
      turnId: delivery?.turnId,
      clientUserMessageId: delivery?.id,
      userMessageOrdinal: delivery?.userMessageOrdinal,
      role: 'user',
      ...readQuestionReply(text),
      images: imageUrls.length > 0 ? [...imageUrls] : undefined,
      skills: skills.length > 0 ? skills.map((skill) => ({ name: skill.name, path: skill.path })) : undefined,
      fileAttachments: fileAttachments.length > 0 ? fileAttachments.map((file) => ({ ...file })) : undefined,
      messageType: 'userMessage.optimistic',
    }
    if (!hasEquivalentUserMessage(nextMessage, existing)) history.setMessages(threadId, [...existing.filter(message => message.id !== nextMessage.id), nextMessage])
  }

  function readNextUserMessageOrdinal(threadId: string, sourceTurnId?: string): number {
    const persistedCount = (history.getMessages(threadId)).filter(message => message.role === 'user' && message.turnId === sourceTurnId).length
    const acceptedDeliveryCount = deliveries.getRows().filter(row => row.threadId === threadId && row.status === 'accepted' && row.turnId === sourceTurnId).length
    return persistedCount + acceptedDeliveryCount
  }

  function markSearchChanged(): void {
    threadSearchVersion.value += 1
  }

  return {
    selectedAuthRecovery, isLoadingMessages, selectedThreadServerRequests, messages,
    hasMoreOlderMessages, isLoadingOlderMessages, appendOptimisticUserMessage, readNextUserMessageOrdinal,
    threadSearchVersion: computed(() => threadSearchVersion.value), markSearchChanged,
  }
}
