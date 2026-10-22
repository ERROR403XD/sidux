import { computed, ref } from 'vue'
import { CodexApiError } from '../api/codexErrors'
import type { CollaborationModeKind, UiThread } from '../types/codex'
import { cloneStringKeyedRecord, createStringKeyedRecord, isNewThreadContextId, omitStringKeyedRecordKey, pruneThreadContextStateMap, toThreadContextId } from './threadContextState'

const SELECTED_THREAD_STORAGE_KEY = 'codex-web-local.selected-thread-id.v1'
const COLLABORATION_MODE_STORAGE_KEY = 'codex-web-local.collaboration-mode-by-context.v1'
const LEGACY_COLLABORATION_MODE_STORAGE_KEY = 'codex-web-local.collaboration-mode.v1'

export type SelectThreadResult = 'ok' | 'not-found' | 'error'

type ThreadSelectionControllerOptions = {
  getAccountRevision: () => number
  getListedThreads: () => readonly UiThread[]
  getSnapshot: (threadId: string) => UiThread | undefined
  getVirtualProjects: () => readonly { id: string; cwds: readonly string[] }[] | undefined
  history: { load: (threadId: string, options: { retry: true }) => Promise<unknown> }
  model: {
    projectSelectedThread: (threadId: string) => void
    refreshModelPreferences: (options: { includeProviderModels: true }) => Promise<void>
  }
  metadata: { getTitle: (threadId: string) => string; refreshSkills: () => Promise<void> }
  errors: {
    setPage: (message: string) => void
    setTurn: (threadId: string, message: string, options: { transient: true }) => void
  }
  resetReasoningItem: () => void
  onChanged: () => void
}

function isThreadNotFoundError(error: unknown): boolean {
  if (error instanceof CodexApiError && error.status === 404) return true
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /\b404\b|thread.*not found|conversation.*not found|no such thread|no rollout found for thread id/i.test(message)
}

function normalizeCollaborationMode(value: unknown): CollaborationModeKind {
  return value === 'plan' ? 'plan' : 'default'
}

function loadSelectedCollaborationModeMap(): Record<string, CollaborationModeKind> {
  if (typeof window === 'undefined') return createStringKeyedRecord<CollaborationModeKind>()

  try {
    const raw = window.localStorage.getItem(COLLABORATION_MODE_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return createStringKeyedRecord<CollaborationModeKind>()
      }

      const next = createStringKeyedRecord<CollaborationModeKind>()
      for (const [contextId, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof contextId !== 'string' || contextId.length === 0) continue
        const normalizedMode = normalizeCollaborationMode(value)
        if (normalizedMode === 'plan') {
          next[contextId] = normalizedMode
        }
      }
      return next
    }
  } catch {
    // Fall back to the legacy global preference below.
  }

  return createStringKeyedRecord<CollaborationModeKind>()
}

function readSelectedCollaborationMode(
  state: Record<string, CollaborationModeKind>,
  threadId: string,
): CollaborationModeKind {
  const contextId = toThreadContextId(threadId)
  return normalizeCollaborationMode(state[contextId])
}

function writeSelectedCollaborationModeForContext(
  state: Record<string, CollaborationModeKind>,
  threadId: string,
  mode: CollaborationModeKind,
): Record<string, CollaborationModeKind> {
  const contextId = toThreadContextId(threadId)
  if (isNewThreadContextId(contextId)) {
    return omitStringKeyedRecordKey(state, contextId)
  }
  if (mode === 'plan') {
    const next = cloneStringKeyedRecord(state)
    next[contextId] = 'plan'
    return next
  }
  return omitStringKeyedRecordKey(state, contextId)
}

function saveSelectedCollaborationModeMap(state: Record<string, CollaborationModeKind>): void {
  if (typeof window === 'undefined') return
  try {
    if (Object.keys(state).length === 0) {
      window.localStorage.removeItem(COLLABORATION_MODE_STORAGE_KEY)
    } else {
      window.localStorage.setItem(COLLABORATION_MODE_STORAGE_KEY, JSON.stringify(state))
    }
    window.localStorage.removeItem(LEGACY_COLLABORATION_MODE_STORAGE_KEY)
  } catch {
    // Keep in-memory mode selection working even if localStorage writes fail.
  }
}

function loadSelectedThreadId(): string {
  if (typeof window === 'undefined') return ''
  const raw = window.localStorage.getItem(SELECTED_THREAD_STORAGE_KEY)
  return raw ?? ''
}

function saveSelectedThreadId(threadId: string): void {
  if (typeof window === 'undefined') return
  if (!threadId) {
    window.localStorage.removeItem(SELECTED_THREAD_STORAGE_KEY)
    return
  }
  window.localStorage.setItem(SELECTED_THREAD_STORAGE_KEY, threadId)
}

export function createThreadSelectionController(options: ThreadSelectionControllerOptions) {
  const {
    getAccountRevision, getListedThreads, getSnapshot, getVirtualProjects,
    history, model, metadata, errors, resetReasoningItem, onChanged,
  } = options
  const selectedThreadId = ref(loadSelectedThreadId())
  const selectedCollaborationModeByContext = ref<Record<string, CollaborationModeKind>>(
    loadSelectedCollaborationModeMap(),
  )
  const selectedCollaborationMode = ref<CollaborationModeKind>(
    readSelectedCollaborationMode(selectedCollaborationModeByContext.value, selectedThreadId.value),
  )
  let threadSelectionRevision = 0
  let threadSelectionStopped = false
  const allThreads = computed(() => getListedThreads())
  const selectedThread = computed(() => {
    const threadId = selectedThreadId.value
    const listed = allThreads.value.find(thread => thread.id === threadId)
    const snapshot = getSnapshot(threadId)
    const thread = listed ?? snapshot
    if (!thread) return null
    const organization = getVirtualProjects()?.find(project => project.cwds.includes(thread.cwd))
    return { ...thread, projectName: organization?.id ?? thread.projectName, title: metadata.getTitle(threadId) || thread.title, task: snapshot?.task ?? thread.task }
  })
  let selectionLifecycleRevision = 0

  function setSelectedThreadId(nextThreadId: string, options: { persist?: boolean } = {}): void {
    if (selectedThreadId.value === nextThreadId) return
    threadSelectionRevision++
    selectedThreadId.value = nextThreadId
    if (options.persist !== false) {
      saveSelectedThreadId(nextThreadId)
    }
    model.projectSelectedThread(nextThreadId)
    selectedCollaborationMode.value = readSelectedCollaborationMode(
      selectedCollaborationModeByContext.value,
      nextThreadId,
    )
    resetReasoningItem()
    onChanged()
  }

  function setSelectedCollaborationMode(mode: CollaborationModeKind): void {
    const nextMode: CollaborationModeKind = mode === 'plan' ? 'plan' : 'default'
    const contextId = toThreadContextId(selectedThreadId.value)
    const currentMode = readSelectedCollaborationMode(selectedCollaborationModeByContext.value, selectedThreadId.value)
    if (currentMode === nextMode && selectedCollaborationMode.value === nextMode) return
    selectedCollaborationMode.value = nextMode
    selectedCollaborationModeByContext.value = writeSelectedCollaborationModeForContext(
      selectedCollaborationModeByContext.value,
      contextId,
      nextMode,
    )
    saveSelectedCollaborationModeMap(selectedCollaborationModeByContext.value)
  }

  function setSelectedCollaborationModeForThread(threadId: string, mode: CollaborationModeKind): void {
    const nextMode = mode === 'plan' ? 'plan' : 'default'
    selectedCollaborationModeByContext.value = writeSelectedCollaborationModeForContext(
      selectedCollaborationModeByContext.value,
      threadId,
      nextMode,
    )
    if (threadId.trim() === selectedThreadId.value) {
      selectedCollaborationMode.value = nextMode
    }
    saveSelectedCollaborationModeMap(selectedCollaborationModeByContext.value)
  }

  async function selectThread(threadId: string): Promise<SelectThreadResult> {
    if (threadSelectionStopped) return 'error'
    setSelectedThreadId(threadId)
    const identityRevision = getAccountRevision()
    const lifecycleRevision = selectionLifecycleRevision
    const selectionRevision = ++threadSelectionRevision
    const isCurrent = () => !threadSelectionStopped
      && identityRevision === getAccountRevision()
      && lifecycleRevision === selectionLifecycleRevision
      && selectionRevision === threadSelectionRevision
      && selectedThreadId.value === threadId

    try {
      await history.load(threadId, { retry: true })
      if (!isCurrent()) return 'error'
      await model.refreshModelPreferences({ includeProviderModels: true })
      if (!isCurrent()) return 'error'
      void metadata.refreshSkills()
      return 'ok'
    } catch (unknownError) {
      if (!isCurrent()) return 'error'
      const message = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      errors.setPage(message)
      const result = isThreadNotFoundError(unknownError) ? 'not-found' : 'error'
      if (threadId.trim()) {
        errors.setTurn(threadId, message, { transient: true })
      }
      return result
    }
  }

  function primeSelectedThread(threadId: string, options: { persist?: boolean } = {}): void {
    setSelectedThreadId(threadId, options)
  }

  function pruneCollaborationPreferences(activeThreadIds: Set<string>): void {
    const nextSelectedCollaborationModeMap = pruneThreadContextStateMap(
      selectedCollaborationModeByContext.value,
      activeThreadIds,
    )
    if (nextSelectedCollaborationModeMap !== selectedCollaborationModeByContext.value) {
      selectedCollaborationModeByContext.value = nextSelectedCollaborationModeMap
      selectedCollaborationMode.value = readSelectedCollaborationMode(
        nextSelectedCollaborationModeMap,
        selectedThreadId.value,
      )
      saveSelectedCollaborationModeMap(nextSelectedCollaborationModeMap)
    }
  }

  function stop(): void {
    threadSelectionStopped = true
    threadSelectionRevision++
    selectionLifecycleRevision++
  }

  return {
    selectedThreadId: computed(() => selectedThreadId.value),
    selectedThread,
    selectedCollaborationMode: computed(() => selectedCollaborationMode.value),
    setSelectedThreadId, primeSelectedThread, selectThread,
    setSelectedCollaborationMode, setSelectedCollaborationModeForThread, pruneCollaborationPreferences,
    start: () => { threadSelectionStopped = false },
    stop,
  }
}
