import { ref } from 'vue'
import type { RpcNotification } from '../api/codexRpcClient'
import { pickCodexRateLimitSnapshot } from '../api/accountGateway'
import { invalidateModelCatalog } from '../api/modelCatalog'
import { observeCompactionNotification } from '../api/threadCompaction'
import { persistThreadTitle } from '../api/threadPreferencesGateway'
import { normalizeThreadMessagesV2, normalizeFileChangeStatus, toUiFileChanges } from '../api/normalizers/v2'
import { normalizeToolSummary } from '../api/normalizers/toolSummary'
import { authRecoveryFromNotification, type AuthRecoveryState } from '../authRecovery'
import { updateCompactionMessages } from '../compaction'
import { mergeMessages } from '../messageIdentity'
import { mergeQuotaUpdate } from '../quotaRefresh'
import { mergeSubtaskMessage, observeTaskNotification } from '../subtasks'
import { changesThreadSearch } from '../threadSearchEvents'
import type { TurnSummaryState } from '../turnSummary'
import { readAsyncQuestions } from '../userQuestions'
import type { CommandExecutionData, UiMessage, UiPlanData, UiPlanStep, UiRateLimitSnapshot, UiThreadTokenUsage, UiTokenUsageBreakdown } from '../types/codex'
import { asRecord, clamp, extractThreadIdFromNotification, readNumber, readString } from './threadNotificationValues'
import { createThreadTurnLifecycleState, type ThreadTurnStartInfo } from './threadTurnLifecycleState'
import { createThreadLiveAgentState } from './threadLiveAgentState'
import { createThreadLiveCommandState } from './threadLiveCommandState'
import { createThreadLiveFileChangeState } from './threadLiveFileChangeState'
import { createThreadLivePlanState } from './threadLivePlanState'
import { createThreadLiveReasoningState } from './threadLiveReasoningState'

export type TurnActivityState = {
  label: string
  details: string[]
}

type TurnCompletedInfo = {
  threadId: string
  turnId: string
  completedAtMs: number
  startedAtMs?: number
}

type ThreadRealtimeControllerOptions = {
  getSelectedThreadId: () => string
  history: {
    getMessages: (threadId: string) => readonly Readonly<UiMessage>[]
    setMessages: (threadId: string, messages: readonly UiMessage[]) => void
  }
  turns: {
    getIndex: (threadId: string, turnId: string) => number | undefined
    setIndex: (threadId: string, turnId: string, index: number) => void
    inferNextIndex: (threadId: string) => number
    getActiveTurnId: (threadId: string) => string | undefined
    setActiveTurnId: (threadId: string, turnId: string) => void
    clearActiveTurn: (threadId: string) => void
    unblockInterrupt: (threadId: string, turnId: string) => void
  }
  status: {
    setInProgress: (threadId: string, running: boolean) => void
    setActivity: (threadId: string, activity: TurnActivityState | null) => void
    setSummary: (threadId: string, summary: TurnSummaryState | null) => void
    setError: (threadId: string, message: string | null, options?: { transient?: boolean }) => void
    clearTransientError: (threadId: string) => void
    setPageError: (message: string) => void
  }
  metadata: {
    markSearchChanged: () => void
    refreshModels: () => Promise<void>
    setAuthRecovery: (threadId: string, recovery: AuthRecoveryState | null) => void
    setReportedModel: (threadId: string, model: string) => void
    setTitle: (threadId: string, title: string) => void
    markQuotaUpdated: () => void
    scheduleQuotaRefresh: () => void
    getQuotaSnapshot: () => UiRateLimitSnapshot | null
    applyQuotaSnapshot: (snapshot: UiRateLimitSnapshot | null) => void
    setTokenUsage: (threadId: string, usage: UiThreadTokenUsage) => void
  }
  handleServerRequest: (notification: RpcNotification) => boolean
  scheduleQueueRefresh: (threadId: string) => void
  clearDelayedTurnSync: (threadId: string) => void
}

export function createThreadRealtimeController({
  getSelectedThreadId,
  history,
  turns,
  status,
  metadata,
  handleServerRequest,
  scheduleQueueRefresh,
  clearDelayedTurnSync,
}: ThreadRealtimeControllerOptions) {
  const livePlanMessagesByThreadId = ref<Record<string, UiMessage[]>>({})
  const threadLivePlanState = createThreadLivePlanState({ messagesByThreadId: livePlanMessagesByThreadId })
  const liveAgentMessagesByThreadId = ref<Record<string, UiMessage[]>>({})
  const threadLiveAgentState = createThreadLiveAgentState({ messagesByThreadId: liveAgentMessagesByThreadId })
  const liveReasoningTextByThreadId = ref<Record<string, string>>({})
  const threadLiveReasoningState = createThreadLiveReasoningState({ textByThreadId: liveReasoningTextByThreadId })
  const liveCommandsByThreadId = ref<Record<string, UiMessage[]>>({})
  const threadLiveCommandState = createThreadLiveCommandState({ commandsByThreadId: liveCommandsByThreadId })
  const liveFileChangeMessagesByThreadId = ref<Record<string, UiMessage[]>>({})
  const threadLiveFileChangeState = createThreadLiveFileChangeState({ messagesByThreadId: liveFileChangeMessagesByThreadId })
  const threadTurnLifecycleState = createThreadTurnLifecycleState()
  let activeReasoningItemId = ''
  let active = true

  function parseIsoTimestamp(value: string): number | null {
    if (!value) return null
    const ms = new Date(value).getTime()
    return Number.isNaN(ms) ? null : ms
  }

  function normalizePlanStepStatus(value: unknown): UiPlanStep['status'] {
    if (value === 'completed') return 'completed'
    if (value === 'inProgress' || value === 'in_progress') return 'inProgress'
    return 'pending'
  }

  function buildPlanMessageText(plan: UiPlanData): string {
    const lines: string[] = []
    if (plan.explanation?.trim()) {
      lines.push(plan.explanation.trim())
    }
    for (const step of plan.steps) {
      const marker = step.status === 'completed' ? 'x' : step.status === 'inProgress' ? '~' : ' '
      lines.push(`- [${marker}] ${step.step}`)
    }
    return lines.join('\n').trim()
  }

  function readPlanUpdate(notification: RpcNotification): { threadId: string; message: UiMessage } | null {
    if (notification.method !== 'turn/plan/updated') return null
    const params = asRecord(notification.params)
    const threadId = extractThreadIdFromNotification(notification)
    const turnId = readString(params?.turnId) || readString(params?.turn_id)
    const rawSteps = Array.isArray(params?.plan) ? params?.plan : []
    const steps: UiPlanStep[] = rawSteps
      .map((row) => asRecord(row))
      .map((row) => ({
        step: readString(row?.step),
        status: normalizePlanStepStatus(row?.status),
      }))
      .filter((row) => row.step.length > 0)

    if (!threadId || !turnId) return null

    const explanation = readString(params?.explanation).trim()
    const plan: UiPlanData = {
      explanation: explanation || undefined,
      steps,
      isStreaming: true,
    }

    return {
      threadId,
      message: {
        id: `${turnId}:plan`,
        role: 'assistant',
        text: buildPlanMessageText(plan),
        messageType: 'plan.live',
        plan,
      },
    }
  }

  function readPlanDelta(notification: RpcNotification): { threadId: string; message: UiMessage } | null {
    if (notification.method !== 'item/plan/delta') return null
    const params = asRecord(notification.params)
    const threadId = extractThreadIdFromNotification(notification)
    const turnId = readString(params?.turnId) || readString(params?.turn_id)
    const delta = readString(params?.delta)
    if (!threadId || !turnId || !delta) return null

    const messageId = `${turnId}:plan`
    const existing = threadLivePlanState.findMessage(threadId, messageId)
    const nextText = `${existing?.text ?? ''}${delta}`
    const nextPlan: UiPlanData | undefined = existing?.plan
      ? { ...existing.plan, isStreaming: true }
      : undefined

    return {
      threadId,
      message: {
        id: messageId,
        role: 'assistant',
        text: nextText,
        messageType: 'plan.live',
        plan: nextPlan,
      },
    }
  }

  function normalizeTokenUsageBreakdown(value: unknown): UiTokenUsageBreakdown | null {
    const record = asRecord(value)
    if (!record) return null

    const totalTokens = readNumber(record.totalTokens ?? record.total_tokens)
    const inputTokens = readNumber(record.inputTokens ?? record.input_tokens)
    const cachedInputTokens = readNumber(record.cachedInputTokens ?? record.cached_input_tokens)
    const outputTokens = readNumber(record.outputTokens ?? record.output_tokens)
    const reasoningOutputTokens = readNumber(record.reasoningOutputTokens ?? record.reasoning_output_tokens)
    if (
      totalTokens === null ||
      inputTokens === null ||
      cachedInputTokens === null ||
      outputTokens === null ||
      reasoningOutputTokens === null
    ) {
      return null
    }

    return {
      totalTokens,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
    }
  }

  function normalizeThreadTokenUsage(value: unknown): UiThreadTokenUsage | null {
    const record = asRecord(value)
    if (!record) return null

    const total = normalizeTokenUsageBreakdown(record.total)
    const last = normalizeTokenUsageBreakdown(record.last)
    if (!total || !last) return null

    const modelContextWindow = readNumber(record.modelContextWindow ?? record.model_context_window)
    const currentContextTokens = last.totalTokens
    const remainingContextTokens = typeof modelContextWindow === 'number'
      ? Math.max(modelContextWindow - currentContextTokens, 0)
      : null
    const remainingContextPercent = typeof modelContextWindow === 'number' && modelContextWindow > 0
      ? clamp(Math.round((remainingContextTokens ?? 0) / modelContextWindow * 100), 0, 100)
      : null

    return {
      total,
      last,
      modelContextWindow,
      currentContextTokens,
      remainingContextTokens,
      remainingContextPercent,
    }
  }

  function readThreadTokenUsageUpdate(notification: RpcNotification): { threadId: string; usage: UiThreadTokenUsage } | null {
    if (notification.method !== 'thread/tokenUsage/updated') return null
    const params = asRecord(notification.params)
    const threadId = extractThreadIdFromNotification(notification)
    const usage = normalizeThreadTokenUsage(params?.tokenUsage ?? params?.token_usage)
    if (!threadId || !usage) return null
    return { threadId, usage }
  }

  function readTurnErrorMessage(notification: RpcNotification): string {
    if (notification.method !== 'turn/completed') return ''
    const params = asRecord(notification.params)
    const turn = asRecord(params?.turn)
    if (!turn || turn.status !== 'failed') return ''
    const errorPayload = asRecord(turn.error)
    return readString(errorPayload?.message)
  }

  function readNotificationErrorState(notification: RpcNotification): { message: string; transient: boolean } | null {
    if (notification.method !== 'error') return null
    const params = asRecord(notification.params)
    const message = (
      readString(params?.message) ||
      readString(asRecord(params?.error)?.message)
    )
    if (!message) return null

    return {
      message,
      transient: params?.willRetry === true,
    }
  }

  function readTurnActivity(notification: RpcNotification): { threadId: string; activity: TurnActivityState } | null {
    const threadId = extractThreadIdFromNotification(notification)
    if (!threadId) return null

    if (notification.method === 'turn/started') {
      return {
        threadId,
        activity: {
          label: 'Thinking',
          details: [],
        },
      }
    }

    if (notification.method === 'item/started') {
      const params = asRecord(notification.params)
      const item = asRecord(params?.item)
      const itemType = readString(item?.type).toLowerCase()
      if (itemType === 'reasoning') {
        return {
          threadId,
          activity: {
            label: 'Thinking',
            details: [],
          },
        }
      }
      if (itemType === 'agentmessage') {
        return {
          threadId,
          activity: {
            label: 'Writing response',
            details: [],
          },
        }
      }
      if (itemType === 'commandexecution') {
        const cmd = readString(item?.command)
        return {
          threadId,
          activity: {
            label: 'Running command',
            details: cmd ? [cmd] : [],
          },
        }
      }
      if (itemType === 'filechange') {
        const changes = Array.isArray(item?.changes) ? item.changes : []
        const firstChange = changes[0] as Record<string, unknown> | undefined
        const path = readString(firstChange?.path)
        return {
          threadId,
          activity: {
            label: 'Applying changes',
            details: path ? [path] : [],
          },
        }
      }
    }

    if (notification.method === 'item/commandExecution/outputDelta') {
      return {
        threadId,
        activity: {
          label: 'Running command',
          details: [],
        },
      }
    }

    if (notification.method === 'item/fileChange/outputDelta') {
      return {
        threadId,
        activity: {
          label: 'Applying changes',
          details: [],
        },
      }
    }

    if (
      notification.method === 'item/reasoning/summaryTextDelta' ||
      notification.method === 'item/reasoning/summaryPartAdded' ||
      notification.method === 'item/reasoning/textDelta'
    ) {
      return {
        threadId,
        activity: {
          label: 'Thinking',
          details: [],
        },
      }
    }

    if (notification.method === 'item/agentMessage/delta') {
      return {
        threadId,
        activity: {
          label: 'Writing response',
          details: [],
        },
      }
    }

    return null
  }

  function readTurnStartedInfo(notification: RpcNotification): ThreadTurnStartInfo | null {
    if (notification.method !== 'turn/started') {
      return null
    }

    const params = asRecord(notification.params)
    if (!params) return null
    const threadId = extractThreadIdFromNotification(notification)
    if (!threadId) return null

    const turnPayload = asRecord(params.turn)
    const turnId =
      readString(turnPayload?.id) ||
      readString(params.turnId) ||
      `${threadId}:unknown`
    if (!turnId) return null

    const startedAtMs =
      parseIsoTimestamp(readString(turnPayload?.startedAt)) ??
      parseIsoTimestamp(readString(params.startedAt)) ??
      parseIsoTimestamp(notification.atIso) ??
      Date.now()

    return {
      threadId,
      turnId,
      startedAtMs,
    }
  }

  function readTurnCompletedInfo(notification: RpcNotification): TurnCompletedInfo | null {
    if (notification.method !== 'turn/completed' && notification.method !== 'turn/cancelled') {
      return null
    }

    const params = asRecord(notification.params)
    if (!params) return null
    const threadId = extractThreadIdFromNotification(notification)
    if (!threadId) return null

    const turnPayload = asRecord(params.turn)
    const turnId =
      readString(turnPayload?.id) ||
      readString(params.turnId) ||
      `${threadId}:unknown`
    if (!turnId) return null

    const completedAtMs =
      parseIsoTimestamp(readString(turnPayload?.completedAt)) ??
      parseIsoTimestamp(readString(params.completedAt)) ??
      parseIsoTimestamp(notification.atIso) ??
      Date.now()

    const startedAtMs =
      parseIsoTimestamp(readString(turnPayload?.startedAt)) ??
      parseIsoTimestamp(readString(params.startedAt)) ??
      undefined

    return {
      threadId,
      turnId,
      completedAtMs,
      startedAtMs,
    }
  }

  function liveReasoningMessageId(reasoningItemId: string): string {
    return `${reasoningItemId}:live-reasoning`
  }

  function readReasoningStartedItemId(notification: RpcNotification): string {
    const params = asRecord(notification.params)
    if (!params) return ''

    if (notification.method === 'item/started') {
      const item = asRecord(params.item)
      if (!item || item.type !== 'reasoning') return ''
      return readString(item.id)
    }

    return ''
  }

  function readReasoningDelta(notification: RpcNotification): { messageId: string; delta: string } | null {
    const params = asRecord(notification.params)
    if (!params) return null

    // Канонический источник дельт для UI — уже нормализованный item/*.
    if (notification.method === 'item/reasoning/summaryTextDelta') {
      const itemId = readString(params.itemId)
      const delta = readString(params.delta)
      if (!itemId || !delta) return null
      return { messageId: liveReasoningMessageId(itemId), delta }
    }

    // codex also emits the full reasoning-chain stream as item/reasoning/textDelta
    // (alongside the summary stream). Without handling it, reasoning text the
    // model streams via this channel is dropped and the UI shows only the
    // summary, making long thinking phases look like a stall.
    if (notification.method === 'item/reasoning/textDelta') {
      const itemId = readString(params.itemId)
      const delta = readString(params.delta)
      if (!itemId || !delta) return null
      return { messageId: liveReasoningMessageId(itemId), delta }
    }

    return null
  }

  function readReasoningSectionBreakMessageId(notification: RpcNotification): string {
    const params = asRecord(notification.params)
    if (!params) return ''

    // Канонический source для section break — item/*
    if (notification.method === 'item/reasoning/summaryPartAdded') {
      const itemId = readString(params.itemId)
      if (!itemId) return ''
      return liveReasoningMessageId(itemId)
    }

    return ''
  }

  function readReasoningCompletedId(notification: RpcNotification): string {
    const params = asRecord(notification.params)
    if (!params) return ''

    if (notification.method === 'item/completed') {
      const item = asRecord(params.item)
      if (!item || item.type !== 'reasoning') return ''
      return liveReasoningMessageId(readString(item.id))
    }

    return ''
  }

  function readAgentMessageStartedId(notification: RpcNotification): string {
    const params = asRecord(notification.params)
    if (!params) return ''

    if (notification.method === 'item/started') {
      const item = asRecord(params.item)
      if (!item || item.type !== 'agentMessage') return ''
      return readString(item.id)
    }

    return ''
  }

  function readAgentMessageDelta(notification: RpcNotification): { messageId: string; delta: string } | null {
    const params = asRecord(notification.params)
    if (!params) return null

    // Канонический live-канал агентского текста.
    if (notification.method === 'item/agentMessage/delta') {
      const messageId = readString(params.itemId)
      const delta = readString(params.delta)
      if (!messageId || !delta) return null
      return { messageId, delta }
    }

    return null
  }

  function readAgentMessageCompleted(notification: RpcNotification): UiMessage | null {
    const params = asRecord(notification.params)
    if (!params) return null

    if (notification.method === 'item/completed') {
      const item = asRecord(params.item)
      if (!item || item.type !== 'agentMessage') return null
      const id = readString(item.id)
      const text = readString(item.text)
      const questions = readAsyncQuestions(item.questions)
      if (!id || (!text && !questions.length)) return null
      return {
        id,
        role: 'assistant',
        text,
        delivery: item.delivery === 'async' ? 'async' : undefined,
        questions,
        turnId: readString(params.turnId) || undefined,
        messageType: 'agentMessage.live',
      }
    }

    return null
  }

  function toLocalImageUrl(path: string): string {
    return `/codex-local-image?path=${encodeURIComponent(path)}`
  }

  function toImageGenerationUrl(value: string): string {
    const trimmed = value.trim()
    if (!trimmed) return ''
    if (
      trimmed.startsWith('data:') ||
      trimmed.startsWith('http://') ||
      trimmed.startsWith('https://') ||
      trimmed.startsWith('/codex-local-image?')
    ) {
      return trimmed
    }
    const compact = trimmed.replace(/\s+/gu, '')
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(compact)) return ''
    return `data:image/png;base64,${compact}`
  }

  function readCompletedImageView(notification: RpcNotification): UiMessage | null {
    if (notification.method !== 'item/completed') return null
    const params = asRecord(notification.params)
    const item = asRecord(params?.item)
    if (!item) return null
    const id = readString(item.id)
    if (!id) return null
    if (item.type === 'imageView') {
      const path = readString(item.path)
      if (!path) return null
      return {
        id,
        role: 'assistant',
        text: '',
        images: [toLocalImageUrl(path)],
        messageType: 'imageView',
      }
    }
    if (item.type !== 'imageGeneration' && item.type !== 'image_generation') return null
    const result = readString(item.result)
    const imageUrl = result ? toImageGenerationUrl(result) : ''
    if (!imageUrl) return null
    return {
      id,
      role: 'assistant',
      text: '',
      images: [imageUrl],
      messageType: 'imageView',

    }
  }

  function readCommandExecutionStarted(notification: RpcNotification): UiMessage | null {
    if (notification.method !== 'item/started') return null
    const params = asRecord(notification.params)
    const item = asRecord(params?.item)
    if (!item || item.type !== 'commandExecution') return null
    const id = readString(item.id)
    const command = readString(item.command)
    if (!id) return null
    const cwd = typeof item.cwd === 'string' ? item.cwd : null
    const threadId = extractThreadIdFromNotification(notification)
    const turnId = readString(params?.turnId) || readString(params?.turn_id)
    const turnIndex = threadId && turnId ? turns.getIndex(threadId, turnId) : undefined
    return {
      id,
      role: 'system',
      text: command,
      messageType: 'commandExecution',
      commandExecution: { command, cwd, status: 'inProgress', aggregatedOutput: '', exitCode: null },
      turnId: turnId || undefined,
      turnIndex: typeof turnIndex === 'number' ? turnIndex : undefined,
    }
  }

  function readCommandOutputDelta(notification: RpcNotification): { itemId: string; delta: string } | null {
    if (notification.method !== 'item/commandExecution/outputDelta') return null
    const params = asRecord(notification.params)
    if (!params) return null
    const itemId = readString(params.itemId)
    const delta = readString(params.delta)
    if (!itemId || !delta) return null
    return { itemId, delta }
  }

  function readCommandExecutionCompleted(notification: RpcNotification): UiMessage | null {
    if (notification.method !== 'item/completed') return null
    const params = asRecord(notification.params)
    const item = asRecord(params?.item)
    if (!item || item.type !== 'commandExecution') return null
    const id = readString(item.id)
    const command = readString(item.command)
    if (!id) return null
    const cwd = typeof item.cwd === 'string' ? item.cwd : null
    const statusRaw = readString(item.status)
    const status: CommandExecutionData['status'] =
      statusRaw === 'failed' ? 'failed' : statusRaw === 'declined' ? 'declined' : statusRaw === 'interrupted' ? 'interrupted' : 'completed'
    const aggregatedOutput = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : ''
    const exitCode = typeof item.exitCode === 'number' ? item.exitCode : null
    const threadId = extractThreadIdFromNotification(notification)
    const turnId = readString(params?.turnId) || readString(params?.turn_id)
    const turnIndex = threadId && turnId ? turns.getIndex(threadId, turnId) : undefined
    return {
      id,
      role: 'system',
      text: command,
      messageType: 'commandExecution',
      commandExecution: { command, cwd, status, aggregatedOutput, exitCode },
      turnId: turnId || undefined,
      turnIndex: typeof turnIndex === 'number' ? turnIndex : undefined,
    }
  }

  function readCompletedFileChange(notification: RpcNotification): UiMessage | null {
    if (notification.method !== 'item/completed') return null
    const params = asRecord(notification.params)
    const item = asRecord(params?.item)
    if (!item || item.type !== 'fileChange') return null
    const id = readString(item.id)
    if (!id) return null
    const threadId = readString(params?.threadId)
    const turnId = readString(params?.turnId)
    const turnIndex = threadId && turnId ? turns.getIndex(threadId, turnId) : undefined

    const fileChanges = toUiFileChanges(item.changes)
    const fileChangeStatus = normalizeFileChangeStatus(item.status)
    if (fileChanges.length === 0 || fileChangeStatus !== 'completed') return null

    return {
      id,
      role: 'system',
      text: '',
      messageType: 'fileChange',
      fileChangeStatus,
      fileChanges,
      turnId: turnId || undefined,
      turnIndex: typeof turnIndex === 'number' ? turnIndex : undefined,
    }
  }

  function isAgentContentEvent(notification: RpcNotification): boolean {
    if (notification.method === 'item/agentMessage/delta') {
      return true
    }

    const params = asRecord(notification.params)
    if (!params) return false

    if (notification.method === 'item/completed') {
      const item = asRecord(params.item)
      return item?.type === 'agentMessage'
    }

    return false
  }

  function applyRealtimeUpdates(notification: RpcNotification): void {
    observeCompactionNotification(notification)
    observeTaskNotification(notification)
    const compactionThreadId = extractThreadIdFromNotification(notification)
    if (compactionThreadId) {
      const updated = updateCompactionMessages(history.getMessages(compactionThreadId) ?? [], notification.method, notification.params)
      if (updated) history.setMessages(compactionThreadId, updated)
    }
    if (changesThreadSearch(notification.method)) metadata.markSearchChanged()
    if (notification.method === 'item/started' || notification.method === 'item/completed') {
      const params = asRecord(notification.params)
      const item = asRecord(params?.item)
      const threadId = readString(params?.threadId)
      const turnId = readString(params?.turnId) || turns.getActiveTurnId(threadId)
      if (item?.type === 'userMessage' && threadId && turnId) {
        const normalized = normalizeThreadMessagesV2({ thread: { turns: [{ id: turnId, items: [item] }] } } as Parameters<typeof normalizeThreadMessagesV2>[0])
          .map(message => ({ ...message, historyOrdinal: undefined, userMessageOrdinal: undefined }))
        history.setMessages(threadId, mergeMessages(history.getMessages(threadId) || [], normalized, { preserveMissing: true }))
      }
    }
    if (notification.method === 'item/started' || notification.method === 'item/completed') {
      const params = asRecord(notification.params)
      const threadId = readString(params?.threadId)
      const summary = normalizeToolSummary(params?.item)
      if (threadId && summary) {
        const messages = history.getMessages(threadId) || []
        const next = { ...summary, turnId: readString(params?.turnId) || undefined }
        const index = messages.findIndex(message => message.id === summary.id)
        history.setMessages(threadId, index < 0 ? [...messages, next] : messages.map((message, offset) => offset === index ? mergeSubtaskMessage(message, next) : message))
      }
    }
    if (['account/updated', 'model/list/updated', 'models/updated', 'config/updated'].includes(notification.method)) {
      invalidateModelCatalog()
      void metadata.refreshModels()
    }
    const authRecovery = authRecoveryFromNotification(notification.method, notification.params)
    if (authRecovery) {
      metadata.setAuthRecovery(authRecovery.threadId, authRecovery)
      return
    }
    if (notification.method === 'turn/started' || notification.method === 'turn/completed' || notification.method === 'turn/cancelled') {
      const threadId = extractThreadIdFromNotification(notification)
      if (threadId) {
        metadata.setAuthRecovery(threadId, null)
      }
    }
    if (notification.method === 'model/rerouted') {
      const params = asRecord(notification.params)
      const threadId = readString(params?.threadId)
      const model = readString(params?.toModel)
      if (threadId && model) {
        metadata.setReportedModel(threadId, model)
        status.setActivity(threadId, { label: '实际执行模型已变更', details: [model] })
        history.setMessages(threadId, [...(history.getMessages(threadId) || []).filter(message => message.id !== `model-rerouted-${params?.turnId}`), { id: `model-rerouted-${params?.turnId}`, role: 'system', text: `实际执行模型：${model}`, messageType: 'modelRerouted', turnId: readString(params?.turnId) || undefined }])
      }
    }
    if (handleServerRequest(notification)) {
      return
    }

    if (notification.method === 'account/updated' || notification.method === 'account/login/completed') {
      metadata.markQuotaUpdated()
      metadata.scheduleQuotaRefresh()
    }

    if (notification.method === 'thread/name/updated') {
      const params = asRecord(notification.params)
      const threadId = readString(params?.threadId)
      const threadName = readString(params?.threadName)
      if (threadId && threadName) {
        metadata.setTitle(threadId, threadName)
        void persistThreadTitle(threadId, threadName)
      }
    }

    if (notification.method === 'account/rateLimits/updated') {
      metadata.markQuotaUpdated()
      metadata.applyQuotaSnapshot(pickCodexRateLimitSnapshot({ rateLimits: mergeQuotaUpdate(metadata.getQuotaSnapshot(), notification.params) }))
      return
    }

    const tokenUsageUpdate = readThreadTokenUsageUpdate(notification)
    if (tokenUsageUpdate) {
      metadata.setTokenUsage(tokenUsageUpdate.threadId, tokenUsageUpdate.usage)
      return
    }

    if (notification.method === 'thread/status/changed') {
      const params = asRecord(notification.params)
      const threadId = extractThreadIdFromNotification(notification)
      const reportedStatus = readString(asRecord(params?.status)?.type) || readString(params?.status)
      if (threadId && ['active', 'inProgress', 'running', 'idle', 'notLoaded', 'systemError'].includes(reportedStatus)) {
        const running = ['active', 'inProgress', 'running'].includes(reportedStatus)
        status.setInProgress(threadId, running)
      }
    }
    const turnActivity = readTurnActivity(notification)
    if (turnActivity) {
      status.setActivity(turnActivity.threadId, turnActivity.activity)
    }

    const notificationThreadId = extractThreadIdFromNotification(notification)
    const notificationErrorState = readNotificationErrorState(notification)
    if (!notificationErrorState && notificationThreadId) {
      status.clearTransientError(notificationThreadId)
    }

    const startedTurn = readTurnStartedInfo(notification)
    if (startedTurn) {
      if (!threadTurnLifecycleState.rememberStarted(startedTurn)) return
      turns.setIndex(startedTurn.threadId, startedTurn.turnId, turns.inferNextIndex(startedTurn.threadId))
      turns.setActiveTurnId(startedTurn.threadId, startedTurn.turnId)
      turns.unblockInterrupt(startedTurn.threadId, startedTurn.turnId)
      clearLivePlansForThread(startedTurn.threadId)
      clearLiveFileChangesForThread(startedTurn.threadId)
      status.setSummary(startedTurn.threadId, null)
      status.setError(startedTurn.threadId, null)
      status.setInProgress(startedTurn.threadId, true)
      scheduleQueueRefresh(startedTurn.threadId)

    }

    const completedTurn = readTurnCompletedInfo(notification)
    const turnErrorMessage = readTurnErrorMessage(notification)
    if (completedTurn) {
      threadTurnLifecycleState.rememberFinished(completedTurn.threadId, completedTurn.turnId)
      const activeTurn = turns.getActiveTurnId(completedTurn.threadId)
      if (activeTurn && activeTurn !== completedTurn.turnId) return
      const startedTurnState = threadTurnLifecycleState.takeStarted(completedTurn.turnId)

      const rawDurationMs =
        readNumber(asRecord(notification.params)?.durationMs) ??
        readNumber(asRecord(asRecord(notification.params)?.turn)?.durationMs) ??
        (typeof completedTurn.startedAtMs === 'number'
          ? completedTurn.completedAtMs - completedTurn.startedAtMs
          : null) ??
        (startedTurnState ? completedTurn.completedAtMs - startedTurnState.startedAtMs : null)

      const durationMs = typeof rawDurationMs === 'number' ? Math.max(0, rawDurationMs) : 0
      status.setSummary(completedTurn.threadId, {
        turnId: completedTurn.turnId,
        durationMs,
      })
      turns.clearActiveTurn(completedTurn.threadId)
      status.setInProgress(completedTurn.threadId, false)
      status.setActivity(completedTurn.threadId, null)
      scheduleQueueRefresh(completedTurn.threadId)
    }

    if (turnErrorMessage) {
      const failedThreadId = completedTurn?.threadId || extractThreadIdFromNotification(notification)
      if (failedThreadId) {
        status.setError(failedThreadId, turnErrorMessage)
      }
      status.setPageError(turnErrorMessage)

    } else if (completedTurn) {
      status.setError(completedTurn.threadId, null)
    }

    if (notificationErrorState) {
      const errorThreadId = notificationThreadId
      if (errorThreadId) {
        status.setError(errorThreadId, notificationErrorState.message, {
          transient: notificationErrorState.transient,
        })
      }
      status.setPageError(notificationErrorState.message)

    }

    const planUpdate = readPlanUpdate(notification)
    if (planUpdate) {
      upsertLivePlanMessage(planUpdate.threadId, planUpdate.message)
      status.setActivity(planUpdate.threadId, {
        label: 'Planning',
        details: planUpdate.message.plan?.steps.map((step) => step.step).slice(0, 2) ?? [],
      })
    }

    const planDelta = readPlanDelta(notification)
    if (planDelta) {
      upsertLivePlanMessage(planDelta.threadId, planDelta.message)
      status.setActivity(planDelta.threadId, {
        label: 'Planning',
        details: [],
      })
    }

    if (!notificationThreadId || notificationThreadId !== getSelectedThreadId()) return

    const startedAgentMessageId = readAgentMessageStartedId(notification)
    if (startedAgentMessageId) {
      activeReasoningItemId = ''
    }

    const liveAgentMessageDelta = readAgentMessageDelta(notification)
    if (liveAgentMessageDelta) {
      const existing = threadLiveAgentState.findMessage(notificationThreadId, liveAgentMessageDelta.messageId)
      const nextText = `${existing?.text ?? ''}${liveAgentMessageDelta.delta}`
      upsertLiveAgentMessage(notificationThreadId, {
        id: liveAgentMessageDelta.messageId,
        role: 'assistant',
        text: nextText,
        messageType: 'agentMessage.live',
      })
    }

    const completedAgentMessage = readAgentMessageCompleted(notification)
    if (completedAgentMessage) {
      upsertLiveAgentMessage(notificationThreadId, completedAgentMessage)
    }

    const completedImageView = readCompletedImageView(notification)
    if (completedImageView) {
      upsertLiveAgentMessage(notificationThreadId, completedImageView)

    }

    const startedReasoningItemId = readReasoningStartedItemId(notification)
    if (startedReasoningItemId) {
      activeReasoningItemId = startedReasoningItemId
    }

    const liveReasoningDelta = readReasoningDelta(notification)
    if (liveReasoningDelta) {
      appendLiveReasoningText(notificationThreadId, liveReasoningDelta.delta)
    }

    const sectionBreakMessageId = readReasoningSectionBreakMessageId(notification)
    if (sectionBreakMessageId) {
      threadLiveReasoningState.appendSectionBreak(notificationThreadId)
    }

    const completedReasoningMessageId = readReasoningCompletedId(notification)
    if (completedReasoningMessageId) {
      if (completedReasoningMessageId === liveReasoningMessageId(activeReasoningItemId)) {
        activeReasoningItemId = ''
      }
    }

    const commandStarted = readCommandExecutionStarted(notification)
    if (commandStarted) {
      upsertLiveCommand(notificationThreadId, commandStarted)
      status.setActivity(notificationThreadId, { label: 'Running command', details: [commandStarted.commandExecution?.command ?? ''] })
    }

    const commandDelta = readCommandOutputDelta(notification)
    if (commandDelta) {
      const current = threadLiveCommandState.findMessage(notificationThreadId, commandDelta.itemId)
      if (current?.commandExecution) {
        upsertLiveCommand(notificationThreadId, {
          ...current,
          commandExecution: { ...current.commandExecution, aggregatedOutput: `${current.commandExecution.aggregatedOutput}${commandDelta.delta}` },
        })
      }
    }

    const commandCompleted = readCommandExecutionCompleted(notification)
    if (commandCompleted) {
      upsertLiveCommand(notificationThreadId, commandCompleted)
    }

    const completedFileChange = readCompletedFileChange(notification)
    if (completedFileChange) {
      upsertLiveFileChangeMessage(notificationThreadId, completedFileChange)
    }

    if (isAgentContentEvent(notification)) {
      activeReasoningItemId = ''
      clearLiveReasoningForThread(notificationThreadId)
    }

    if (notification.method === 'turn/completed' || notification.method === 'turn/cancelled') {
      activeReasoningItemId = ''
      clearLiveReasoningForThread(notificationThreadId)
      threadLiveCommandState.clear(notificationThreadId)
      const completedThreadId = extractThreadIdFromNotification(notification)
      if (completedThreadId) {
        clearDelayedTurnSync(completedThreadId)

      }
    }

  }

  function upsertLivePlanMessage(threadId: string, nextMessage: UiMessage): void {
    threadLivePlanState.upsert(threadId, nextMessage)
  }

  function upsertLiveAgentMessage(threadId: string, nextMessage: UiMessage): void {
    threadLiveAgentState.upsert(threadId, nextMessage, turns.getActiveTurnId(threadId))
  }

  function upsertLiveFileChangeMessage(threadId: string, nextMessage: UiMessage): void {
    threadLiveFileChangeState.upsert(threadId, nextMessage)
  }

  function appendLiveReasoningText(threadId: string, delta: string): void {
    threadLiveReasoningState.append(threadId, delta)
  }

  function clearLiveReasoningForThread(threadId: string): void {
    threadLiveReasoningState.clear(threadId)
  }

  function clearLivePlansForThread(threadId: string): void {
    threadLivePlanState.clear(threadId)
  }

  function clearLiveFileChangesForThread(threadId: string): void {
    threadLiveFileChangeState.clear(threadId)
  }

  function upsertLiveCommand(threadId: string, msg: UiMessage): void {
    threadLiveCommandState.upsert(threadId, msg)
  }

  function resetLiveState(): void {
    threadLivePlanState.reset()
    threadLiveAgentState.reset()
    threadLiveReasoningState.reset()
    threadLiveCommandState.reset()
    threadLiveFileChangeState.reset()
  }

  return {
    handle: (notification: RpcNotification) => {
      if (active) applyRealtimeUpdates(notification)
    },
    start: () => { active = true },
    stop: () => {
      active = false
      threadTurnLifecycleState.clear()
      activeReasoningItemId = ''
    },
    resetReasoningItem: () => { activeReasoningItemId = '' },
    resetLiveState,
    pruneLiveState: (threadIds: Set<string>) => {
      threadLivePlanState.prune(threadIds)
      threadLiveAgentState.prune(threadIds)
      threadLiveReasoningState.prune(threadIds)
      threadLiveCommandState.prune(threadIds)
      threadLiveFileChangeState.prune(threadIds)
    },
    plans: {
      getMessages: (threadId: string): readonly Readonly<UiMessage>[] => threadLivePlanState.getMessages(threadId),
      clear: threadLivePlanState.clear,
    },
    agents: {
      getMessages: (threadId: string): readonly Readonly<UiMessage>[] => threadLiveAgentState.getMessages(threadId),
      set: threadLiveAgentState.set,
      upsert: upsertLiveAgentMessage,
      clear: threadLiveAgentState.clear,
    },
    reasoning: { getText: threadLiveReasoningState.getText, clear: threadLiveReasoningState.clear },
    commands: {
      getMessages: (threadId: string): readonly Readonly<UiMessage>[] => threadLiveCommandState.getMessages(threadId),
      removePersistedIn: threadLiveCommandState.removePersistedIn,
      clear: threadLiveCommandState.clear,
    },
    fileChanges: {
      getMessages: (threadId: string): readonly Readonly<UiMessage>[] => threadLiveFileChangeState.getMessages(threadId),
      removePersistedIn: threadLiveFileChangeState.removePersistedIn,
      rebindTurnIndices: threadLiveFileChangeState.rebindTurnIndices,
      clear: threadLiveFileChangeState.clear,
    },
  }
}
