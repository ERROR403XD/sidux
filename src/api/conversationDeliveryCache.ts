import type { ConversationDelivery } from '../conversationDelivery'

const PREFIX = 'codexapp.delivery-view.v1.'
export const DELIVERY_VIEW_EVENT = 'codexapp-delivery-view'

function storage(): Storage | undefined {
  try { return globalThis.localStorage ?? (typeof window !== 'undefined' ? window.localStorage : undefined) } catch { return undefined }
}

export function readConversationDeliveryCache(): ConversationDelivery[] {
  const target = storage()
  if (!target) return []
  const rows: ConversationDelivery[] = []
  try {
    for (let index = 0; index < target.length; index += 1) {
      const key = target.key(index)
      if (!key?.startsWith(PREFIX)) continue
      try {
        const row = JSON.parse(target.getItem(key) || 'null') as ConversationDelivery
        if (row?.id === key.slice(PREFIX.length) && row.message?.id === row.id && typeof row.threadId === 'string'
          && typeof row.message.text === 'string' && Array.isArray(row.message.imageUrls)
          && Array.isArray(row.message.skills) && Array.isArray(row.message.fileAttachments)
          && Number.isFinite(row.createdAt)
          && ['submitting', 'queued', 'sending', 'unknown', 'editing', 'failed', 'accepted', 'cancelled'].includes(row.status)) {
          rows.push(row.status === 'submitting' ? { ...row, status: 'unknown' } : row)
        }
      } catch { /* Display-only cache damage never blocks the authoritative outbox. */ }
    }
  } catch { /* The original outbox reports unavailable durable submission storage. */ }
  return rows.sort((a, b) => a.createdAt - b.createdAt)
}

export function saveConversationDelivery(row: ConversationDelivery, notify = true): void {
  try {
    const target = storage()
    let previous: Partial<ConversationDelivery> = {}
    try { previous = JSON.parse(target?.getItem(PREFIX + row.id) || '{}') } catch { /* Replace invalid display cache only. */ }
    const next = { ...previous, ...row }
    if (row.status === 'accepted' && previous.sourceTurnId && row.userMessageOrdinal === undefined) {
      next.userMessageOrdinal = row.turnId === previous.sourceTurnId ? previous.userMessageOrdinal : 0
    }
    const raw = JSON.stringify(next)
    if (target?.getItem(PREFIX + row.id) !== raw) target?.setItem(PREFIX + row.id, raw)
  } catch { /* Never turn an acknowledged send into a failure because a UI cache is full. */ }
  if (notify && typeof window !== 'undefined') window.dispatchEvent?.(new Event(DELIVERY_VIEW_EVENT))
}

export function forgetConversationDelivery(id: string): void {
  try { storage()?.removeItem(PREFIX + id) } catch { /* Keep native history visible even when storage is unavailable. */ }
}
