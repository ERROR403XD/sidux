import { computed, type ComputedRef, type Ref } from 'vue'
import { createThreadMatcher } from '../threadSearchMatch'
import { matchesSidebarThreadFilter, type SidebarThreadFilter } from '../sidebarThreadFilter'
import { isVirtualProjectId } from '../projectOrganization'
import { isProjectlessChatPath } from '../pathUtils.js'
import type { UiProjectGroup, UiThread } from '../types/codex'

export type ChatSortMode = 'created' | 'updated'
export type { SidebarThreadFilter }

export type SidebarThreadProjectionInput = {
  groups: Ref<UiProjectGroup[]>
  statusFilter: Ref<SidebarThreadFilter | undefined>
  retainedThreadId: Ref<string | undefined>
  activeRetainedIds: Ref<ReadonlySet<string> | undefined>
  quotaInterrupted: Ref<Record<string, boolean | null> | undefined>
  optimisticallyArchivedThreadIds: Ref<string[]>
  pinnedThreadIds: Ref<string[]>
  searchQuery: Ref<string>
  searchMatchedThreadIds: Ref<string[] | null>
  chatSortMode: Ref<ChatSortMode>
}

export type SidebarThreadProjection = {
  isStatusFilterActive: ComputedRef<boolean>
  isSearchActive: ComputedRef<boolean>
  filteredGroups: ComputedRef<UiProjectGroup[]>
  globalThreads: ComputedRef<UiThread[]>
  chatThreads: ComputedRef<UiThread[]>
  pinnedThreadIdSet: ComputedRef<Set<string>>
  optimisticallyArchivedThreadIdSet: ComputedRef<Set<string>>
  threadById: ComputedRef<Map<string, UiThread>>
  threadTimestampById: ComputedRef<Map<string, number>>
  unpinnedThreadsByProjectName: ComputedRef<Map<string, UiThread[]>>
  threadMatchesSearch: (thread: UiThread) => boolean
  compareSearchRank: (first: UiThread, second: UiThread) => number
}

export function useSidebarThreadProjection(input: SidebarThreadProjectionInput): SidebarThreadProjection {
  const isStatusFilterActive = computed(() => !!input.statusFilter.value && input.statusFilter.value !== 'all')
  const normalizedSearchQuery = computed(() => input.searchQuery.value.trim().toLowerCase())
  const isSearchActive = computed(() => normalizedSearchQuery.value.length > 0)
  const matchedThreadIdSet = computed(() => {
    if (!input.searchMatchedThreadIds.value) return null
    return new Set(input.searchMatchedThreadIds.value)
  })
  const searchRank = computed(() => new Map((input.searchMatchedThreadIds.value ?? []).map((id, index) => [id, index])))
  const matchSearchTitle = computed(() => createThreadMatcher(input.searchQuery.value))
  const pinnedThreadIdSet = computed(() => new Set(input.pinnedThreadIds.value))
  const optimisticallyArchivedThreadIdSet = computed(() => new Set(input.optimisticallyArchivedThreadIds.value))

  function threadMatchesStatus(thread: UiThread): boolean {
    return matchesSidebarThreadFilter(
      thread,
      input.statusFilter.value || 'all',
      input.retainedThreadId.value || '',
      input.quotaInterrupted.value || {},
      input.activeRetainedIds.value,
    )
  }

  function compareSearchRank(first: UiThread, second: UiThread): number {
    if (!isSearchActive.value) return 0
    if (input.searchMatchedThreadIds.value) {
      return (searchRank.value.get(first.id) ?? Infinity) - (searchRank.value.get(second.id) ?? Infinity)
    }
    return matchSearchTitle.value(second.title) - matchSearchTitle.value(first.title)
  }

  function threadMatchesSearch(thread: UiThread): boolean {
    if (optimisticallyArchivedThreadIdSet.value.has(thread.id)) return false
    if (!threadMatchesStatus(thread)) return false
    if (!isSearchActive.value) return true
    if (matchedThreadIdSet.value) return matchedThreadIdSet.value.has(thread.id)
    return matchSearchTitle.value(thread.title) > 0
  }

  const filteredGroups = computed<UiProjectGroup[]>(() => input.groups.value.flatMap((group) => {
    const threads = group.threads
      .filter((thread) => (isVirtualProjectId(group.projectName) || !isProjectlessChatPath(thread.cwd)) && threadMatchesSearch(thread))
      .sort(compareSearchRank)
    if (threads.length > 0) return [{ ...group, threads }]
    return !isSearchActive.value && !isStatusFilterActive.value && group.threads.length === 0 ? [{ ...group, threads }] : []
  }).sort((first, second) => isSearchActive.value ? compareSearchRank(first.threads[0]!, second.threads[0]!) : 0))

  const globalThreads = computed<UiThread[]>(() => {
    const rows: UiThread[] = []
    for (const group of input.groups.value) {
      for (const thread of group.threads) {
        if (pinnedThreadIdSet.value.has(thread.id)) continue
        if (!threadMatchesSearch(thread)) continue
        rows.push(thread)
      }
    }
    return rows.sort((first, second) => {
      const firstTimestamp = new Date(first.updatedAtIso || first.createdAtIso).getTime()
      const secondTimestamp = new Date(second.updatedAtIso || second.createdAtIso).getTime()
      return compareSearchRank(first, second) || secondTimestamp - firstTimestamp
    })
  })

  const chatThreads = computed(() => {
    const rows = globalThreads.value.filter((thread) => !isVirtualProjectId(thread.projectName) && isProjectlessChatPath(thread.cwd))
    const timestampKey = input.chatSortMode.value === 'created' ? 'createdAtIso' : 'updatedAtIso'
    return rows.sort((first, second) => {
      const firstTimestamp = new Date(first[timestampKey] || first.updatedAtIso || first.createdAtIso).getTime()
      const secondTimestamp = new Date(second[timestampKey] || second.updatedAtIso || second.createdAtIso).getTime()
      return compareSearchRank(first, second) || secondTimestamp - firstTimestamp
    })
  })

  const threadById = computed(() => {
    const map = new Map<string, UiThread>()
    for (const group of input.groups.value) {
      for (const thread of group.threads) {
        if (optimisticallyArchivedThreadIdSet.value.has(thread.id)) continue
        map.set(thread.id, thread)
      }
    }
    return map
  })

  const threadTimestampById = computed(() => {
    const map = new Map<string, number>()
    for (const group of input.groups.value) {
      for (const thread of group.threads) {
        map.set(thread.id, new Date(thread.updatedAtIso || thread.createdAtIso).getTime())
      }
    }
    return map
  })

  const unpinnedThreadsByProjectName = computed(() => {
    const map = new Map<string, UiThread[]>()
    for (const group of input.groups.value) {
      const rows = group.threads.filter((thread) =>
        !pinnedThreadIdSet.value.has(thread.id)
        && !optimisticallyArchivedThreadIdSet.value.has(thread.id)
        && threadMatchesStatus(thread),
      )
      map.set(group.projectName, rows)
    }
    return map
  })

  return {
    isStatusFilterActive,
    isSearchActive,
    filteredGroups,
    globalThreads,
    chatThreads,
    pinnedThreadIdSet,
    optimisticallyArchivedThreadIdSet,
    threadById,
    threadTimestampById,
    unpinnedThreadsByProjectName,
    threadMatchesSearch,
    compareSearchRank,
  }
}
