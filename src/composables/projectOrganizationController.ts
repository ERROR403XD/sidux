import {
  buildWorkspaceRootsProjectOrderState,
  collectWorkspaceRootPathsForProjectRemoval,
  collectDuplicateProjectLeafNames,
  filterGroupsByWorkspaceRoots,
  flattenThreads,
  getWorkspaceProjectOrderNames,
  getWorkspaceProjectOrderPaths,
  isVirtualProjectId,
  matchesWorkspaceRootProject,
  mergeProjectOrder,
  mergeIncomingWithLocalInProgressThreads,
  mergeThreadGroups,
  orderGroupsByProjectOrder,
  removeThreadFromGroups,
  reorderProjectNames,
} from '../projectOrganization'
import { computed, ref } from 'vue'
import { getWorkspaceRootsState, removeVirtualProject, setWorkspaceRootsState, type WorkspaceRootsState } from '../api/projectGateway'
import { getPathParent, isProjectlessChatPath, normalizePathForUi, toProjectName } from '../pathUtils.js'
import { areStringArraysEqual } from './threadContextState'
import type { UiProjectGroup, UiThread } from '../types/codex'

const PROJECT_ORDER_STORAGE_KEY = 'codex-web-local.project-order.v1'
const PROJECT_DISPLAY_NAME_STORAGE_KEY = 'codex-web-local.project-display-name.v1'

type ProjectOrganizationControllerOptions = {
  selection: { getThreadId: () => string; setThreadId: (threadId: string) => void }
  titles: { applyCachedToGroups: (groups: UiProjectGroup[]) => UiProjectGroup[] }
  status: {
    isInProgress: (threadId: string) => boolean
    getInProgressMap: () => Record<string, boolean>
    markServerListedThreads: (threadIds: Set<string>) => void
    pruneInProgress: (threadIds: Set<string>) => void
    removeThread: (threadId: string) => void
  }
  getPendingRequestState: (threadId: string) => UiThread['pendingRequestState']
  getUnreadToken: (threadId: string) => string | undefined
  isBackgroundCompleted?: (threadId: string) => boolean
  list: { removeThread: (threadId: string) => void; load: (options: { force: true }) => Promise<void> }
  pruneThreadState: (threads: UiThread[]) => void
}

function loadProjectOrder(): string[] {
  if (typeof window === 'undefined') return []

  try {
    const raw = window.localStorage.getItem(PROJECT_ORDER_STORAGE_KEY)
    if (!raw) return []

    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const order: string[] = []
    for (const item of parsed) {
      if (typeof item !== 'string' || item.length === 0) continue
      const normalizedItem = toProjectName(item)
      if (normalizedItem.length > 0 && !order.includes(normalizedItem)) {
        order.push(normalizedItem)
      }
    }
    return order
  } catch {
    return []
  }
}

function saveProjectOrder(order: string[]): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(PROJECT_ORDER_STORAGE_KEY, JSON.stringify(order))
}

function loadProjectDisplayNames(): Record<string, string> {
  if (typeof window === 'undefined') return {}

  try {
    const raw = window.localStorage.getItem(PROJECT_DISPLAY_NAME_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const displayNames: Record<string, string> = {}
    for (const [projectName, displayName] of Object.entries(parsed as Record<string, unknown>)) {
      const normalizedProjectName = typeof projectName === 'string' ? toProjectName(projectName) : ''
      if (normalizedProjectName.length > 0 && typeof displayName === 'string') {
        displayNames[normalizedProjectName] = displayName
      }
    }
    return displayNames
  } catch {
    return {}
  }
}

function saveProjectDisplayNames(displayNames: Record<string, string>): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(PROJECT_DISPLAY_NAME_STORAGE_KEY, JSON.stringify(displayNames))
}

function omitKeys<TValue>(record: Record<string, TValue>, keys: Set<string>): Record<string, TValue> {
  if (keys.size === 0) return record
  let changed = false
  const next: Record<string, TValue> = {}
  for (const [key, value] of Object.entries(record)) {
    if (keys.has(key)) {
      changed = true
      continue
    }
    next[key] = value
  }
  return changed ? next : record
}

function getRemoteProjectHostLabel(hostId: string): string {
  const normalized = hostId.trim()
  if (!normalized) return ''
  const separatorIndex = normalized.lastIndexOf(':')
  return separatorIndex >= 0 ? normalized.slice(separatorIndex + 1) : normalized
}

function getRemoteProjectDisplayName(remoteProject: NonNullable<WorkspaceRootsState['remoteProjects']>[number]): string {
  const label = remoteProject.label || toProjectName(remoteProject.remotePath) || remoteProject.id
  const hostLabel = getRemoteProjectHostLabel(remoteProject.hostId)
  return hostLabel ? `${label} ${hostLabel}` : label
}

function toProjectNameFromWorkspaceRoot(value: string): string {
  return toProjectName(value)
}

function toOptimisticThreadTitle(message: string): string {
  const firstLine = message
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)

  if (!firstLine) return 'Untitled thread'
  return firstLine.slice(0, 80)
}

export function createProjectOrganizationController({
  selection, titles, status, getPendingRequestState, getUnreadToken, isBackgroundCompleted, list, pruneThreadState,
}: ProjectOrganizationControllerOptions) {
  const projectGroups = ref<UiProjectGroup[]>([])
  const sourceGroups = ref<UiProjectGroup[]>([])
  const projectOrder = ref<string[]>(loadProjectOrder())
  const projectDisplayNameById = ref<Record<string, string>>(loadProjectDisplayNames())
  const pendingListedThreadIds = new Set<string>()
  let hasHydratedWorkspaceRootsState = false
  let renameProjectTimer: ReturnType<typeof setTimeout> | null = null

  function applyThreadFlags(): void {
    const withTitles = titles.applyCachedToGroups(sourceGroups.value)
    const flaggedGroups: UiProjectGroup[] = withTitles.map((group) => ({
      projectName: group.projectName,
      threads: group.threads.map((thread) => {
        const inProgress = status.isInProgress(thread.id)
        const pendingRequestState = getPendingRequestState(thread.id)
        const isSelected = selection.getThreadId() === thread.id
        const unread = !isSelected && !inProgress && Boolean(getUnreadToken(thread.id))

        return {
          ...thread,
          inProgress,
          unread,
          backgroundCompleted: !inProgress && isBackgroundCompleted?.(thread.id) === true,
          pendingRequestState,
        }
      }),
    }))
    projectGroups.value = mergeThreadGroups(projectGroups.value, flaggedGroups)
  }

  function insertOptimisticThread(threadId: string, cwd: string, firstMessageText: string, confirmedProjectId = ''): void {
    pendingListedThreadIds.add(threadId)
    if (pendingListedThreadIds.size > 256) pendingListedThreadIds.delete(pendingListedThreadIds.values().next().value!)
    const nowIso = new Date().toISOString()
    const normalizedCwd = normalizePathForUi(cwd)
    // This association was confirmed by directory creation; it is display-only.
    const projectName = isVirtualProjectId(confirmedProjectId) && isProjectlessChatPath(normalizedCwd)
      ? confirmedProjectId
      : toProjectName(normalizedCwd)
    const nextThread: UiThread = {
      id: threadId,
      title: toOptimisticThreadTitle(firstMessageText),
      projectName,
      cwd: normalizedCwd,
      hasWorktree: normalizedCwd.includes('/.codex/worktrees/') || normalizedCwd.includes('/.git/worktrees/'),
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
      preview: firstMessageText,
      unread: false,
      inProgress: false,
    }

    const existingGroupIndex = sourceGroups.value.findIndex((group) => group.projectName === projectName)
    if (existingGroupIndex >= 0) {
      const existingGroup = sourceGroups.value[existingGroupIndex]
      const remainingThreads = existingGroup.threads.filter((thread) => thread.id !== threadId)
      const nextGroup: UiProjectGroup = {
        projectName,
        threads: [nextThread, ...remainingThreads],
      }
      const nextGroups = [...sourceGroups.value]
      nextGroups.splice(existingGroupIndex, 1, nextGroup)
      sourceGroups.value = nextGroups
    } else {
      sourceGroups.value = [{ projectName, threads: [nextThread] }, ...sourceGroups.value]
    }

    const nextProjectOrder = mergeProjectOrder(projectOrder.value, sourceGroups.value)
    if (!areStringArraysEqual(projectOrder.value, nextProjectOrder)) {
      projectOrder.value = nextProjectOrder
      saveProjectOrder(projectOrder.value)
    }
    applyThreadFlags()
  }

  function currentThreadVersion(threadId: string): string {
    const thread = flattenThreads(sourceGroups.value).find((row) => row.id === threadId)
    return thread?.updatedAtIso ?? ''
  }

  async function hydrateWorkspaceRootsStateIfNeeded(
    groups: UiProjectGroup[],
    rootsState: WorkspaceRootsState | null,
  ): Promise<void> {
    if (hasHydratedWorkspaceRootsState || !rootsState) return
    hasHydratedWorkspaceRootsState = true

    try {
      const hydratedOrder: string[] = []
      for (const rootPath of getWorkspaceProjectOrderPaths(rootsState)) {
        const projectName = toProjectNameFromWorkspaceRoot(rootPath)
        if (hydratedOrder.includes(projectName)) continue
        hydratedOrder.push(projectName)
      }

      if (hydratedOrder.length > 0) {
        const mergedOrder = rootsState.projectOrder.length > 0
          ? mergeProjectOrder(hydratedOrder, groups)
          : mergeProjectOrder(projectOrder.value, groups)
        if (!areStringArraysEqual(projectOrder.value, mergedOrder)) {
          projectOrder.value = mergedOrder
        }
      }

      if (Object.keys(rootsState.labels).length > 0 || (rootsState.remoteProjects ?? []).length > 0) {
        const nextLabels = { ...projectDisplayNameById.value }
        let changed = false
        for (const [rootPath, label] of Object.entries(rootsState.labels)) {
          const normalizedRootPath = normalizePathForUi(rootPath).trim()
          const projectNames = [toProjectNameFromWorkspaceRoot(rootPath)]
          if (normalizedRootPath) projectNames.push(normalizedRootPath)
          for (const projectName of projectNames) {
            if (nextLabels[projectName] === label) continue
            nextLabels[projectName] = label
            changed = true
          }
        }
        for (const rootPath of rootsState.order) {
          const leafName = toProjectNameFromWorkspaceRoot(rootPath)
          const parentLeafName = toProjectName(getPathParent(rootPath))
          if (!parentLeafName.startsWith('.') || parentLeafName === leafName) continue
          const displayName = `${leafName} ${parentLeafName}`
          if (nextLabels[leafName] !== undefined || nextLabels[leafName] === displayName) continue
          nextLabels[leafName] = displayName
          changed = true
        }
        for (const remoteProject of rootsState.remoteProjects ?? []) {
          const label = getRemoteProjectDisplayName(remoteProject)
          if (nextLabels[remoteProject.id] === label) continue
          nextLabels[remoteProject.id] = label
          changed = true
        }
        if (changed) {
          projectDisplayNameById.value = nextLabels
        }
      }
    } catch {
      // Keep local storage fallback when global state is unavailable.
    }
  }

  function applyThreadGroups(groups: UiProjectGroup[], rootsState: WorkspaceRootsState | null): void {
    for (const project of rootsState?.virtualProjects ?? []) {
      projectDisplayNameById.value[project.id] = project.label
    }
    const visibleGroups = filterGroupsByWorkspaceRoots(groups, rootsState)
    const hasWorkspaceRootsState = Boolean(
      rootsState && (rootsState.order.length > 0 || rootsState.projectOrder.length > 0 || (rootsState.remoteProjects ?? []).length > 0),
    )

    const nextProjectOrder = rootsState?.projectOrder.length
      ? mergeProjectOrder(
        getWorkspaceProjectOrderNames(rootsState, collectDuplicateProjectLeafNames(groups, rootsState)),
        visibleGroups,
      )
      : mergeProjectOrder(projectOrder.value, visibleGroups)
    if (!areStringArraysEqual(projectOrder.value, nextProjectOrder)) {
      projectOrder.value = nextProjectOrder
      if (!hasWorkspaceRootsState) {
        saveProjectOrder(projectOrder.value)
      }
    }

    const orderedGroups = orderGroupsByProjectOrder(visibleGroups, projectOrder.value)
    const listedIds = new Set(flattenThreads(orderedGroups).map(thread => thread.id))
    for (const id of listedIds) pendingListedThreadIds.delete(id)
    status.markServerListedThreads(listedIds)
    const mergedWithInProgress = mergeIncomingWithLocalInProgressThreads(
      sourceGroups.value,
      orderedGroups,
      status.getInProgressMap(),
      pendingListedThreadIds,
    )
    sourceGroups.value = mergeThreadGroups(sourceGroups.value, mergedWithInProgress)
    status.pruneInProgress(new Set(flattenThreads(sourceGroups.value).map((thread) => thread.id)))
    applyThreadFlags()
  }

  function removeArchivedThreadFromLoadedLists(threadId: string): void {
    pendingListedThreadIds.delete(threadId)
    list.removeThread(threadId)
    sourceGroups.value = removeThreadFromGroups(sourceGroups.value, threadId)
    status.removeThread(threadId)
    applyThreadFlags()
  }

  async function persistProjectLabelToGlobalState(projectName: string, displayName: string): Promise<void> {
    try {
      const rootsState = await getWorkspaceRootsState()
      const nextLabels = { ...rootsState.labels }
      let changed = false
      for (const rootPath of rootsState.order) {
        if (!matchesWorkspaceRootProject(rootPath, projectName)) continue
        const trimmed = displayName.trim()
        if (trimmed.length === 0) {
          if (nextLabels[rootPath] !== undefined) {
            delete nextLabels[rootPath]
            changed = true
          }
        } else if (nextLabels[rootPath] !== trimmed) {
          nextLabels[rootPath] = trimmed
          changed = true
        }
      }
      if (changed) {
        await setWorkspaceRootsState({
          order: rootsState.order,
          labels: nextLabels,
          active: rootsState.active,
          projectOrder: rootsState.projectOrder,
        })
      }
    } catch {
      // Keep localStorage-only rename when global state is unavailable.
    }
  }

  function renameProject(projectName: string, displayName: string): void {
    if (projectName.length === 0) return

    const currentValue = projectDisplayNameById.value[projectName] ?? ''
    if (currentValue === displayName) return

    projectDisplayNameById.value = {
      ...projectDisplayNameById.value,
      [projectName]: displayName,
    }
    saveProjectDisplayNames(projectDisplayNameById.value)

    if (renameProjectTimer !== null) clearTimeout(renameProjectTimer)
    renameProjectTimer = setTimeout(() => {
      renameProjectTimer = null
      void persistProjectLabelToGlobalState(projectName, displayName)
    }, 500)
  }

  async function removeProject(projectName: string): Promise<void> {
    if (projectName.length === 0) return
    if (isVirtualProjectId(projectName)) {
      await removeVirtualProject(projectName)
      projectOrder.value = projectOrder.value.filter(id => id !== projectName)
      saveProjectOrder(projectOrder.value)
      await list.load({ force: true })
      return
    }

    const nextProjectOrder = projectOrder.value.filter((name) => name !== projectName)
    if (!areStringArraysEqual(projectOrder.value, nextProjectOrder)) {
      projectOrder.value = nextProjectOrder
      saveProjectOrder(projectOrder.value)
    }

    sourceGroups.value = sourceGroups.value.filter((group) => group.projectName !== projectName)

    if (projectDisplayNameById.value[projectName] !== undefined) {
      const nextDisplayNames = { ...projectDisplayNameById.value }
      delete nextDisplayNames[projectName]
      projectDisplayNameById.value = nextDisplayNames
      saveProjectDisplayNames(nextDisplayNames)
    }

    applyThreadFlags()

    const flatThreads = flattenThreads(projectGroups.value)
    pruneThreadState(flatThreads)

    const currentExists = flatThreads.some((thread) => thread.id === selection.getThreadId())
    if (!currentExists) {
      selection.setThreadId(flatThreads[0]?.id ?? '')
    }

    const removedRootPaths = new Set<string>()
    try {
      const rootsState = await getWorkspaceRootsState()
      collectWorkspaceRootPathsForProjectRemoval(rootsState, projectName).forEach((rootPath) => {
        removedRootPaths.add(rootPath)
      })
    } catch {
      // Keep local-only removal when global state is unavailable.
    }

    if (removedRootPaths.size > 0) {
      try {
        const rootsState = await getWorkspaceRootsState()
        const nextOrder = rootsState.order.filter((rootPath) => !removedRootPaths.has(rootPath))
        const nextActive = rootsState.active.filter((rootPath) => !removedRootPaths.has(rootPath))
        const fallbackActive = nextActive.length === 0 && nextOrder.length > 0
          ? [nextOrder[0]]
          : nextActive
        await setWorkspaceRootsState({
          order: nextOrder,
          labels: omitKeys(rootsState.labels, removedRootPaths),
          active: fallbackActive,
          projectOrder: rootsState.projectOrder.filter((item) => item !== projectName && !removedRootPaths.has(item)),
        })
        return
      } catch {
        // Fall back to order-only persistence if direct removal fails.
      }
    }

    await persistProjectOrderToWorkspaceRoots()
  }

  function reorderProject(projectName: string, toIndex: number): void {
    if (projectName.length === 0) return
    if (sourceGroups.value.length === 0) return

    const visibleOrder = sourceGroups.value.map((group) => group.projectName)
    const fromIndex = visibleOrder.indexOf(projectName)
    if (fromIndex === -1) return

    const clampedToIndex = Math.max(0, Math.min(toIndex, visibleOrder.length - 1))
    const reorderedVisibleOrder = reorderProjectNames(visibleOrder, fromIndex, clampedToIndex)
    if (reorderedVisibleOrder === visibleOrder) return

    const normalizedProjectOrder = mergeProjectOrder(reorderedVisibleOrder, sourceGroups.value)
    projectOrder.value = normalizedProjectOrder
    saveProjectOrder(projectOrder.value)

    const orderedGroups = orderGroupsByProjectOrder(sourceGroups.value, projectOrder.value)
    sourceGroups.value = mergeThreadGroups(sourceGroups.value, orderedGroups)
    applyThreadFlags()
    void persistProjectOrderToWorkspaceRoots()
  }

  function pinProjectToTop(projectName: string): void {
    const normalizedName = projectName.trim()
    if (!normalizedName) return
    const nextOrder = [normalizedName, ...projectOrder.value.filter((name) => name !== normalizedName)]
    if (areStringArraysEqual(projectOrder.value, nextOrder)) return
    projectOrder.value = nextOrder
    saveProjectOrder(projectOrder.value)

    const orderedGroups = orderGroupsByProjectOrder(sourceGroups.value, projectOrder.value)
    sourceGroups.value = mergeThreadGroups(sourceGroups.value, orderedGroups)
    applyThreadFlags()
    void persistProjectOrderToWorkspaceRoots()
  }

  async function persistProjectOrderToWorkspaceRoots(): Promise<void> {
    try {
      const rootsState = await getWorkspaceRootsState()
      const nextState = buildWorkspaceRootsProjectOrderState(rootsState, projectOrder.value, sourceGroups.value)

      await setWorkspaceRootsState({
        order: nextState.order,
        labels: rootsState.labels,
        active: nextState.active,
        projectOrder: nextState.projectOrder,
      })
    } catch {
      // Keep local project order when global state persistence is unavailable.
    }
  }

  function stop(): void {
    if (renameProjectTimer !== null) clearTimeout(renameProjectTimer)
    renameProjectTimer = null
  }

  return {
    projectGroups: computed(() => projectGroups.value),
    projectDisplayNameById: computed(() => projectDisplayNameById.value),
    getSourceThreads: () => flattenThreads(sourceGroups.value),
    applyThreadFlags, insertOptimisticThread, currentThreadVersion,
    hydrateWorkspaceRootsStateIfNeeded, applyThreadGroups, removeArchivedThreadFromLoadedLists,
    renameProject, removeProject, reorderProject, pinProjectToTop, stop,
  }
}
