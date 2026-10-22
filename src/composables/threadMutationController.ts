import { computed, ref } from 'vue'
import { archiveThread, forkThread, forkThreadAtTurn, interruptThreadTurn, renameThread, revertThreadFileChanges } from '../api/threadCommandGateway'
import { getThreadDetail, rollbackThread } from '../api/threadReadGateway'
import { findAdjacentThreadId } from '../projectOrganization'
import type { UiMessage, UiThread } from '../types/codex'

export type ThreadMutationControllerOptions = {
  getAccountRevision: () => number
  selection: {
    getThreadId: () => string
    getCwd: () => string
    setThreadId: (threadId: string) => void
  }
  list: {
    getVisibleThreads: () => readonly UiThread[]
    getSourceThreads: () => readonly UiThread[]
    removeArchivedThread: (threadId: string) => void
    load: () => Promise<void>
  }
  history: {
    getMessages: (threadId: string) => readonly UiMessage[]
    markResumed: (threadId: string) => void
    ensureLoaded: (threadId: string, options: { silent: boolean }) => Promise<void>
    load: (threadId: string, options?: { silent: boolean }) => Promise<void>
    invalidateForRollback: (threadId: string) => void
    setMessages: (threadId: string, messages: readonly UiMessage[]) => void
    markDirty: (threadId: string) => void
  }
  status: {
    isInProgress: (threadId: string) => boolean
    isInterruptBlocked: (threadId: string) => boolean
    setInProgress: (threadId: string, inProgress: boolean) => void
  }
  activeTurn: {
    getTurnId: (threadId: string) => string | undefined
    setTurnId: (threadId: string, turnId: string) => void
    clear: (threadId: string) => void
  }
  turnOrder: {
    maxTurnIndex: (threadId: string) => number
    replaceLookup: (threadId: string, lookup: Record<string, number>) => void
  }
  live: {
    setAgentMessages: (threadId: string, messages: readonly UiMessage[]) => void
    clearReasoning: (threadId: string) => void
    clearCommands: (threadId: string) => void
  }
  turns: {
    clearSummary: (threadId: string) => void
    clearActivity: (threadId: string) => void
    clearError: (threadId: string) => void
    setError: (threadId: string, message: string) => void
  }
  synchronization: {
    markThreadsDirty: () => void
    sync: () => Promise<void>
  }
  model: {
    readId: (threadId: string) => string
    setId: (threadId: string, model: string) => void
  }
  titles: {
    set: (threadId: string, title: string) => void
    persist: (threadId: string, title: string) => Promise<void>
  }
  onTitlesChanged: () => void
  markSearchChanged: () => void
  insertOptimisticThread: (threadId: string, cwd: string, title: string) => void
  setPageError: (message: string) => void
}

export function createThreadMutationController({
  getAccountRevision, selection, list, history, status, activeTurn, turnOrder, live, turns, synchronization, model, titles, onTitlesChanged,
  markSearchChanged, insertOptimisticThread, setPageError,
}: ThreadMutationControllerOptions) {
  let threadActionsStopped = false
  let mutationLifecycleRevision = 0
  const isRollingBack = ref(false)
  let rollbackRequest: object | null = null
  const isInterruptingTurn = ref(false)
  let interruptRequest: object | null = null

  function resetInterruptRequest(): void {
    interruptRequest = null
    isInterruptingTurn.value = false
  }

  function resetRollbackRequest(): void {
    rollbackRequest = null
    isRollingBack.value = false
  }

  function toForkedThreadTitle(title: string): string {
    const normalizedTitle = title.trim() || 'Untitled thread'
    return /^fork:\s+/iu.test(normalizedTitle) ? normalizedTitle : `Fork: ${normalizedTitle}`
  }

  function captureThreadActionContext(): () => boolean {
    const identityRevision = getAccountRevision()
    const lifecycleRevision = mutationLifecycleRevision
    return () => !threadActionsStopped && identityRevision === getAccountRevision() && lifecycleRevision === mutationLifecycleRevision
  }

  async function archiveThreadById(threadId: string) {
    const isCurrent = captureThreadActionContext()
    if (!isCurrent()) return
    const wasSelectedThread = selection.getThreadId() === threadId
    const nextSelectedThreadId = wasSelectedThread
      ? findAdjacentThreadId(list.getVisibleThreads(), threadId)
      : ''

    if (wasSelectedThread) {
      selection.setThreadId(nextSelectedThreadId)
      if (nextSelectedThreadId) {
        void history.load(nextSelectedThreadId, { silent: true })
      }
    }

    try {
      await archiveThread(threadId)
      if (!isCurrent()) return
      markSearchChanged()
      list.removeArchivedThread(threadId)
      await list.load()
      if (!isCurrent()) return

      if (wasSelectedThread && nextSelectedThreadId && selection.getThreadId() === nextSelectedThreadId) {
        await history.ensureLoaded(nextSelectedThreadId, { silent: true })
      }
    } catch (unknownError) {
      if (!isCurrent()) return
      setPageError(unknownError instanceof Error ? unknownError.message : 'Unknown application error')
    }
  }

  async function renameThreadById(threadId: string, threadName: string) {
    const isCurrent = captureThreadActionContext()
    if (!isCurrent()) return
    const normalizedName = threadName.trim()
    if (!threadId || !normalizedName) return

    try {
      await renameThread(threadId, normalizedName)
      if (!isCurrent()) return
      titles.set(threadId, normalizedName)
      onTitlesChanged()
      await titles.persist(threadId, normalizedName)
      if (!isCurrent()) return
      markSearchChanged()
    } catch (unknownError) {
      if (!isCurrent()) return
      setPageError(unknownError instanceof Error ? unknownError.message : 'Unknown application error')
    }
  }

  async function forkThreadById(threadId: string): Promise<string> {
    const isContextCurrent = captureThreadActionContext()
    let expectedSelectedThreadId = selection.getThreadId()
    const isCurrent = () => isContextCurrent() && selection.getThreadId() === expectedSelectedThreadId
    if (!isCurrent()) return ''
    const sourceThreadId = threadId.trim()
    if (!sourceThreadId) return ''

    const sourceThread = list.getSourceThreads().find((row) => row.id === sourceThreadId)
    const sourceCwd = sourceThread?.cwd?.trim() ?? ''
    const sourceTitle = sourceThread?.title?.trim() ?? 'Forked chat'
    const selectedModel = model.readId(sourceThreadId)
    setPageError('')

    try {
      const forkedThread = await forkThread(sourceThreadId, sourceCwd || undefined, selectedModel || undefined)
      if (!isCurrent()) return ''
      const nextThreadId = forkedThread.threadId.trim()
      if (!nextThreadId) return ''

      insertOptimisticThread(nextThreadId, sourceCwd, sourceTitle)
      model.setId(nextThreadId, forkedThread.model)
      history.markResumed(nextThreadId)
      expectedSelectedThreadId = nextThreadId
      selection.setThreadId(nextThreadId)
      await list.load()
      if (!isCurrent()) return ''
      await history.load(nextThreadId)
      if (!isCurrent()) return ''
      return nextThreadId
    } catch (unknownError) {
      if (!isCurrent()) return ''
      setPageError(unknownError instanceof Error ? unknownError.message : 'Unknown application error')
      return ''
    }
  }

  async function forkThreadFromTurn(threadId: string, turnId: string): Promise<string> {
    const isContextCurrent = captureThreadActionContext()
    let expectedSelectedThreadId = selection.getThreadId()
    const isCurrent = () => isContextCurrent() && selection.getThreadId() === expectedSelectedThreadId
    if (!isCurrent()) return ''
    if (!threadId.trim() || !turnId.trim()) return ''
    const sourceMessages = history.getMessages(threadId)
    if (!sourceMessages.some(message => message.turnId === turnId)) return ''
    const sourceThread = list.getSourceThreads().find(row => row.id === threadId)
    try {
      setPageError('')
      const forked = await forkThreadAtTurn(threadId, turnId)
      if (!isCurrent()) return ''
      const nextId = forked.threadId.trim()
      if (!nextId) return ''
      const title = toForkedThreadTitle(sourceThread?.title || sourceThread?.preview || 'Untitled thread')
      insertOptimisticThread(nextId, sourceThread?.cwd ?? '', title)
      model.setId(nextId, forked.model)
      await renameThreadById(nextId, title)
      if (!isCurrent()) return ''
      expectedSelectedThreadId = nextId
      selection.setThreadId(nextId)
      await history.load(nextId)
      if (!isCurrent()) return ''
      void list.load().catch(() => {})
      return nextId
    } catch (unknownError) {
      if (!isCurrent()) return ''
      setPageError(unknownError instanceof Error ? unknownError.message : '无法创建历史分支。')
      return ''
    }
  }

  async function rollbackSelectedThread(turnId: string): Promise<boolean> {
    const isContextCurrent = captureThreadActionContext()
    if (!isContextCurrent()) return false
    const threadId = selection.getThreadId()
    if (!threadId) return false
    if (isRollingBack.value) return false
    if (!turnId.trim()) return false

    const persisted = history.getMessages(threadId)
    const matchedMessage = persisted.find((message) => message.turnId === turnId)
    const turnIndex = typeof matchedMessage?.turnIndex === 'number' ? matchedMessage.turnIndex : -1
    if (turnIndex < 0) return false
    const maxTurnIndex = turnOrder.maxTurnIndex(threadId)
    if (maxTurnIndex < 0 || turnIndex > maxTurnIndex) return false
    const numTurns = maxTurnIndex - turnIndex + 1
    if (numTurns < 1) return false

    const request = {}
    rollbackRequest = request
    const isCurrent = () => isContextCurrent() && rollbackRequest === request
    isRollingBack.value = true
    setPageError('')
    try {
      const threadCwd = selection.getCwd().trim()
      if (threadCwd) {
        const files = await revertThreadFileChanges(threadId, turnId, threadCwd)
        if (!isCurrent()) return false
        if (files.errors.length) throw new Error(files.errors.join('\n'))
      }
      const nextMessages = await rollbackThread(threadId, numTurns)
      if (!isCurrent()) return false
      turnOrder.replaceLookup(threadId, {})
      history.invalidateForRollback(threadId)
      history.setMessages(threadId, nextMessages)
      live.setAgentMessages(threadId, [])
      live.clearReasoning(threadId)
      live.clearCommands(threadId)
      turns.clearSummary(threadId)
      turns.clearActivity(threadId)
      turns.clearError(threadId)
      synchronization.markThreadsDirty()
      await synchronization.sync()
      if (!isCurrent()) return false
      return true
    } catch (unknownError) {
      if (!isCurrent()) return false
      setPageError(unknownError instanceof Error ? unknownError.message : 'Failed to rollback thread')
      return false
    } finally {
      if (rollbackRequest === request) resetRollbackRequest()
    }
  }

  async function interruptSelectedThreadTurn(): Promise<void> {
    const isContextCurrent = captureThreadActionContext()
    if (!isContextCurrent()) return
    const threadId = selection.getThreadId()
    if (!threadId) return
    if (isInterruptingTurn.value) return
    if (status.isInProgress(threadId) !== true) return
    if (status.isInterruptBlocked(threadId) === true) return
    const request = {}
    interruptRequest = request
    isInterruptingTurn.value = true
    setPageError('')
    const identityRevision = getAccountRevision()
    try {
      let turnId = activeTurn.getTurnId(threadId)
      if (!turnId) {
        const { activeTurnId } = await getThreadDetail(threadId)
        if (interruptRequest !== request || identityRevision !== getAccountRevision()) return
        turnId = activeTurnId
        if (turnId) activeTurn.setTurnId(threadId, turnId)
      }
      if (!turnId) throw new Error('Could not determine active turn id for interrupt')
      await interruptThreadTurn(threadId, turnId)
      if (interruptRequest !== request || selection.getThreadId() !== threadId || identityRevision !== getAccountRevision()) return
      status.setInProgress(threadId, false)
      turns.clearActivity(threadId)
      turns.clearError(threadId)
      activeTurn.clear(threadId)
      history.markDirty(threadId)
      synchronization.markThreadsDirty()
      await synchronization.sync()
    } catch (unknownError) {
      if (interruptRequest !== request || selection.getThreadId() !== threadId || identityRevision !== getAccountRevision()) return
      const errorMessage = unknownError instanceof Error ? unknownError.message : 'Failed to interrupt active turn'
      turns.setError(threadId, errorMessage)
      setPageError(errorMessage)
    } finally {
      if (interruptRequest === request) resetInterruptRequest()
    }
  }

  function invalidateForAccountChange(): void {
    resetInterruptRequest()
    resetRollbackRequest()
  }

  return {
    archiveThreadById,
    renameThreadById,
    forkThreadById,
    forkThreadFromTurn,
    rollbackSelectedThread,
    isRollingBack: computed(() => isRollingBack.value),
    interruptSelectedThreadTurn,
    isInterruptingTurn: computed(() => isInterruptingTurn.value),
    captureThreadActionContext,
    invalidateForAccountChange,
    start: () => { threadActionsStopped = false },
    stop: () => {
      mutationLifecycleRevision++
      threadActionsStopped = true
      resetInterruptRequest()
      resetRollbackRequest()
    },
  }
}
