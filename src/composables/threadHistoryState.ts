export function createThreadHistoryState() {
  const pendingThreadMessageRefresh = new Set<string>()
  const messageHistoryRevisionByThreadId = new Map<string, number>()
  const loadedHistoryRevisionByThreadId = new Map<string, number>()

  function markDirty(threadId: string): void {
    messageHistoryRevisionByThreadId.set(threadId, (messageHistoryRevisionByThreadId.get(threadId) ?? 0) + 1)
    pendingThreadMessageRefresh.add(threadId)
  }

  return {
    markDirty,
    getRevision: (threadId: string) => messageHistoryRevisionByThreadId.get(threadId) ?? 0,
    getLoadedRevision: (threadId: string) => loadedHistoryRevisionByThreadId.get(threadId) ?? 0,
    setLoadedRevision: (threadId: string, revision: number) => {
      loadedHistoryRevisionByThreadId.set(threadId, revision)
    },
    queueRefresh: (threadId: string) => {
      pendingThreadMessageRefresh.add(threadId)
    },
    takePendingThreadIds: () => {
      const threadIds = [...pendingThreadMessageRefresh]
      pendingThreadMessageRefresh.clear()
      return threadIds
    },
    clearPendingRefreshes: () => {
      pendingThreadMessageRefresh.clear()
    },
    prune: (activeThreadIds: Set<string>) => {
      for (const map of [messageHistoryRevisionByThreadId, loadedHistoryRevisionByThreadId]) {
        for (const threadId of map.keys()) {
          if (!activeThreadIds.has(threadId)) map.delete(threadId)
        }
      }
    },
    invalidateForAccountChange: (threadIds: Iterable<string>) => {
      pendingThreadMessageRefresh.clear()
      for (const threadId of threadIds) {
        loadedHistoryRevisionByThreadId.set(threadId, -1)
      }
    },
    get pendingThreadIds() {
      return [...pendingThreadMessageRefresh]
    },
  }
}
