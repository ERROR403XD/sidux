import type { Ref } from 'vue'
import type { UiMessage } from '../types/codex'
import { areMessageArraysEqual, upsertMessage } from '../messageIdentity'

function omitKey<TValue>(record: Record<string, TValue>, key: string): Record<string, TValue> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

function pruneAgentMap(
  messagesByThreadId: Record<string, readonly UiMessage[]>,
  activeThreadIds: Set<string>,
): Record<string, readonly UiMessage[]> {
  const nextEntries = Object.entries(messagesByThreadId).filter(([threadId]) => activeThreadIds.has(threadId))
  if (nextEntries.length === Object.keys(messagesByThreadId).length) {
    return messagesByThreadId
  }
  return Object.fromEntries(nextEntries)
}

type ThreadLiveAgentStateOptions = {
  messagesByThreadId: Ref<Record<string, readonly UiMessage[]>>
}

export function createThreadLiveAgentState({ messagesByThreadId }: ThreadLiveAgentStateOptions) {
  function getMessages(threadId: string): readonly UiMessage[] {
    return messagesByThreadId.value[threadId] ?? []
  }

  function write(threadId: string, nextMessages: readonly UiMessage[]): void {
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
    findMessage: (threadId: string, messageId: string): UiMessage | undefined => {
      return getMessages(threadId).find(message => message.id === messageId)
    },
    upsert: (threadId: string, message: UiMessage, fallbackTurnId?: string): void => {
      const nextMessage = { ...message, turnId: message.turnId || fallbackTurnId }
      write(threadId, upsertMessage(getMessages(threadId), nextMessage))
    },
    clear: (threadId: string): void => {
      if (!threadId || !(threadId in messagesByThreadId.value)) return
      messagesByThreadId.value = omitKey(messagesByThreadId.value, threadId)
    },
    prune: (activeThreadIds: Set<string>) => {
      messagesByThreadId.value = pruneAgentMap(messagesByThreadId.value, activeThreadIds)
    },
    reset: () => {
      messagesByThreadId.value = {}
    },
  }
}
