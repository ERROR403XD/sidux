import type { ConversationDelivery } from '../conversationDelivery'

const PREFIX = 'codexapp.delivery-view.v1.'
export const DELIVERY_VIEW_EVENT = 'codexapp-delivery-view'

function storage(name: 'localStorage' | 'sessionStorage'): Storage | undefined {
  try { return globalThis[name] ?? (typeof window !== 'undefined' ? window[name] : undefined) } catch { return undefined }
}

function preferCurrent(previous: ConversationDelivery | undefined, next: ConversationDelivery): ConversationDelivery {
  if (previous && ['accepted', 'cancelled'].includes(previous.status) && !['accepted', 'cancelled'].includes(next.status)) return previous
  if (previous?.revision && next.revision && previous.revision > next.revision) return previous
  return { ...previous, ...next }
}

function validRow(row: ConversationDelivery | undefined, key: string): row is ConversationDelivery {
  return Boolean(row?.id === key.slice(PREFIX.length) && row.message?.id === row.id && typeof row.threadId === 'string'
    && typeof row.message.text === 'string' && Array.isArray(row.message.imageUrls)
    && Array.isArray(row.message.skills) && Array.isArray(row.message.fileAttachments)
    && Number.isFinite(row.createdAt)
    && ['submitting', 'queued', 'sending', 'unknown', 'editing', 'failed', 'accepted', 'cancelled'].includes(row.status))
}

function readCache(target: Storage | undefined): ConversationDelivery[] {
  if (!target) return []
  const rows: ConversationDelivery[] = []
  try {
    for (let index = 0; index < target.length; index += 1) {
      const key = target.key(index)
      if (!key?.startsWith(PREFIX)) continue
      try {
        const row = JSON.parse(target.getItem(key) || 'null') as ConversationDelivery
        if (validRow(row, key)) {
          rows.push(row.status === 'submitting' ? { ...row, status: 'unknown' } : row)
        }
      } catch { /* Display-only cache damage never blocks the authoritative outbox. */ }
    }
  } catch { /* The original outbox reports unavailable durable submission storage. */ }
  return rows
}

export function readConversationDeliveryCache(): ConversationDelivery[] {
  const rows = new Map<string, ConversationDelivery>()
  for (const target of [storage('localStorage'), storage('sessionStorage')]) {
    for (const row of readCache(target)) rows.set(row.id, preferCurrent(rows.get(row.id), row))
  }
  return [...rows.values()].sort((a, b) => a.createdAt - b.createdAt)
}

export function saveConversationDelivery(row: ConversationDelivery, notify = true): void {
  const targets = [storage('localStorage'), storage('sessionStorage')]
  let previous: ConversationDelivery | undefined
  for (const target of targets) {
    try {
      const cached = JSON.parse(target?.getItem(PREFIX + row.id) || 'null')
      if (validRow(cached, PREFIX + row.id)) previous = preferCurrent(previous, cached)
    } catch { /* Replace invalid display cache only. */ }
  }
  const next = preferCurrent(previous, row)
  if (next.status === 'accepted' && previous?.sourceTurnId && row.userMessageOrdinal === undefined) {
    next.userMessageOrdinal = next.turnId === previous.sourceTurnId ? previous.userMessageOrdinal : 0
  }
  let raw: string
  try { raw = JSON.stringify(next) } catch { return }
  for (const target of targets) {
    if (!target) continue
    try {
      if (target.getItem(PREFIX + row.id) !== raw) target.setItem(PREFIX + row.id, raw)
      if (target.getItem(PREFIX + row.id) !== raw) continue
    } catch { continue }
    // A full persistent cache must not lose an acknowledged message on reload.
    // The tab cache is display-only too: it never enters the sending outbox.
    for (const other of targets) {
      if (other !== target) {
        try { other?.removeItem(PREFIX + row.id) } catch { /* Retain the confirmed copy. */ }
      }
    }
    break
  }
  if (notify && typeof window !== 'undefined') window.dispatchEvent?.(new Event(DELIVERY_VIEW_EVENT))
}

export function forgetConversationDelivery(id: string): void {
  for (const target of [storage('localStorage'), storage('sessionStorage')]) {
    try { target?.removeItem(PREFIX + id) } catch { /* Keep native history visible even when storage is unavailable. */ }
  }
}
