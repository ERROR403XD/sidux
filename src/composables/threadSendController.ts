import { computed, ref } from 'vue'
import { startThread, startThreadTurn, type FileAttachmentParam } from '../api/threadCommandGateway'
import { getThreadDetail, getThreadTurnMessages, resumeThread } from '../api/threadReadGateway'
import { createDeliveryId } from '../delivery'
import { effectiveConversationChoice, type ConversationChoice } from '../webConversationPreferences'
import { isOptimisticUserMessage, mergeMessages } from '../messageIdentity'
import { buildQuestionReply, questionRefKey, readQuestionReply, type AsyncQuestionReply } from '../userQuestions'
import { resolveUserMessageOrdinal, type ConversationDelivery } from '../conversationDelivery'
import type { CollaborationModeKind, ReasoningEffort, SpeedMode, UiMessage } from '../types/codex'
import type { ModelCapability } from '../modelCapabilities'
import type { TurnSummaryState } from '../turnSummary'
import type { TurnActivityState } from './threadRealtimeController'
import type { createThreadQueueController } from './threadQueueController'
import type { useConversationDeliveries } from './useConversationDeliveries'

type FileAttachment = FileAttachmentParam
type ThreadQueue = ReturnType<typeof createThreadQueueController>
type SendDeliveries = Pick<ReturnType<typeof useConversationDeliveries>, 'begin' | 'patch' | 'replaceId' | 'refresh' | 'observe'>
export type ThreadSendControllerOptions = {
  getAccountRevision: () => number
  isModelSettingsUpdating: () => boolean
  newThreadModelContext: string
  modelFallbackId: string
  selection: {
    getThreadId: () => string
    getCollaborationMode: () => CollaborationModeKind
    getReasoningEffort: () => ReasoningEffort | ''
    getSpeedMode: () => SpeedMode
    setThreadId: (threadId: string) => void
    setModelProjection: (model: string) => void
    setCollaborationMode: (threadId: string, mode: CollaborationModeKind) => void
  }
  model: {
    readId: (threadId: string) => string
    readProviderId: (threadId: string) => string
    getActiveProviderId: () => string
    getSettings: (model: string, hasImages: boolean) => { model: string; effort: ReasoningEffort | ''; serviceTier: string | null }
    setId: (threadId: string, model: string) => void
    setProviderId: (threadId: string, provider: string) => void
    resolveForProvider: (threadId: string, model: string, provider: string) => string
    getCatalog: () => readonly ModelCapability[]
    setCatalog: (models: ModelCapability[]) => void
    ensureAvailableIds: (model: string) => void
  }
  preferences: {
    getNewThreadChoice: () => ConversationChoice | undefined
    register: (threadId: string, choice: ConversationChoice) => void
    saveModelSettings: (patch: Partial<{ effort: string; tier: string }>) => void
  }
  history: {
    getMessages: (threadId: string) => readonly UiMessage[]
    getLiveMessages: (threadId: string) => readonly UiMessage[]
    setMessages: (threadId: string, messages: readonly UiMessage[]) => void
    isResumed: (threadId: string) => boolean
    markResumed: (threadId: string) => void
    markDirty: (threadId: string) => void
  }
  turn: {
    isInProgress: (threadId: string) => boolean
    setInProgress: (threadId: string, inProgress: boolean) => void
    getActiveId: (threadId: string) => string | undefined
    setActiveId: (threadId: string, turnId: string) => void
    setSummary: (threadId: string, summary: TurnSummaryState | null) => void
    setActivity: (threadId: string, activity: TurnActivityState | null) => void
    setError: (threadId: string, error: string | null) => void
    blockInterrupt: (threadId: string) => void
    unblockInterrupt: (threadId: string, turnId: string) => void
  }
  queue: Pick<ThreadQueue, 'getMessages'> & { commit: ThreadQueue['commitQueueOperation']; refresh: ThreadQueue['refreshQueueState'] }
  conversationDeliveries: SendDeliveries
  getDeliveryRows: () => readonly Readonly<ConversationDelivery>[]
  readNextUserMessageOrdinal: (threadId: string, sourceTurnId?: string) => number
  appendOptimisticUserMessage: (threadId: string, text: string, imageUrls: string[], skills: Array<{ name: string; path: string }>, fileAttachments: FileAttachment[], delivery?: { id: string; turnId: string; userMessageOrdinal?: number }) => void
  insertOptimisticThread: (threadId: string, cwd: string, text: string, confirmedProjectId: string) => void
  requestThreadTitleGeneration: (threadId: string, text: string, cwd: string | null, fallbackTitle: string) => Promise<void>
  setPageError: (message: string) => void
  syncFromNotifications: () => Promise<void>
  scheduleDelayedTurnSync: (threadId: string) => void
}

export function createThreadSendController({
  getAccountRevision, isModelSettingsUpdating, newThreadModelContext, modelFallbackId,
  selection, model, preferences, history, turn, queue: sendQueue, conversationDeliveries, getDeliveryRows,
  readNextUserMessageOrdinal, appendOptimisticUserMessage, insertOptimisticThread,
  requestThreadTitleGeneration, setPageError, syncFromNotifications, scheduleDelayedTurnSync,
}: ThreadSendControllerOptions) {
  const isSendingMessage = ref(false)
  let newThreadSendRequest: object | null = null
  let threadSendStopped = false
  let sendLifecycleRevision = 0
  function isUnsupportedChatGptModelError(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    const message = error.message.toLowerCase()
    return (
      message.includes('not supported when using codex with a chatgpt account') ||
      message.includes('model is not supported') ||
      message.includes('requires a newer version of codex')
    )
  }

  function attachmentOnlyTitle(imageUrls: string[], fileAttachments: Array<{ label: string; path: string }>): string {
    const hasImages = imageUrls.length > 0
    const firstFile = fileAttachments.map(file => file.label.trim()).find(label => label.length > 0) ?? ''
    if (hasImages && firstFile) return `[Image] ${firstFile}`
    if (hasImages) return '[Image]'
    return firstFile
  }

  function extractLocalImagePathFromUrl(value: string): string {
    try {
      const parsed = new URL(value, 'http://localhost')
      if (parsed.pathname !== '/codex-local-image') return ''
      return parsed.searchParams.get('path')?.trim() ?? ''
    } catch {
      return ''
    }
  }

  function shouldReuseAttachedImageFromPrompt(promptText: string): boolean {
    const normalized = promptText.trim().toLowerCase()
    if (!normalized) return false
    return /\b(attached image|attached screenshot|save the attached|copy (the )?screenshot|save screenshot)\b/i.test(normalized)
  }

  function findLatestUserLocalImageUrl(threadId: string): string {
    const persisted = history.getMessages(threadId)
    for (let index = persisted.length - 1; index >= 0; index -= 1) {
      const message = persisted[index]
      if (message.role !== 'user' || !Array.isArray(message.images) || message.images.length === 0) continue
      for (let imageIndex = message.images.length - 1; imageIndex >= 0; imageIndex -= 1) {
        const imageUrl = message.images[imageIndex]?.trim() ?? ''
        if (!imageUrl) continue
        if (extractLocalImagePathFromUrl(imageUrl)) return imageUrl
      }
    }
    return ''
  }

  function buildPendingTurnDetails(
    modelId: string,
    effort: ReasoningEffort | '',
    collaborationMode: CollaborationModeKind = selection.getCollaborationMode(),
  ): string[] {
    const modelLabel = modelId.trim() || 'default'
    const effortLabel = effort || 'default'
    const modeLabel = collaborationMode === 'plan' ? 'Plan' : 'Default'
    const speedLabel = selection.getSpeedMode() || 'Standard'
    return [`Mode: ${modeLabel}`, `Model: ${modelLabel}`, `Thinking: ${effortLabel}`, `Speed: ${speedLabel}`]
  }

  function captureThreadSendContext(): () => boolean {
    const identityRevision = getAccountRevision()
    const lifecycleRevision = sendLifecycleRevision
    return () => !threadSendStopped && identityRevision === getAccountRevision() && lifecycleRevision === sendLifecycleRevision
  }

  function resetThreadSendRequest(): void {
    newThreadSendRequest = null
    isSendingMessage.value = false
  }

  async function answerAsyncQuestions(reply: AsyncQuestionReply): Promise<void> {
    const isCurrent = captureThreadSendContext()
    if (!isCurrent()) return
    const known = [
      ...(history.getMessages(reply.threadId)),
      ...history.getLiveMessages(reply.threadId),
    ].find(message => message.id === reply.itemId && message.turnId === reply.turnId && message.questions?.length)
    if (!known) throw new Error('找不到对应问题，请刷新会话后重试。')
    // While a turn is running the CLI may reconstruct item-N IDs, then publish
    // the original call ID on completion. Resolve an ordinal in the native turn
    // once on explicit submission; never infer an answer from ordinary text.
    try {
      const detail = await getThreadDetail(reply.threadId)
      if (!isCurrent()) return
      const turnMessages = detail.messages.some(message => message.turnId === reply.turnId && message.questions?.length)
        ? detail.messages.filter(message => message.turnId === reply.turnId)
        : await getThreadTurnMessages(reply.threadId, reply.turnId)
      if (!isCurrent()) return
      const candidates = turnMessages.filter(message => message.questions?.length)
      const question = candidates.find(message => reply.questionOrdinal !== undefined
        ? message.questionOrdinal === reply.questionOrdinal
        : message.id === reply.itemId)
        ?? (candidates.filter(message => JSON.stringify(message.questions) === JSON.stringify(known.questions)).length === 1
          ? candidates.find(message => JSON.stringify(message.questions) === JSON.stringify(known.questions))
          : undefined)
      if (!question) throw new Error('问题状态已变化，请刷新会话后重试。')
      const key = questionRefKey({ itemId: question.id, turnId: reply.turnId, questionOrdinal: question.questionOrdinal })
      if ([...(history.getMessages(reply.threadId)), ...detail.messages, ...turnMessages].some(message => message.questionReply && questionRefKey(message.questionReply) === key)) return
      history.setMessages(reply.threadId, mergeMessages(history.getMessages(reply.threadId), detail.messages, { preserveMissing: true }))
      await startTurnForThread(reply.threadId, buildQuestionReply(question, reply.answers), [], [], [], undefined, 'steer',
        { id: createDeliveryId(), requireConfirmed: true })
    } catch (cause) {
      if (!isCurrent()) return
      throw cause
    }
  }

  async function sendMessageToSelectedThread(
    text: string,
    imageUrls: string[] = [],
    skills: Array<{ name: string; path: string }> = [],
    mode: 'steer' | 'queue' = 'queue',
    fileAttachments: FileAttachment[] = [],
    queueInsertIndex?: number,
    collaborationModeOverride?: CollaborationModeKind,
  ): Promise<void> {
    const isCurrent = captureThreadSendContext()
    if (!isCurrent()) return
    if (isModelSettingsUpdating()) return

    const threadId = selection.getThreadId()
    const nextText = text.trim()
    if (!threadId || (!nextText && imageUrls.length === 0 && fileAttachments.length === 0)) return

    const isInProgress = turn.isInProgress(threadId)

    if (isInProgress && mode === 'queue') {
      const queue = sendQueue.getMessages(threadId)
      const insertIndex = typeof queueInsertIndex === 'number'
        ? Math.max(0, Math.min(queueInsertIndex, queue.length))
        : queue.length
      await sendQueue.commit({
        type: 'add',
        threadId,
        beforeId: queue[insertIndex]?.id,
        message: {
          id: createDeliveryId(),
          text: nextText,
          imageUrls,
          skills,
          fileAttachments,
          collaborationMode: collaborationModeOverride ?? selection.getCollaborationMode(),
          ...model.getSettings(model.readId(threadId), imageUrls.length > 0),
        },
      })
      return
    }

    if (isInProgress) {
      await startTurnForThread(threadId, nextText, imageUrls, skills, fileAttachments, collaborationModeOverride, 'steer')
      return
    }

    setPageError('')
    turn.setSummary(threadId, null)
    turn.setActivity(
      threadId,
      {
        label: 'Thinking',
        details: buildPendingTurnDetails(
          model.readId(threadId),
          selection.getReasoningEffort(),
          collaborationModeOverride === 'plan'
            ? 'plan'
            : collaborationModeOverride === 'default'
              ? 'default'
              : selection.getCollaborationMode(),
        ),
      },
    )
    turn.setError(threadId, null)
    turn.setInProgress(threadId, true)

    try {
      await startTurnForThread(
        threadId,
        nextText,
        imageUrls,
        skills,
        fileAttachments,
        collaborationModeOverride,
      )
    } catch (unknownError) {
      if (!isCurrent()) return
      turn.setInProgress(threadId, false)
      turn.setActivity(threadId, null)
      const errorMessage = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      turn.setError(threadId, errorMessage)
      setPageError(errorMessage)
      throw unknownError
    }
  }

  async function sendMessageToNewThread(
    text: string,
    cwd: string,
    imageUrls: string[] = [],
    skills: Array<{ name: string; path: string }> = [],
    fileAttachments: FileAttachment[] = [],
    confirmedProjectId = '',
  ): Promise<string> {
    const isCurrent = captureThreadSendContext()
    if (!isCurrent()) return ''
    if (isModelSettingsUpdating()) return ''
    if (isSendingMessage.value) return ''

    const nextText = text.trim()
    const targetCwd = cwd.trim()
    let selectedModel = model.readId(newThreadModelContext).trim()
    const preferredChoice = preferences.getNewThreadChoice() ? { ...preferences.getNewThreadChoice()! } : null
    const selectedMode = selection.getCollaborationMode()
    const newThreadSettings = model.getSettings(selectedModel, imageUrls.length > 0)
    if (!nextText && imageUrls.length === 0 && fileAttachments.length === 0) return ''

    const request = {}
    newThreadSendRequest = request
    isSendingMessage.value = true
    setPageError('')
    let threadId = ''

    try {
      try {
        const startedThread = await startThread(targetCwd || undefined, selectedModel || undefined)
        if (!isCurrent()) return ''
        threadId = startedThread.threadId
        model.setId(threadId, startedThread.model)
        model.setProviderId(threadId, startedThread.modelProvider || model.getActiveProviderId())
        selection.setCollaborationMode(threadId, selectedMode)
      } catch (unknownError) {
        if (!isCurrent()) return ''
        if (selectedModel && selectedModel !== modelFallbackId && isUnsupportedChatGptModelError(unknownError)) {
          // A rejected catalog entry affects this runtime only, never saved preferences.
          model.setCatalog(model.getCatalog().filter(model => model.id !== selectedModel))
          selectedModel = preferredChoice && model.getCatalog().length
            ? effectiveConversationChoice(preferredChoice, model.getCatalog()).model
            : modelFallbackId
          model.ensureAvailableIds(selectedModel)
          const fallbackThread = await startThread(targetCwd || undefined, selectedModel)
          if (!isCurrent()) return ''
          threadId = fallbackThread.threadId
          model.setId(threadId, fallbackThread.model)
          model.setProviderId(threadId, fallbackThread.modelProvider || model.getActiveProviderId())
          selection.setCollaborationMode(threadId, selectedMode)
        } else {
          throw unknownError
        }
      }
      if (!threadId) return ''

      insertOptimisticThread(threadId, targetCwd, nextText || attachmentOnlyTitle(imageUrls, fileAttachments), confirmedProjectId)
      appendOptimisticUserMessage(threadId, nextText, imageUrls, skills, fileAttachments)
      turn.blockInterrupt(threadId)
      history.markResumed(threadId)
      selection.setThreadId(threadId)
      preferences.register(threadId, preferredChoice || { model: selectedModel || newThreadSettings.model, provider: model.readProviderId(threadId), effort: newThreadSettings.effort, tier: newThreadSettings.serviceTier || '' })
      selection.setModelProjection(selectedModel || newThreadSettings.model)
      if (!preferredChoice) preferences.saveModelSettings({ effort: newThreadSettings.effort, tier: newThreadSettings.serviceTier || '' })
      turn.setSummary(threadId, null)
      turn.setActivity(
        threadId,
        {
          label: 'Thinking',
          details: buildPendingTurnDetails(
            model.readId(threadId),
            selection.getReasoningEffort(),
            selectedMode,
          ),
        },
      )
      turn.setError(threadId, null)
      turn.setInProgress(threadId, true)
      const capturedThreadId = threadId
      const capturedCwd = targetCwd || null
      const capturedPrompt = nextText
      const capturedFallbackTitle = attachmentOnlyTitle(imageUrls, fileAttachments)
      await startTurnForThread(threadId, nextText, imageUrls, skills, fileAttachments, selectedMode)
        .catch((unknownError) => {
          if (!isCurrent()) return
          turn.setInProgress(threadId, false)
          turn.setActivity(threadId, null)
          const errorMessage = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
          turn.setError(threadId, errorMessage)
          setPageError(errorMessage)
          throw unknownError
        })
      if (!isCurrent()) return ''
      void requestThreadTitleGeneration(capturedThreadId, capturedPrompt, capturedCwd, capturedFallbackTitle)
      return threadId
    } catch (unknownError) {
      if (!isCurrent()) return ''
      if (threadId) {
        turn.setInProgress(threadId, false)
        turn.setActivity(threadId, null)
      }
      const errorMessage = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      if (threadId) {
        turn.setError(threadId, errorMessage)
      }
      setPageError(errorMessage)
      if (threadId && unknownError instanceof Error) Object.assign(unknownError, { createdThreadId: threadId })
      throw unknownError
    } finally {
      if (newThreadSendRequest === request) resetThreadSendRequest()
    }
  }

  async function startTurnForThread(
    threadId: string,
    nextText: string,
    imageUrls: string[] = [],
    skills: Array<{ name: string; path: string }> = [],
    fileAttachments: FileAttachment[] = [],
    collaborationModeOverride?: CollaborationModeKind,
    deliveryMode?: 'immediate' | 'steer',
    deliveryOptions?: { id: string; requireConfirmed?: boolean },
  ): Promise<void> {
    const isCurrent = captureThreadSendContext()
    if (!isCurrent()) return
    const collaborationMode = collaborationModeOverride === 'plan' ? 'plan' : collaborationModeOverride === 'default'
      ? 'default'
      : selection.getCollaborationMode()
    const normalizedText = nextText.trim()
    const normalizedImageUrls = [...imageUrls]
    if (
      normalizedImageUrls.length === 0
      && shouldReuseAttachedImageFromPrompt(normalizedText)
    ) {
      const latestAttachedImageUrl = findLatestUserLocalImageUrl(threadId)
      if (latestAttachedImageUrl) {
        normalizedImageUrls.push(latestAttachedImageUrl)
      }
    }
    let deliveryId = deliveryOptions?.id || createDeliveryId()
    const isSteering = deliveryMode === 'steer'
    const previousTurnId = turn.getActiveId(threadId)
    const userMessageOrdinal = readNextUserMessageOrdinal(threadId, previousTurnId)
    if (isSteering) conversationDeliveries.begin(threadId, {
      id: deliveryId, text: nextText, imageUrls: normalizedImageUrls, skills, fileAttachments, collaborationMode,
    }, userMessageOrdinal, false, previousTurnId)
    try {
      // Capture the submitted choice before resume can yield to another conversation.
      const executionSettings = { ...model.getSettings(model.readId(threadId), normalizedImageUrls.length > 0) }
      if (!history.isResumed(threadId)) {
        const resumedThread = await resumeThread(threadId)
        if (!isCurrent()) return
        if (resumedThread.model) {
          model.setId(threadId, model.resolveForProvider(threadId, resumedThread.model, resumedThread.modelProvider))
        }
        if (resumedThread.modelProvider) {
          model.setProviderId(threadId, resumedThread.modelProvider)
        }
        history.markResumed(threadId)
      }
      const reasoningEffort = executionSettings.effort
      const startedTurnId = await startThreadTurn(
        threadId, nextText, normalizedImageUrls, executionSettings.model || undefined,
        reasoningEffort || undefined, skills.length > 0 ? skills : undefined,
        fileAttachments, collaborationMode, executionSettings.serviceTier,
        deliveryMode || 'immediate', { id: deliveryId, requireConfirmed: deliveryOptions?.requireConfirmed, canPrepare: isCurrent,
          onPrepared: id => {
            if (!isCurrent() || !isSteering) return
            conversationDeliveries.replaceId(deliveryId, id)
            deliveryId = id
            conversationDeliveries.refresh()
          },
          onResult: result => {
            if (!isCurrent() || !isSteering) return
            conversationDeliveries.replaceId(deliveryId, result.id)
            deliveryId = result.id
            conversationDeliveries.refresh()
          },
        },
      )
      if (!isCurrent()) return
      if (!startedTurnId) {
        // A queued steer must not clear the already running turn.
        if (!previousTurnId) {
          turn.setInProgress(threadId, false)
          turn.setActivity(threadId, null)
        }
        const messages = history.getMessages(threadId)
        history.setMessages(threadId, messages.filter(message => !(isOptimisticUserMessage(message) && !message.turnId && message.text === readQuestionReply(nextText).text)))
        await sendQueue.refresh().catch(() => {})
        if (!isCurrent()) return
      }

      if (startedTurnId) {
        turn.setInProgress(threadId, true)
        const previous = history.getMessages(threadId)
        history.setMessages(threadId, previous.filter(message => !(isOptimisticUserMessage(message) && !message.turnId && message.text === readQuestionReply(nextText).text)))
        if (isSteering) {
          conversationDeliveries.patch(deliveryId, { status: 'accepted', turnId: startedTurnId, userMessageOrdinal: resolveUserMessageOrdinal(startedTurnId, previousTurnId, userMessageOrdinal) })
          conversationDeliveries.observe(threadId, previous)
        } else {
          appendOptimisticUserMessage(threadId, nextText, normalizedImageUrls, skills, fileAttachments, { id: deliveryId, turnId: startedTurnId, userMessageOrdinal: resolveUserMessageOrdinal(startedTurnId, previousTurnId, userMessageOrdinal) })
        }
        turn.setActiveId(threadId, startedTurnId)
        turn.unblockInterrupt(threadId, startedTurnId)
      }

      history.markDirty(threadId)
      // Delivery is already durably acknowledged; a later read failure cannot undo it.
      await syncFromNotifications().catch(() => {})
      if (!isCurrent()) return
      scheduleDelayedTurnSync(threadId)
    } catch (unknownError) {
      if (!isCurrent()) return
      if (isSteering) {
        conversationDeliveries.refresh()
        // A saved outbox/queue record keeps its real uncertain status. Only a
        // preflight failure, before any durable submission, is known not sent.
        const row = getDeliveryRows().find(row => row.id === deliveryId)
        if (row?.status === 'submitting') conversationDeliveries.patch(deliveryId, { status: 'failed', error: String(unknownError) })
        void sendQueue.refresh().catch(() => {})
      }
      throw unknownError
    }
  }

  function start(): void {
    threadSendStopped = false
  }

  function stop(): void {
    sendLifecycleRevision++
    threadSendStopped = true
    resetThreadSendRequest()
  }

  return {
    isSendingMessage: computed(() => isSendingMessage.value),
    captureThreadSendContext, sendMessageToSelectedThread, sendMessageToNewThread, answerAsyncQuestions,
    start, stop, invalidateForAccountChange: resetThreadSendRequest,
  }
}
