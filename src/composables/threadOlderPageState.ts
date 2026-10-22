import type { Ref } from 'vue'

type ThreadOlderPageStateOptions = {
  hasMoreByThreadId: Ref<Record<string, boolean>>
  loadingByThreadId: Ref<Record<string, boolean>>
}

export function createThreadOlderPageState({
  hasMoreByThreadId,
  loadingByThreadId,
}: ThreadOlderPageStateOptions) {
  function setHasMore(threadId: string, hasMore: boolean): void {
    hasMoreByThreadId.value = { ...hasMoreByThreadId.value, [threadId]: hasMore }
  }

  function begin(threadId: string): boolean {
    if (loadingByThreadId.value[threadId] === true) return false
    if (hasMoreByThreadId.value[threadId] !== true) return false
    loadingByThreadId.value = { ...loadingByThreadId.value, [threadId]: true }
    return true
  }

  function complete(threadId: string, hasMore: boolean): void {
    setHasMore(threadId, hasMore)
  }

  function finish(threadId: string): void {
    loadingByThreadId.value = { ...loadingByThreadId.value, [threadId]: false }
  }

  function reset(): void {
    hasMoreByThreadId.value = {}
    loadingByThreadId.value = {}
  }

  return {
    setHasMore,
    begin,
    complete,
    finish,
    resetLoading: () => {
      loadingByThreadId.value = {}
    },
    reset,
  }
}
