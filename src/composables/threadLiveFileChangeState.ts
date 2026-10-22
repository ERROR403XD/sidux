import type { Ref } from 'vue'
import type { UiMessage } from '../types/codex'
import { areMessageArraysEqual, upsertMessage } from '../messageIdentity'

function omitKey<TValue>(record: Record<string, TValue>, key: string): Record<string, TValue> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

function pruneFileChangeMap(
  messagesByThreadId: Record<string, UiMessage[]>,
  activeThreadIds: Set<string>,
): Record<string, UiMessage[]> {
  const nextEntries = Object.entries(messagesByThreadId).filter(([threadId]) => activeThreadIds.has(threadId))
  if (nextEntries.length === Object.keys(messagesByThreadId).length) {
    return messagesByThreadId
  }
  return Object.fromEntries(nextEntries)
}

type ThreadLiveFileChangeStateOptions = {
  messagesByThreadId: Ref<Record<string, UiMessage[]>>
}

export function createThreadLiveFileChangeState({ messagesByThreadId }: ThreadLiveFileChangeStateOptions) {
  function getMessages(threadId: string): UiMessage[] {
    return messagesByThreadId.value[threadId] ?? []
  }

  function write(threadId: string, nextMessages: UiMessage[]): void {
    const previous = getMessages(threadId)
    if (areMessageArraysEqual(previous, nextMessages)) return
    messagesByThreadId.value = {
      ...messagesByThreadId.value,
      [threadId]: nextMessages,
    }
  }

  return {
    getMessages,
    set: write,
    upsert: (threadId: string, message: UiMessage): void => {
      write(threadId, upsertMessage(getMessages(threadId), message))
    },
    rebindTurnIndices: (threadId: string, turnIndexByTurnId: Record<string, number>): void => {
      const current = messagesByThreadId.value[threadId]
      if (!current || current.length === 0) return

      let changed = false
      const next = current.map((message) => {
        if (!message.turnId) return message
        const turnIndex = turnIndexByTurnId[message.turnId]
        if (typeof turnIndex !== 'number' || turnIndex === message.turnIndex) return message
        changed = true
        return { ...message, turnIndex }
      })

      if (!changed) return
      messagesByThreadId.value = {
        ...messagesByThreadId.value,
        [threadId]: next,
      }
    },
    removePersistedIn: (threadId: string, persistedMessages: UiMessage[]): void => {
      const current = messagesByThreadId.value[threadId]
      if (!current || current.length === 0) return
      const persistedIds = new Set(persistedMessages.map(message => message.id))
      const persistedTurnIds = new Set(
        persistedMessages
          .filter(message => message.messageType === 'fileChange' && typeof message.turnId === 'string' && message.turnId.length > 0)
          .map(message => message.turnId as string),
      )
      const persistedTurnIndices = new Set(
        persistedMessages
          .filter(message => message.messageType === 'fileChange' && typeof message.turnIndex === 'number')
          .map(message => message.turnIndex as number),
      )
      const next = current.filter(message => (
        !persistedIds.has(message.id)
        && !(message.turnId && persistedTurnIds.has(message.turnId))
        && !(typeof message.turnIndex === 'number' && persistedTurnIndices.has(message.turnIndex))
      ))
      if (next.length === current.length) return
      if (next.length === 0) {
        messagesByThreadId.value = omitKey(messagesByThreadId.value, threadId)
      } else {
        messagesByThreadId.value = { ...messagesByThreadId.value, [threadId]: next }
      }
    },
    clear: (threadId: string): void => {
      if (!threadId || !(threadId in messagesByThreadId.value)) return
      messagesByThreadId.value = omitKey(messagesByThreadId.value, threadId)
    },
    prune: (activeThreadIds: Set<string>) => {
      messagesByThreadId.value = pruneFileChangeMap(messagesByThreadId.value, activeThreadIds)
    },
    reset: () => {
      messagesByThreadId.value = {}
    },
  }
}
