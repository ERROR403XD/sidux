import type { Ref } from 'vue'

function omitKey<TValue>(record: Record<string, TValue>, key: string): Record<string, TValue> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

function pruneThreadStateMap<T>(stateMap: Record<string, T>, threadIds: Set<string>): Record<string, T> {
  const nextEntries = Object.entries(stateMap).filter(([threadId]) => threadIds.has(threadId))
  if (nextEntries.length === Object.keys(stateMap).length) {
    return stateMap
  }
  return Object.fromEntries(nextEntries) as Record<string, T>
}

type ThreadLoadedStateOptions = {
  loadedByThreadId: Ref<Record<string, boolean>>
}

export function createThreadLoadedState({ loadedByThreadId }: ThreadLoadedStateOptions) {
  return {
    isLoaded: (threadId: string) => loadedByThreadId.value[threadId] === true,
    markLoaded: (threadId: string) => {
      loadedByThreadId.value = { ...loadedByThreadId.value, [threadId]: true }
    },
    clear: (threadId: string) => {
      loadedByThreadId.value = omitKey(loadedByThreadId.value, threadId)
    },
    prune: (activeThreadIds: Set<string>) => {
      loadedByThreadId.value = pruneThreadStateMap(loadedByThreadId.value, activeThreadIds)
    },
    reset: () => {
      loadedByThreadId.value = {}
    },
  }
}
