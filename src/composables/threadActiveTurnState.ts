import type { Ref } from 'vue'

function omitKey<TValue>(record: Record<string, TValue>, key: string): Record<string, TValue> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

function pruneActiveTurnMap(
  turnIdByThreadId: Record<string, string>,
  activeThreadIds: Set<string>,
): Record<string, string> {
  const nextEntries = Object.entries(turnIdByThreadId).filter(([threadId]) => activeThreadIds.has(threadId))
  if (nextEntries.length === Object.keys(turnIdByThreadId).length) {
    return turnIdByThreadId
  }
  return Object.fromEntries(nextEntries)
}

type ThreadActiveTurnStateOptions = {
  turnIdByThreadId: Ref<Record<string, string>>
}

export function createThreadActiveTurnState({ turnIdByThreadId }: ThreadActiveTurnStateOptions) {
  return {
    getTurnId: (threadId: string): string | undefined => {
      return turnIdByThreadId.value[threadId]
    },
    setTurnId: (threadId: string, turnId: string): void => {
      if (!threadId || !turnId || turnIdByThreadId.value[threadId] === turnId) return
      turnIdByThreadId.value = {
        ...turnIdByThreadId.value,
        [threadId]: turnId,
      }
    },
    clear: (threadId: string): void => {
      if (!threadId || !(threadId in turnIdByThreadId.value)) return
      turnIdByThreadId.value = omitKey(turnIdByThreadId.value, threadId)
    },
    prune: (activeThreadIds: Set<string>) => {
      turnIdByThreadId.value = pruneActiveTurnMap(turnIdByThreadId.value, activeThreadIds)
    },
    reset: () => {
      turnIdByThreadId.value = {}
    },
  }
}
