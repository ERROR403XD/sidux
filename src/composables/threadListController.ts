import { computed, ref } from 'vue'
import { getWorkspaceRootsState, type WorkspaceRootsState } from '../api/projectGateway'
import { getBackgroundThreadListLimit, getThreadGroupsPage, type ThreadGroupsPage } from '../api/threadReadGateway'
import type { UiProjectGroup, UiThread } from '../types/codex'
import { createThreadListPagination } from './threadListPagination'
import { createThreadListRequestState } from './threadListRequestState'
import { createThreadListSnapshotState } from './threadListSnapshotState'

type ThreadListControllerOptions = {
  getAccountRevision: () => number
  getStatusRevisions: () => Map<string, number>
  applyListedStatuses: (groups: UiProjectGroup[], revisions: Map<string, number>) => void
  loadTitleCache: (options: { force: boolean }) => Promise<void>
  hydrateWorkspace: (groups: UiProjectGroup[], rootsState: WorkspaceRootsState | null) => Promise<void>
  view: {
    commitGroups: (groups: UiProjectGroup[], rootsState: WorkspaceRootsState | null) => void
    getVisibleThreads: () => UiThread[]
    pruneThreadState: (threads: UiThread[]) => void
    getSelectedThreadId: () => string
    setSelectedThreadId: (threadId: string) => void
  }
  reuseMs: number
  paginationDelayMs: number
  scheduleTimeout: (callback: () => void, delay: number) => number
  cancelTimeout: (timer: number) => void
}

export function createThreadListController({
  getAccountRevision,
  getStatusRevisions,
  applyListedStatuses,
  loadTitleCache,
  hydrateWorkspace,
  view,
  reuseMs,
  paginationDelayMs,
  scheduleTimeout,
  cancelTimeout,
}: ThreadListControllerOptions) {
  const isLoadingThreads = ref(false)
  const isThreadListFullyLoaded = ref(false)
  const hasLoadedThreads = ref(false)
  let lastThreadListLoadAt = 0
  const pagination = createThreadListPagination({
    isFullyLoaded: isThreadListFullyLoaded,
    getAccountRevision,
    getStatusRevisions,
    loadPage: getThreadGroupsPage,
    getLimit: getBackgroundThreadListLimit,
    delayMs: paginationDelayMs,
    scheduleTimeout,
    cancelTimeout,
  })
  const snapshot = createThreadListSnapshotState({ commit: view.commitGroups })
  const request = createThreadListRequestState<{
    page: ThreadGroupsPage
    rootsState: WorkspaceRootsState | null
  }>({
    getAccountRevision,
    getHasLoaded: () => hasLoadedThreads.value,
    setLoading: loading => {
      isLoadingThreads.value = loading
    },
    beginRequest: force => ({
      accountRevision: getAccountRevision(),
      statusRevisions: getStatusRevisions(),
      force,
    }),
    load: async context => {
      const [page, rootsState] = await Promise.all([
        getThreadGroupsPage(),
        loadWorkspaceRootsState(),
        loadTitleCache({ force: context.force }),
      ])
      return { page, rootsState }
    },
    apply: async ({ page, rootsState }, context) => {
      if (context.accountRevision !== getAccountRevision()) return
      applyListedStatuses(page.groups, context.statusRevisions)
      pagination.completeFirstPage(page.nextCursor, hasLoadedThreads.value)
      const groups = page.groups
      await hydrateWorkspace(groups, rootsState)
      if (!request.isCurrentContext(context)) return
      snapshot.commitFirstPage(groups, rootsState)
      hasLoadedThreads.value = true
      lastThreadListLoadAt = Date.now()
      const shouldScheduleRemainingPages = !isThreadListFullyLoaded.value

      const flatThreads = view.getVisibleThreads()
      view.pruneThreadState(flatThreads)
      const currentExists = flatThreads.some(thread => thread.id === view.getSelectedThreadId())
      if (!currentExists && !view.getSelectedThreadId()) {
        view.setSelectedThreadId(flatThreads[0]?.id ?? '')
      }
      if (shouldScheduleRemainingPages) {
        scheduleRemainingPages()
      }
    },
  })

  async function loadWorkspaceRootsState(): Promise<WorkspaceRootsState | null> {
    try {
      return await getWorkspaceRootsState()
    } catch {
      return null
    }
  }

  function scheduleRemainingPages(): void {
    if (!pagination.nextCursor || pagination.isLoadingRemainingPages) return
    if (typeof window === 'undefined') {
      void loadRemainingPages()
      return
    }
    pagination.scheduleRemainingPages(loadRemainingPages)
  }

  async function loadRemainingPages(): Promise<void> {
    await pagination.loadRemainingPages((page, revisions) => {
      applyListedStatuses(page.groups, revisions)
      snapshot.commitRemainingPage(page.groups, snapshot.rootsState)
    })
  }

  async function loadThreads(options: { force?: boolean } = {}): Promise<void> {
    if (
      options.force !== true &&
      !pagination.isLoadingRemainingPages &&
      hasLoadedThreads.value &&
      Date.now() - lastThreadListLoadAt < reuseMs
    ) {
      return
    }
    await request.loadList({ force: options.force === true })
  }

  function resetForAccountChange(): void {
    request.resetForAccountChange()
    hasLoadedThreads.value = false
    snapshot.reset()
    pagination.resetForAccountChange()
    lastThreadListLoadAt = 0
  }

  function stop(): void {
    request.stop()
    pagination.stop()
  }

  return {
    isLoadingThreads: computed(() => isLoadingThreads.value),
    isThreadListFullyLoaded: computed(() => isThreadListFullyLoaded.value),
    hasLoadedThreads: computed(() => hasLoadedThreads.value),
    get hasNextPage() {
      return pagination.nextCursor !== null
    },
    get rootsState(): Readonly<WorkspaceRootsState> | null {
      return snapshot.rootsState
    },
    loadThreads,
    scheduleRemainingPages,
    removeThread: snapshot.removeThread,
    resetForAccountChange,
    start: pagination.start,
    stop,
  }
}
