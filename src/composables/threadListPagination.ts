import type { Ref } from 'vue'
import type { ThreadGroupsPage } from '../api/threadReadGateway'

type ThreadListPaginationOptions = {
  isFullyLoaded: Ref<boolean>
  getAccountRevision: () => number
  getStatusRevisions?: () => Map<string, number>
  loadPage: (cursor: string, limit: number) => Promise<ThreadGroupsPage>
  getLimit: () => number
  delayMs: number
  scheduleTimeout: (callback: () => void, delay: number) => number
  cancelTimeout: (timer: number) => void
}

export function createThreadListPagination({
  isFullyLoaded,
  getAccountRevision,
  getStatusRevisions = () => new Map<string, number>(),
  loadPage,
  getLimit,
  delayMs,
  scheduleTimeout,
  cancelTimeout,
}: ThreadListPaginationOptions) {
  let nextCursor: string | null = null
  let backgroundTimer: number | null = null
  let isLoadingRemainingPages = false
  let hasLoadedAllPages = true
  let active = true
  let lifecycleGeneration = 0

  function cursorAfterFirstPage(pageNextCursor: string | null, reusesPendingPages: boolean): string | null {
    return reusesPendingPages && !hasLoadedAllPages ? nextCursor : pageNextCursor
  }

  function completeFirstPage(pageNextCursor: string | null, reusesPendingPages: boolean): void {
    nextCursor = cursorAfterFirstPage(pageNextCursor, reusesPendingPages)
    hasLoadedAllPages = nextCursor === null
    isFullyLoaded.value = hasLoadedAllPages
  }

  function resetForAccountChange(): void {
    lifecycleGeneration += 1
    cancelBackgroundTimer()
    isLoadingRemainingPages = false
    nextCursor = null
    hasLoadedAllPages = true
    isFullyLoaded.value = true
  }

  function cancelBackgroundTimer(): void {
    if (backgroundTimer !== null) {
      cancelTimeout(backgroundTimer)
      backgroundTimer = null
    }
  }

  function stop(): void {
    active = false
    lifecycleGeneration += 1
    isLoadingRemainingPages = false
    cancelBackgroundTimer()
  }

  function start(): void {
    active = true
  }

  function scheduleRemainingPages(run: () => Promise<void>): void {
    // Keep the pending deadline even when live conversations refresh the list.
    if (!active || !nextCursor || isLoadingRemainingPages || backgroundTimer !== null) return
    const generation = lifecycleGeneration
    backgroundTimer = scheduleTimeout(() => {
      if (!active || generation !== lifecycleGeneration) return
      backgroundTimer = null
      if (!nextCursor) return
      void run()
    }, delayMs)
  }

  async function loadRemainingPages(
    applyPage: (page: ThreadGroupsPage, statusRevisions: Map<string, number>) => void,
  ): Promise<void> {
    if (!active || isLoadingRemainingPages || !nextCursor) return
    isLoadingRemainingPages = true
    const accountRevision = getAccountRevision()
    const generation = lifecycleGeneration
    const statusRevisions = getStatusRevisions()
    try {
      const page = await loadPage(nextCursor, getLimit())
      if (!active || generation !== lifecycleGeneration || accountRevision !== getAccountRevision()) return
      nextCursor = page.nextCursor
      hasLoadedAllPages = page.nextCursor === null
      isFullyLoaded.value = hasLoadedAllPages
      applyPage(page, statusRevisions)
    } catch {
      // The first page remains usable; a later refresh can retry remaining pages.
    } finally {
      if (active && generation === lifecycleGeneration && accountRevision === getAccountRevision()) {
        isLoadingRemainingPages = false
        if (nextCursor) {
          scheduleRemainingPages(() => loadRemainingPages(applyPage))
        }
      }
    }
  }

  return {
    cursorAfterFirstPage,
    completeFirstPage,
    resetForAccountChange,
    start,
    stop,
    scheduleRemainingPages,
    loadRemainingPages,
    get isLoadingRemainingPages() {
      return isLoadingRemainingPages
    },
    get nextCursor() {
      return nextCursor
    },
  }
}
