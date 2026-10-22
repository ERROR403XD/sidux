import type { Ref } from 'vue'
import type { UiMessage } from '../types/codex'
import { areMessageArraysEqual, upsertMessage } from '../messageIdentity'

function omitKey<TValue>(record: Record<string, TValue>, key: string): Record<string, TValue> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

function prunePlanMap(
  messagesByThreadId: Record<string, UiMessage[]>,
  activeThreadIds: Set<string>,
): Record<string, UiMessage[]> {
  const nextEntries = Object.entries(messagesByThreadId).filter(([threadId]) => activeThreadIds.has(threadId))
  if (nextEntries.length === Object.keys(messagesByThreadId).length) {
    return messagesByThreadId
  }
  return Object.fromEntries(nextEntries)
}

type ThreadLivePlanStateOptions = {
  messagesByThreadId: Ref<Record<string, UiMessage[]>>
}

export function createThreadLivePlanState({ messagesByThreadId }: ThreadLivePlanStateOptions) {
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
    findMessage: (threadId: string, messageId: string): UiMessage | undefined => {
      return getMessages(threadId).find(message => message.id === messageId)
    },
    upsert: (threadId: string, message: UiMessage): void => {
      write(threadId, upsertMessage(getMessages(threadId), message))
    },
    clear: (threadId: string): void => {
      if (!threadId || !(threadId in messagesByThreadId.value)) return
      messagesByThreadId.value = omitKey(messagesByThreadId.value, threadId)
    },
    prune: (activeThreadIds: Set<string>) => {
      messagesByThreadId.value = prunePlanMap(messagesByThreadId.value, activeThreadIds)
    },
    reset: () => {
      messagesByThreadId.value = {}
    },
  }
}
