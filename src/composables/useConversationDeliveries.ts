import { computed, shallowRef } from 'vue'
import { deliveryMessage, nativeDeliveryMatcher, type ConversationDelivery } from '../conversationDelivery'
import { DELIVERY_VIEW_EVENT, forgetConversationDelivery, readConversationDeliveryCache, saveConversationDelivery } from '../api/conversationDeliveryCache'
import { DELIVERY_OUTBOX_EVENT, readPendingWebDeliveries } from '../api/deliveryOutbox'
import type { StoredQueuedMessage, ThreadQueueState } from '../threadQueue'
import type { UiMessage } from '../types/codex'

/** Display state only: this module never submits, retries, switches accounts, or releases a lease. */
export function useConversationDeliveries() {
  const rows = shallowRef<ConversationDelivery[]>(readConversationDeliveryCache())
  const presentationMessages = computed(() => new Map(rows.value.map(row => [row.id, deliveryMessage(row)])))
  const nativeIds = new Set<string>()

  function update(row: ConversationDelivery, persist = true): void {
    if (nativeIds.has(row.id)) {
      forgetConversationDelivery(row.id)
      return
    }
    const previous = rows.value.find(value => value.id === row.id)
    if (previous && ['accepted', 'cancelled'].includes(previous.status) && !['accepted', 'cancelled'].includes(row.status)) return
    if (previous?.revision && row.revision && previous.revision > row.revision) return
    const next = { ...previous, ...row }
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) return
    rows.value = [...rows.value.filter(value => value.id !== row.id), next].sort((a, b) => a.createdAt - b.createdAt)
    if (persist) saveConversationDelivery(next, false)
  }

  function refresh(): void {
    for (const row of readConversationDeliveryCache()) update(row, false)
    try {
      for (const pending of readPendingWebDeliveries()) {
        if (pending.body.mode !== 'steer') continue
        const previous = rows.value.find(row => row.id === pending.id)
        if (!previous || previous.status === 'submitting') {
          update({ id: pending.id, threadId: pending.body.threadId, message: pending.body.message,
            createdAt: pending.createdAt, status: 'unknown' })
        }
      }
    } catch { /* DeliveryOutbox renders the authoritative storage error. */ }
  }

  function syncQueue(state: ThreadQueueState): void {
    for (const [threadId, messages] of Object.entries(state)) {
      for (const message of messages) {
        if (message.delivery?.mode !== 'steer') continue
        update({ id: message.id, threadId, message, status: message.delivery.status,
          createdAt: message.delivery.createdAt, revision: message.delivery.revision,
          error: message.delivery.error, turnId: message.delivery.turnId })
      }
    }
  }

  function begin(threadId: string, message: StoredQueuedMessage, userMessageOrdinal?: number, persist = false, sourceTurnId?: string): void {
    update({ id: message.id, threadId, message, status: 'submitting', createdAt: Date.now(), userMessageOrdinal, sourceTurnId }, persist)
  }

  function patch(id: string, value: Partial<ConversationDelivery>): void {
    const row = rows.value.find(candidate => candidate.id === id)
    if (row) {
      const ordinal = value.status === 'accepted' && row.sourceTurnId && value.userMessageOrdinal === undefined
        ? { userMessageOrdinal: value.turnId === row.sourceTurnId ? row.userMessageOrdinal : 0 } : {}
      update({ ...row, ...value, ...ordinal })
    }
  }

  function replaceId(previousId: string, id: string): void {
    if (previousId === id) return
    const row = rows.value.find(candidate => candidate.id === previousId)
    rows.value = rows.value.filter(candidate => candidate.id !== previousId)
    forgetConversationDelivery(previousId)
    if (row && !rows.value.some(candidate => candidate.id === id)) update({ ...row, id, message: { ...row.message, id } }, false)
  }

  function observe(threadId: string, messages: UiMessage[]): void {
    const candidates = rows.value.filter(row => row.threadId === threadId)
    if (!candidates.length) return
    const matches = nativeDeliveryMatcher(messages)
    const settled = candidates.filter(matches)
    if (!settled.length) return
    const ids = new Set(settled.map(row => row.id))
    for (const id of ids) {
      nativeIds.add(id)
      forgetConversationDelivery(id)
    }
    rows.value = rows.value.filter(row => !ids.has(row.id))
  }

  function project(threadId: string, messages: UiMessage[]): UiMessage[] {
    const candidates = rows.value.filter(row => row.threadId === threadId)
    if (!candidates.length) return messages
    const matches = nativeDeliveryMatcher(messages)
    const lastByTurn = new Map<string, number>()
    messages.forEach((message, index) => { if (message.turnId) lastByTurn.set(message.turnId, index) })
    const after = new Map<number, UiMessage[]>()
    for (const row of candidates) {
      if (matches(row)) continue
      const index = row.status === 'accepted' && row.turnId ? lastByTurn.get(row.turnId) ?? messages.length - 1 : messages.length - 1
      const group = after.get(index) ?? []
      group.push(presentationMessages.value.get(row.id)!)
      after.set(index, group)
    }
    if (!after.size) return messages
    if (!messages.length) return after.get(-1) ?? []
    return messages.flatMap((message, index) => [message, ...(after.get(index) ?? [])])
  }

  function start(): void {
    refresh()
    window.addEventListener?.(DELIVERY_VIEW_EVENT, refresh)
    window.addEventListener?.(DELIVERY_OUTBOX_EVENT, refresh)
    window.addEventListener?.('storage', refresh)
  }

  function stop(): void {
    window.removeEventListener?.(DELIVERY_VIEW_EVENT, refresh)
    window.removeEventListener?.(DELIVERY_OUTBOX_EVENT, refresh)
    window.removeEventListener?.('storage', refresh)
  }

  return { rows, begin, update, patch, replaceId, observe, project, syncQueue, refresh, start, stop }
}
