import type { UiMessage } from './types/codex'

/** History may replace synthetic item-N IDs at completion. Ordinals are scoped to a turn. */
export function historyMessageKey(message: UiMessage): string {
  return message.turnId && message.historyOrdinal !== undefined
    ? JSON.stringify([message.turnId, message.role, message.messageType?.replace(/\.live$/, ''), message.historyOrdinal])
    : JSON.stringify([message.turnId || '', message.id])
}

export function sameMessageIdentity(a: UiMessage, b: UiMessage): boolean {
  if (a.turnId && b.turnId && a.turnId !== b.turnId) return false
  if (a.id === b.id) return true
  return !!a.turnId && a.turnId === b.turnId && a.historyOrdinal !== undefined && a.historyOrdinal === b.historyOrdinal && a.role === b.role && a.messageType?.replace(/\.live$/, '') === b.messageType?.replace(/\.live$/, '')
}

export function combineHistoryAndLive(history: UiMessage[], live: UiMessage[]): UiMessage[] {
  const indexed = new Map(history.map(message => [JSON.stringify([message.turnId || '', message.id]), message]))
  const result = [...history]
  for (const message of live) {
    const persisted = indexed.get(JSON.stringify([message.turnId || '', message.id]))
      || (!message.turnId ? history.find(row => row.id === message.id) : undefined)
    if (!persisted) {
      result.push(message)
      indexed.set(JSON.stringify([message.turnId || '', message.id]), message)
    }
    // The canonical record owns a completed item. A longer live delta may precede the next snapshot.
    else if (message.messageType === 'agentMessage.live' && message.text.length > persisted.text.length && message.text.startsWith(persisted.text)) {
      const index = result.indexOf(persisted)
      if (index >= 0) result[index] = { ...persisted, text: message.text }
    }
  }
  return result
}

/** Native item IDs may be reconstructed and reused by a different turn. */
export function messageRenderKey(message: UiMessage, threadId: string): string {
  return JSON.stringify([threadId, message.turnId || '', message.id])
}
