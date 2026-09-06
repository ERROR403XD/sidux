import type { StoredQueuedMessage } from './threadQueue'

export type DeliveryStatus = 'queued' | 'editing' | 'sending' | 'unknown' | 'failed'
export type DeliveryMode = 'queue' | 'immediate' | 'steer'
export type DeliveryView = {
  status: DeliveryStatus
  revision: number
  createdAt: number
  updatedAt: number
  mode: DeliveryMode
  error?: string
  turnId?: string
  editToken?: string
}
export type DeliveryRecord = DeliveryView & {
  threadId: string
  message: StoredQueuedMessage
  fingerprint: string
  contextId: string
  params?: Record<string, unknown>
  submittedAt?: number
}
export type DeliveryReceipt = {
  id: string
  threadId: string
  fingerprint: string
  status: 'accepted' | 'cancelled'
  turnId?: string
  createdAt: number
  updatedAt: number
}

export function createDeliveryId(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  return `d-${Date.now()}-${random}`
}

export function deliveryStatusLabel(status: DeliveryStatus): string {
  return { queued: '待发送', editing: '编辑中', sending: '正在发送', unknown: '等待确认是否送达', failed: '发送前失败' }[status]
}

export function deliveryView(record: DeliveryRecord): DeliveryView {
  const { status, revision, createdAt, updatedAt, mode, error, turnId, editToken } = record
  return { status, revision, createdAt, updatedAt, mode, ...(error ? { error } : {}), ...(turnId ? { turnId } : {}), ...(editToken ? { editToken } : {}) }
}
