import type { DeliveryStatus } from './delivery'
import type { StoredQueuedMessage } from './threadQueue'
import type { UiMessage } from './types/codex'
import { readQuestionReply } from './userQuestions'

export type ConversationDeliveryStatus = DeliveryStatus | 'submitting' | 'accepted' | 'cancelled'
export type ConversationDelivery = {
  id: string
  threadId: string
  message: StoredQueuedMessage
  status: ConversationDeliveryStatus
  createdAt: number
  revision?: number
  turnId?: string
  sourceTurnId?: string
  userMessageOrdinal?: number
  error?: string
}

export function conversationDeliveryLabel(status: ConversationDeliveryStatus): string {
  return {
    submitting: '正在提交', queued: '等待引导', sending: '引导中', unknown: '等待确认是否送达',
    failed: '发送前失败', editing: '编辑中', accepted: '已送达', cancelled: '已移除',
  }[status]
}

export function deliveryMessage(row: ConversationDelivery): UiMessage {
  return {
    id: `delivery-user:${row.id}`,
    clientUserMessageId: row.id,
    role: 'user',
    ...readQuestionReply(row.message.text),
    images: row.message.imageUrls,
    skills: row.message.skills,
    fileAttachments: row.message.fileAttachments,
    messageType: 'userMessage.delivery',
    ...(row.status === 'accepted' ? { turnId: row.turnId, userMessageOrdinal: row.userMessageOrdinal } : {}),
    deliveryState: { status: row.status, error: row.error },
  }
}

/** An equal prompt is not delivery evidence. Identity or a confirmed turn ordinal is required. */
export function matchesDelivery(row: ConversationDelivery, message: UiMessage): boolean {
  if (message.role !== 'user' || message.messageType === 'userMessage.optimistic' || message.deliveryState) return false
  if (message.clientUserMessageId) return message.clientUserMessageId === row.id
  return row.status === 'accepted' && !!row.turnId && message.turnId === row.turnId
    && row.userMessageOrdinal !== undefined && row.userMessageOrdinal === message.userMessageOrdinal
    && readQuestionReply(row.message.text).text === message.text
}

export function nativeDeliveryMatcher(messages: UiMessage[]): (row: ConversationDelivery) => boolean {
  const ids = new Set<string>()
  const ordinals = new Map<string, UiMessage>()
  for (const message of messages) {
    if (message.role !== 'user' || message.messageType === 'userMessage.optimistic' || message.deliveryState) continue
    if (message.clientUserMessageId) ids.add(message.clientUserMessageId)
    else if (message.turnId && message.userMessageOrdinal !== undefined) {
      ordinals.set(JSON.stringify([message.turnId, message.userMessageOrdinal]), message)
    }
  }
  return row => {
    if (ids.has(row.id)) return true
    const candidate = ordinals.get(JSON.stringify([row.turnId, row.userMessageOrdinal]))
    return !!candidate && matchesDelivery(row, candidate)
  }
}
