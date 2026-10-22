import type { Ref } from 'vue'
import type { UiMessage } from '../types/codex'
import { upsertMessage } from '../messageIdentity'

function omitKey<TValue>(record: Record<string, TValue>, key: string): Record<string, TValue> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

function pruneCommandMap(
  commandsByThreadId: Record<string, UiMessage[]>,
  activeThreadIds: Set<string>,
): Record<string, UiMessage[]> {
  const nextEntries = Object.entries(commandsByThreadId).filter(([threadId]) => activeThreadIds.has(threadId))
  if (nextEntries.length === Object.keys(commandsByThreadId).length) {
    return commandsByThreadId
  }
  return Object.fromEntries(nextEntries)
}

type ThreadLiveCommandStateOptions = {
  commandsByThreadId: Ref<Record<string, UiMessage[]>>
}

export function createThreadLiveCommandState({ commandsByThreadId }: ThreadLiveCommandStateOptions) {
  function getMessages(threadId: string): UiMessage[] {
    return commandsByThreadId.value[threadId] ?? []
  }

  return {
    getMessages,
    findMessage: (threadId: string, messageId: string): UiMessage | undefined => {
      return getMessages(threadId).find(message => message.id === messageId)
    },
    upsert: (threadId: string, message: UiMessage): void => {
      const previous = getMessages(threadId)
      const next = upsertMessage(previous, message)
      if (next === previous) return
      commandsByThreadId.value = { ...commandsByThreadId.value, [threadId]: next }
    },
    removePersistedIn: (threadId: string, persistedMessages: UiMessage[]): void => {
      const current = commandsByThreadId.value[threadId]
      if (!current || current.length === 0) return
      const persistedIds = new Set(persistedMessages.map(message => message.id))
      const next = current.filter(message => !persistedIds.has(message.id))
      if (next.length === current.length) return
      if (next.length === 0) {
        commandsByThreadId.value = omitKey(commandsByThreadId.value, threadId)
      } else {
        commandsByThreadId.value = { ...commandsByThreadId.value, [threadId]: next }
      }
    },
    clear: (threadId: string): void => {
      if (!threadId || !(threadId in commandsByThreadId.value)) return
      commandsByThreadId.value = omitKey(commandsByThreadId.value, threadId)
    },
    prune: (activeThreadIds: Set<string>) => {
      commandsByThreadId.value = pruneCommandMap(commandsByThreadId.value, activeThreadIds)
    },
    reset: () => {
      commandsByThreadId.value = {}
    },
  }
}
