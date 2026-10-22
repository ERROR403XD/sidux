import type { Ref } from 'vue'
import type { UiMessage } from '../types/codex'

function pruneTurnOrderMap(
  turnOrderByThreadId: Record<string, Record<string, number>>,
  activeThreadIds: Set<string>,
): Record<string, Record<string, number>> {
  const nextEntries = Object.entries(turnOrderByThreadId).filter(([threadId]) => activeThreadIds.has(threadId))
  if (nextEntries.length === Object.keys(turnOrderByThreadId).length) {
    return turnOrderByThreadId
  }
  return Object.fromEntries(nextEntries)
}

type ThreadTurnOrderStateOptions = {
  turnIndexByTurnIdByThreadId: Ref<Record<string, Record<string, number>>>
}

export function createThreadTurnOrderState({
  turnIndexByTurnIdByThreadId,
}: ThreadTurnOrderStateOptions) {
  return {
    getLookup: (threadId: string): Record<string, number> => {
      return turnIndexByTurnIdByThreadId.value[threadId] ?? {}
    },
    getTurnIndex: (threadId: string, turnId: string): number | undefined => {
      return turnIndexByTurnIdByThreadId.value[threadId]?.[turnId]
    },
    maxTurnIndex: (threadId: string): number => {
      return Math.max(-1, ...Object.values(turnIndexByTurnIdByThreadId.value[threadId] ?? {}))
    },
    nextTurnIndex: (threadId: string, persistedMessages: readonly UiMessage[]): number => {
      let maxTurnIndex = Math.max(-1, ...Object.values(turnIndexByTurnIdByThreadId.value[threadId] ?? {}))
      for (const message of persistedMessages) {
        if (typeof message.turnIndex === 'number' && Number.isFinite(message.turnIndex)) {
          maxTurnIndex = Math.max(maxTurnIndex, message.turnIndex)
        }
      }
      return maxTurnIndex + 1
    },
    set: (threadId: string, turnId: string, turnIndex: number): void => {
      if (!threadId || !turnId || !Number.isInteger(turnIndex) || turnIndex < 0) return
      const previous = turnIndexByTurnIdByThreadId.value[threadId] ?? {}
      if (previous[turnId] === turnIndex) return
      turnIndexByTurnIdByThreadId.value = {
        ...turnIndexByTurnIdByThreadId.value,
        [threadId]: {
          ...previous,
          [turnId]: turnIndex,
        },
      }
    },
    replace: (threadId: string, nextLookup: Record<string, number>): void => {
      const previous = turnIndexByTurnIdByThreadId.value[threadId] ?? {}
      const previousEntries = Object.entries(previous)
      const nextEntries = Object.entries(nextLookup)
      if (
        previousEntries.length === nextEntries.length
        && previousEntries.every(([turnId, turnIndex]) => nextLookup[turnId] === turnIndex)
      ) {
        return
      }

      turnIndexByTurnIdByThreadId.value = {
        ...turnIndexByTurnIdByThreadId.value,
        [threadId]: { ...nextLookup },
      }
    },
    prune: (activeThreadIds: Set<string>) => {
      turnIndexByTurnIdByThreadId.value = pruneTurnOrderMap(turnIndexByTurnIdByThreadId.value, activeThreadIds)
    },
    reset: () => {
      turnIndexByTurnIdByThreadId.value = {}
    },
  }
}
