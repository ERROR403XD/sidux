import { createDeliveryId } from '../delivery'
import type { StoredQueuedMessage, ThreadQueueState } from '../threadQueue'

const PREFIX = 'codexapp.delivery.v2.'
export const DELIVERY_OUTBOX_EVENT = 'codexapp-delivery-outbox'
export type WebSubmission = {
  protocol: 2
  threadId: string
  message: StoredQueuedMessage
  params?: Record<string, unknown>
  mode?: 'immediate' | 'steer'
  type?: 'add'
  beforeId?: string
  expectedContextId?: string
}
export type PendingWebDelivery = {
  id: string
  endpoint: 'delivery' | 'thread-queue-state'
  body: WebSubmission
  createdAt: number
}
export type WebDeliveryAck = { data: { id?: string; status?: string; turnId?: string; state?: ThreadQueueState; removed?: StoredQueuedMessage } }
const flights = new Map<string, Promise<WebDeliveryAck>>()

function storage(): Storage {
  try {
    if (globalThis.localStorage) return globalThis.localStorage
  } catch { /* Report before sending when the browser blocks persistence. */ }
  throw new Error('浏览器无法保存发送记录，请允许本地存储后重试')
}

function changed(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(DELIVERY_OUTBOX_EVENT))
}

export function readPendingWebDeliveries(threadId?: string): PendingWebDelivery[] {
  const target = storage()
  const rows: PendingWebDelivery[] = []
  for (let i = 0; i < target.length; i += 1) {
    const key = target.key(i)
    if (!key?.startsWith(PREFIX)) continue
    const raw = target.getItem(key)
    if (!raw) continue
    let row: PendingWebDelivery
    try { row = JSON.parse(raw) } catch { throw new Error('浏览器中的发送记录损坏，请先核对队列') }
    if (row?.id !== key.slice(PREFIX.length) || row.body?.message?.id !== row.id || !row.body.threadId
      || !['delivery', 'thread-queue-state'].includes(row.endpoint)) throw new Error('浏览器中的发送记录无效，请先核对队列')
    if (!threadId || row.body.threadId === threadId) rows.push(row)
  }
  return rows.sort((a, b) => a.createdAt - b.createdAt)
}

function intent(body: WebSubmission): string {
  return JSON.stringify({ ...body, expectedContextId: undefined, message: { ...body.message, id: '', delivery: undefined } })
}

export async function prepareWebDelivery(endpoint: PendingWebDelivery['endpoint'], body: WebSubmission): Promise<PendingWebDelivery> {
  const pending = readPendingWebDeliveries(body.threadId)
  const previous = pending.find(row => row.endpoint === endpoint && intent(row.body) === intent(body))
  if (previous) return previous
  if (pending.length) throw new Error('此会话还有未确认的提交，请先点击“核对提交”')
  const response = await fetch('/codex-api/delivery-context')
  const payload = await response.json()
  if (!response.ok || typeof payload.data?.contextId !== 'string' || !payload.data.contextId) throw new Error(payload.error || '无法确认当前账号，消息尚未提交')
  return rememberWebDelivery(endpoint, { ...body, expectedContextId: payload.data.contextId })
}

export function rememberWebDelivery(endpoint: PendingWebDelivery['endpoint'], body: WebSubmission): PendingWebDelivery {
  const rows = readPendingWebDeliveries()
  const pending = rows.filter(row => row.body.threadId === body.threadId)
  const previous = pending.find(row => row.endpoint === endpoint && intent(row.body) === intent(body))
  if (previous) return previous
  if (pending.length) throw new Error('此会话还有未确认的提交，请先点击“核对提交”')
  if (rows.length >= 20) throw new Error('浏览器中未确认的提交过多，请先核对已有记录')
  const id = body.message.id || createDeliveryId()
  const row: PendingWebDelivery = { id, endpoint, body: { ...body, message: { ...body.message, id } }, createdAt: Date.now() }
  const target = storage()
  const raw = JSON.stringify(row)
  try {
    target.setItem(PREFIX + id, raw)
    if (target.getItem(PREFIX + id) !== raw) throw new Error('write verification failed')
  } catch {
    throw new Error('浏览器未能保存发送记录，消息尚未提交；请释放本地存储空间')
  }
  changed()
  return row
}

export function forgetWebDelivery(id: string, notify = true): void {
  storage().removeItem(PREFIX + id)
  if (notify) changed()
}

export function submitRememberedDelivery(row: PendingWebDelivery): Promise<WebDeliveryAck> {
  const current = flights.get(row.id)
  if (current) return current
  const request = (async () => {
    const response = await fetch('/codex-api/' + row.endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(row.body),
    })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.error || '未确认提交结果，请核对提交状态')
    const result = payload.data
    const valid = row.endpoint === 'delivery'
      ? result?.id === row.id && ['accepted', 'cancelled', 'queued', 'editing', 'sending', 'unknown', 'failed'].includes(result.status)
      : result?.state && typeof result.state === 'object' && !Array.isArray(result.state)
    if (!valid) throw new Error('未收到有效的提交确认，请核对提交状态')
    forgetWebDelivery(row.id)
    return payload as WebDeliveryAck
  })().finally(() => { flights.delete(row.id) })
  flights.set(row.id, request)
  return request
}
