import { mergeThreadGroupPages, removeThreadFromGroups } from '../projectOrganization'
import type { UiProjectGroup } from '../types/codex'
import type { WorkspaceRootsState } from '../api/projectGateway'

type ThreadListSnapshotStateOptions = {
  commit: (groups: UiProjectGroup[], rootsState: WorkspaceRootsState | null) => void
}

export function createThreadListSnapshotState({ commit }: ThreadListSnapshotStateOptions) {
  let groups: UiProjectGroup[] = []
  let rootsState: WorkspaceRootsState | null = null
  let hasLoaded = false

  function setGroups(nextGroups: UiProjectGroup[], nextRootsState: WorkspaceRootsState | null): void {
    groups = nextGroups
    rootsState = nextRootsState
    hasLoaded = true
    commit(groups, rootsState)
  }

  return {
    commitFirstPage: (pageGroups: UiProjectGroup[], nextRootsState: WorkspaceRootsState | null) => {
      setGroups(
        hasLoaded ? mergeThreadGroupPages(groups, pageGroups) : pageGroups,
        nextRootsState,
      )
    },
    commitRemainingPage: (pageGroups: UiProjectGroup[], nextRootsState: WorkspaceRootsState | null) => {
      setGroups(mergeThreadGroupPages(groups, pageGroups), nextRootsState)
    },
    removeThread: (threadId: string) => {
      setGroups(removeThreadFromGroups(groups, threadId), rootsState)
    },
    reset: () => {
      groups = []
      rootsState = null
      hasLoaded = false
      commit(groups, rootsState)
    },
    get groups() {
      return groups
    },
    get rootsState() {
      return rootsState
    },
  }
}
