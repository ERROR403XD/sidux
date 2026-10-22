import type { Ref } from 'vue'
import type { StoredQueuedMessage, ThreadQueueState } from '../threadQueue'

function omitKey<TValue>(record: Record<string, TValue>, key: string): Record<string, TValue> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

type ThreadQueueUiStateOptions = {
  queuedMessagesByThreadId: Ref<Record<string, StoredQueuedMessage[]>>
  errorByThreadId: Ref<Record<string, string>>
  globalError: Ref<string>
  processingByThreadId: Ref<Record<string, boolean>>
}

export function createThreadQueueUiState({
  queuedMessagesByThreadId,
  errorByThreadId,
  globalError,
  processingByThreadId,
}: ThreadQueueUiStateOptions) {
  function getMessages(threadId: string): StoredQueuedMessage[] {
    return queuedMessagesByThreadId.value[threadId] ?? []
  }

  return {
    getMessages,
    findMessage: (threadId: string, messageId: string): StoredQueuedMessage | undefined => {
      return getMessages(threadId).find(message => message.id === messageId)
    },
    setState: (state: ThreadQueueState): void => {
      queuedMessagesByThreadId.value = state
    },
    clearThreadError: (threadId: string): void => {
      errorByThreadId.value = omitKey(errorByThreadId.value, threadId)
    },
    setThreadError: (threadId: string, message: string): void => {
      errorByThreadId.value = { ...errorByThreadId.value, [threadId]: message }
    },
    clearGlobalError: (): void => {
      globalError.value = ''
    },
    setGlobalError: (message: string): void => {
      globalError.value = message
    },
    beginProcessing: (threadId: string): boolean => {
      if (processingByThreadId.value[threadId] === true) return false
      processingByThreadId.value = {
        ...processingByThreadId.value,
        [threadId]: true,
      }
      return true
    },
    finishProcessing: (threadId: string): void => {
      processingByThreadId.value = omitKey(processingByThreadId.value, threadId)
    },
    reset: (): void => {
      queuedMessagesByThreadId.value = {}
      errorByThreadId.value = {}
      globalError.value = ''
      processingByThreadId.value = {}
    },
  }
}
