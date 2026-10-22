import { ref, watch } from 'vue'
import { updateThreadFileChanges } from '../api/threadCommandGateway'

type FileChangeActionTarget = { turnId: string }

type ConversationFileActionsOptions = {
  getThreadId: () => string
  getCwd: () => string
  getAccountRevision: () => number
}

export function createConversationFileActionsController(options: ConversationFileActionsOptions) {
  const fileChangeActionState = ref<Record<string, 'idle' | 'undoing' | 'redoing' | 'undone' | 'redone'>>({})
  const fileChangeActionError = ref<Record<string, string>>({})
  const fileChangeRedoPatchIds = ref<Record<string, string[]>>({})
  const fileChangePendingRedoPatchIds = ref<Record<string, string[]>>({})
  const fileChangeActionPending = ref(false)
  let fileChangeActionGeneration = 0
  let fileChangeActionStopped = false

  function resetFileChangeActions(): void {
    fileChangeActionGeneration += 1
    fileChangeActionState.value = {}
    fileChangeActionError.value = {}
    fileChangeRedoPatchIds.value = {}
    fileChangePendingRedoPatchIds.value = {}
  }

  const stopIdentityWatch = watch(
    [() => options.getThreadId(), () => options.getCwd(), () => options.getAccountRevision()],
    resetFileChangeActions,
    { flush: 'sync' },
  )

  function fileChangeActionKey(summary: FileChangeActionTarget | null): string {
    return summary?.turnId && options.getThreadId() ? `thread:${options.getThreadId()}:turn:${summary.turnId}` : ''
  }

  function isFileChangeActionable(summary: FileChangeActionTarget | null): boolean {
    return !fileChangeActionStopped && !!options.getCwd() && fileChangeActionKey(summary).length > 0
  }

  function isFileChangeActionPending(): boolean {
    return fileChangeActionPending.value
  }

  function fileChangeActionStatus(summary: FileChangeActionTarget | null): 'idle' | 'undoing' | 'redoing' | 'undone' | 'redone' {
    const key = fileChangeActionKey(summary)
    return key ? fileChangeActionState.value[key] ?? 'idle' : 'idle'
  }

  function fileChangeActionErrorText(summary: FileChangeActionTarget | null): string {
    const key = fileChangeActionKey(summary)
    return key ? fileChangeActionError.value[key] ?? '' : ''
  }

  function fileChangeNextAction(summary: FileChangeActionTarget | null): 'undo' | 'redo' {
    const status = fileChangeActionStatus(summary)
    return status === 'undone' || status === 'redoing' ? 'redo' : 'undo'
  }

  function fileChangeActionLabel(summary: FileChangeActionTarget | null): string {
    const status = fileChangeActionStatus(summary)
    if (status === 'undoing') return 'Undoing'
    if (status === 'redoing') return 'Redoing'
    return fileChangeNextAction(summary) === 'redo' ? 'Redo' : 'Undo'
  }

  async function runFileChangeAction(summary: FileChangeActionTarget | null, action: 'undo' | 'redo'): Promise<void> {
    const key = fileChangeActionKey(summary)
    if (!summary || !isFileChangeActionable(summary) || fileChangeActionPending.value || action !== fileChangeNextAction(summary)) return
    const threadId = options.getThreadId()
    const cwd = options.getCwd()
    const generation = fileChangeActionGeneration
    const previousState = fileChangeActionStatus(summary)
    const patchIds = action === 'redo' ? fileChangePendingRedoPatchIds.value[key] : fileChangeRedoPatchIds.value[key]
    const pendingState = action === 'undo' ? 'undoing' : 'redoing'
    fileChangeActionPending.value = true
    fileChangeActionState.value = { ...fileChangeActionState.value, [key]: pendingState }
    fileChangeActionError.value = { ...fileChangeActionError.value, [key]: '' }

    let result: Awaited<ReturnType<typeof updateThreadFileChanges>>
    try {
      result = await updateThreadFileChanges(
        threadId,
        summary.turnId,
        cwd,
        action,
        patchIds,
        'single_turn',
      )
    } catch (error) {
      if (fileChangeActionStopped || generation !== fileChangeActionGeneration) return
      fileChangeActionState.value = { ...fileChangeActionState.value, [key]: previousState }
      fileChangeActionError.value = {
        ...fileChangeActionError.value,
        [key]: error instanceof Error ? error.message : 'Failed to update file changes.',
      }
      return
    } finally {
      // A view change cannot cancel filesystem work already accepted by the server.
      if (!fileChangeActionStopped) fileChangeActionPending.value = false
    }

    if (fileChangeActionStopped || generation !== fileChangeActionGeneration) return
    if (result.errors.length > 0) {
      fileChangeActionError.value = { ...fileChangeActionError.value, [key]: result.errors.join('; ') }
    }
    if (result.changed === 0) {
      fileChangeActionState.value = { ...fileChangeActionState.value, [key]: previousState }
      if (result.errors.length === 0 && result.message) {
        fileChangeActionError.value = { ...fileChangeActionError.value, [key]: result.message }
      }
      return
    }

    if (action === 'undo') {
      const reverted = result.revertedPatchIds ?? []
      fileChangeRedoPatchIds.value = { ...fileChangeRedoPatchIds.value, [key]: reverted }
      fileChangePendingRedoPatchIds.value = { ...fileChangePendingRedoPatchIds.value, [key]: reverted }
      fileChangeActionState.value = { ...fileChangeActionState.value, [key]: 'undone' }
    } else {
      // Keep the full undo scope separate from the subset still awaiting redo.
      const applied = new Set(result.appliedPatchIds ?? [])
      const remaining = (patchIds ?? []).filter(id => !applied.has(id))
      fileChangePendingRedoPatchIds.value = { ...fileChangePendingRedoPatchIds.value, [key]: remaining }
      fileChangeActionState.value = { ...fileChangeActionState.value, [key]: remaining.length > 0 ? 'undone' : 'redone' }
    }
  }

  function stop(): void {
    if (fileChangeActionStopped) return
    fileChangeActionStopped = true
    fileChangeActionGeneration += 1
    stopIdentityWatch()
  }

  return {
    isFileChangeActionable,
    isFileChangeActionPending,
    fileChangeActionStatus,
    fileChangeActionErrorText,
    fileChangeNextAction,
    fileChangeActionLabel,
    runFileChangeAction,
    stop,
  }
}
