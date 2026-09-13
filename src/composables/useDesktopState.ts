import { isVirtualProjectId, organizeProjectGroups } from '../projectOrganization'
import { removeVirtualProject } from '../api/codexGateway'
import { notifyOperation } from './useOperationToast'
import { mergeQuotaUpdate } from '../quotaRefresh'
import { effectiveConversationChoice, useWebConversationPreferences, type ConversationChoice } from '../webConversationPreferences'
import { historyMessageKey, combineHistoryAndLive, sameMessageIdentity } from '../messageIdentity'
import { mergeSubtaskMessage, observeTaskNotification } from '../subtasks'
import { createDeliveryId } from '../delivery'
import { useConversationDeliveries } from './useConversationDeliveries'
import { changesThreadSearch } from '../threadSearchEvents'
import { bindMessageTurnOrder, mergeTurnOrder, orderedTurnIds } from '../historyOrder'
import { authRecoveryFromNotification, type AuthRecoveryState } from '../authRecovery'
import { buildQuestionReply, isAsyncUserInputRequest, readAsyncQuestions, readQuestionReply, questionRefKey, type AsyncQuestionReply } from '../userQuestions'
import { normalizeToolSummary } from '../api/normalizers/toolSummary'
import { updateCompactionMessages } from '../compaction'
import { observeCompactionNotification, restoreCompactionRequests } from '../api/threadCompaction'
import { capabilityValue, modelSettingsProblem, type ModelCapability } from '../modelCapabilities'
import type { StoredQueuedMessage, ThreadQueueOperation, ThreadQueueResult } from '../threadQueue'
import { computed, ref } from 'vue'
import {

  archiveThread,
  forkThread,
  forkThreadAtTurn,
  getThreadTurnMessages,
  type ThreadHistoryPosition,
  getAvailableCollaborationModes,
  getAccountRateLimits,
  renameThread,
  getAvailableModels,
  invalidateModelCatalog,
  invalidateThreadResumeCache,
  getCurrentModelConfig,
  getPendingServerRequests,
  getSkillsList,
  getThreadDetail,
  getOlderThreadMessages,
  getBackgroundThreadListLimit,
  interruptThreadTurn,
  pickCodexRateLimitSnapshot,
  replyToServerRequest,
  revertThreadFileChanges,
  rollbackThread,
  getThreadGroupsPage,
  getThreadQueueState,
  getDeliveryStatuses,
  getWorkspaceRootsState,
  mutateThreadQueueState,
  setWorkspaceRootsState,
  getThreadTitleCache,
  persistThreadTitle,
  generateThreadTitle,
  resumeThread,

  startThread,
  subscribeCodexNotifications,
  startThreadTurn,
  type RpcNotification,
  type SkillInfo,

  type WorkspaceRootsState,
} from '../api/codexGateway'
import { CodexApiError } from '../api/codexErrors'
import { normalizeThreadMessagesV2, normalizeFileChangeStatus, toUiFileChanges } from '../api/normalizers/v2'
import type {
  CollaborationModeKind,
  CollaborationModeOption,
  CommandExecutionData,
  UiPendingRequestState,
  ReasoningEffort,
  SpeedMode,
  UiFileChange,
  UiLiveOverlay,
  UiMessage,
  UiPlanData,
  UiPlanStep,
  UiProjectGroup,
  UiRateLimitSnapshot,
  UiServerRequest,
  UiServerRequestReply,
  UiThreadTokenUsage,
  UiTokenUsageBreakdown,
  UiThread,
} from '../types/codex'
import { getPathParent, isProjectlessChatPath, normalizePathForUi, toProjectName } from '../pathUtils.js'

function flattenThreads(groups: UiProjectGroup[]): UiThread[] {
  return groups.flatMap((group) => group.threads)
}

export function findAdjacentThreadId(threads: UiThread[], threadId: string): string {
  const targetIndex = threads.findIndex((thread) => thread.id === threadId)
  if (targetIndex < 0) return ''
  return threads[targetIndex + 1]?.id ?? threads[targetIndex - 1]?.id ?? ''
}

const THREAD_TOKEN_USAGE_STORAGE_KEY = 'codex-web-local.thread-token-usage.v1'
const THREAD_TERMINAL_OPEN_STORAGE_KEY = 'codex-web-local.thread-terminal-open.v1'
const SELECTED_THREAD_STORAGE_KEY = 'codex-web-local.selected-thread-id.v1'
const SELECTED_MODEL_BY_CONTEXT_STORAGE_KEY = 'codex-web-local.selected-model-by-context.v1'
const LEGACY_SELECTED_MODEL_STORAGE_KEY = 'codex-web-local.selected-model-id.v1'
const PROJECT_ORDER_STORAGE_KEY = 'codex-web-local.project-order.v1'
const PROJECT_DISPLAY_NAME_STORAGE_KEY = 'codex-web-local.project-display-name.v1'
const COLLABORATION_MODE_STORAGE_KEY = 'codex-web-local.collaboration-mode-by-context.v1'
const LEGACY_COLLABORATION_MODE_STORAGE_KEY = 'codex-web-local.collaboration-mode.v1'
const NEW_THREAD_COLLABORATION_MODE_CONTEXT = '__new-thread__'
const NEW_THREAD_PROVIDER_MODEL_CONTEXT_PREFIX = '__new-thread-provider__::'
const EVENT_SYNC_DEBOUNCE_MS = 220
const BACKGROUND_THREAD_PAGINATION_DELAY_MS = 10_000
const RATE_LIMIT_REFRESH_DEBOUNCE_MS = 500
const TURN_START_FOLLOW_UP_SYNC_DELAY_MS = 3000
const RECENT_THREAD_MESSAGE_LOAD_REUSE_MS = 2000
const RECENT_THREAD_LIST_LOAD_REUSE_MS = 2000
const RECENT_SKILLS_LOAD_REUSE_MS = 2000
const GLOBAL_SERVER_REQUEST_SCOPE = '__global__'
const MODEL_FALLBACK_ID = 'gpt-5.4-mini'
const OPENCODE_ZEN_DEFAULT_MODEL = 'big-pickle'
const CODEX_CLI_MISSING_MESSAGE = 'Codex CLI not found. Install @openai/codex or set CODEXUI_CODEX_COMMAND.'
type SelectThreadResult = 'ok' | 'not-found' | 'error'

function isCodexCliMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return message.includes('Codex CLI is not available')
}

function isThreadNotFoundError(error: unknown): boolean {
  if (error instanceof CodexApiError && error.status === 404) return true
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /\b404\b|thread.*not found|conversation.*not found|no such thread|no rollout found for thread id/i.test(message)
}

function normalizeCollaborationMode(value: unknown): CollaborationModeKind {
  return value === 'plan' ? 'plan' : 'default'
}

function normalizeStoredModelId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function createStringKeyedRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

function cloneStringKeyedRecord<T>(record: Record<string, T>): Record<string, T> {
  const next = createStringKeyedRecord<T>()
  for (const [key, value] of Object.entries(record)) {
    next[key] = value
  }
  return next
}

function omitStringKeyedRecordKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const next = createStringKeyedRecord<T>()
  for (const [entryKey, value] of Object.entries(record)) {
    if (entryKey !== key) {
      next[entryKey] = value
    }
  }
  return next
}

function pruneThreadContextStateMap<T>(
  stateMap: Record<string, T>,
  threadIds: Set<string>,
): Record<string, T> {
  let changed = false
  const next = createStringKeyedRecord<T>()
  for (const [contextId, value] of Object.entries(stateMap)) {
    if (
      contextId === NEW_THREAD_COLLABORATION_MODE_CONTEXT
      || contextId.startsWith(NEW_THREAD_PROVIDER_MODEL_CONTEXT_PREFIX)
      || threadIds.has(contextId)
    ) {
      next[contextId] = value
      continue
    }
    changed = true
  }
  return changed ? next : stateMap
}

function normalizeProviderContextId(providerId: string): string {
  const normalized = providerId.trim().toLowerCase().replace(/_/g, '-')
  if (!normalized || normalized === 'openai') return 'codex'
  return normalized
}

function isNewThreadContextId(contextId: string): boolean {
  return contextId === NEW_THREAD_COLLABORATION_MODE_CONTEXT
}

function toProviderModelContextId(providerId: string): string {
  const normalizedProviderId = normalizeProviderContextId(providerId)
  if (!normalizedProviderId) return ''
  return `${NEW_THREAD_PROVIDER_MODEL_CONTEXT_PREFIX}${normalizedProviderId}`
}

function toThreadContextId(threadId: string): string {
  const normalizedThreadId = threadId.trim()
  return normalizedThreadId || NEW_THREAD_COLLABORATION_MODE_CONTEXT
}

function loadSelectedModelMap(): Record<string, string> {
  if (typeof window === 'undefined') return createStringKeyedRecord<string>()

  try {
    const raw = window.localStorage.getItem(SELECTED_MODEL_BY_CONTEXT_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return createStringKeyedRecord<string>()

      const next = createStringKeyedRecord<string>()
      for (const [contextId, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof contextId !== 'string' || contextId.length === 0) continue
        const normalizedModelId = normalizeStoredModelId(value)
        if (normalizedModelId) {
          next[contextId] = normalizedModelId
        }
      }
      return next
    }
  } catch {
    // Fall back to the legacy global preference below.
  }

  const legacyModelId = normalizeStoredModelId(window.localStorage.getItem(LEGACY_SELECTED_MODEL_STORAGE_KEY))
  const next = createStringKeyedRecord<string>()
  if (legacyModelId) {
    next[NEW_THREAD_COLLABORATION_MODE_CONTEXT] = legacyModelId
  }
  return next
}

function readSelectedModel(
  state: Record<string, string>,
  threadId: string,
): string {
  const contextId = toThreadContextId(threadId)
  const contextModelId = normalizeStoredModelId(state[contextId])
  if (contextModelId) return contextModelId
  return normalizeStoredModelId(state[NEW_THREAD_COLLABORATION_MODE_CONTEXT])
}

function saveSelectedModelMap(state: Record<string, string>): void {
  if (typeof window === 'undefined') return
  try {
    if (Object.keys(state).length === 0) {
      window.localStorage.removeItem(SELECTED_MODEL_BY_CONTEXT_STORAGE_KEY)
    } else {
      window.localStorage.setItem(SELECTED_MODEL_BY_CONTEXT_STORAGE_KEY, JSON.stringify(state))
    }
    window.localStorage.removeItem(LEGACY_SELECTED_MODEL_STORAGE_KEY)
  } catch {
    // Keep in-memory selection working even if localStorage writes fail.
  }
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

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.min(Math.max(value, minValue), maxValue)
}

function normalizeStoredTokenCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value))
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.trunc(parsed))
    }
  }

  return null
}

function normalizeTokenUsageBreakdown(value: unknown): UiThreadTokenUsage['last'] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const record = value as Record<string, unknown>
  return {
    totalTokens: normalizeStoredTokenCount(record.totalTokens) ?? 0,
    inputTokens: normalizeStoredTokenCount(record.inputTokens) ?? 0,
    cachedInputTokens: normalizeStoredTokenCount(record.cachedInputTokens) ?? 0,
    outputTokens: normalizeStoredTokenCount(record.outputTokens) ?? 0,
    reasoningOutputTokens: normalizeStoredTokenCount(record.reasoningOutputTokens) ?? 0,
  }
}

function normalizeThreadTokenUsage(value: unknown): UiThreadTokenUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const record = value as Record<string, unknown>
  const total = normalizeTokenUsageBreakdown(record.total)
  const last = normalizeTokenUsageBreakdown(record.last)
  if (!total || !last) return null

  const modelContextWindow = normalizeStoredTokenCount(record.modelContextWindow)
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

function loadThreadTokenUsageMap(): Record<string, UiThreadTokenUsage> {
  if (typeof window === 'undefined') return {}

  try {
    const raw = window.localStorage.getItem(THREAD_TOKEN_USAGE_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const normalizedMap: Record<string, UiThreadTokenUsage> = {}
    for (const [threadId, usage] of Object.entries(parsed as Record<string, unknown>)) {
      if (!threadId) continue
      const normalizedUsage = normalizeThreadTokenUsage(usage)
      if (normalizedUsage) {
        normalizedMap[threadId] = normalizedUsage
      }
    }
    return normalizedMap
  } catch {
    return {}
  }
}

function saveThreadTokenUsageMap(state: Record<string, UiThreadTokenUsage>): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(THREAD_TOKEN_USAGE_STORAGE_KEY, JSON.stringify(state))
}

function loadThreadTerminalOpenMap(): Record<string, boolean> {
  if (typeof window === 'undefined') return {}

  try {
    const raw = window.localStorage.getItem(THREAD_TERMINAL_OPEN_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const normalizedMap: Record<string, boolean> = {}
    for (const [threadId, isOpen] of Object.entries(parsed as Record<string, unknown>)) {
      if (threadId && typeof isOpen === 'boolean') {
        normalizedMap[threadId] = isOpen
      }
    }
    return normalizedMap
  } catch {
    return {}
  }
}

function saveThreadTerminalOpenMap(state: Record<string, boolean>): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(THREAD_TERMINAL_OPEN_STORAGE_KEY, JSON.stringify(state))
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

function mergeProjectOrder(previousOrder: string[], incomingGroups: UiProjectGroup[]): string[] {
  const nextOrder: string[] = []

  for (const projectName of previousOrder) {
    if (!nextOrder.includes(projectName)) {
      nextOrder.push(projectName)
    }
  }

  for (const group of incomingGroups) {
    if (!nextOrder.includes(group.projectName)) {
      nextOrder.push(group.projectName)
    }
  }

  return areStringArraysEqual(previousOrder, nextOrder) ? previousOrder : nextOrder
}

function orderGroupsByProjectOrder(incoming: UiProjectGroup[], projectOrder: string[]): UiProjectGroup[] {
  const incomingByName = new Map(incoming.map((group) => [group.projectName, group]))
  const ordered: UiProjectGroup[] = projectOrder
    .map((projectName) => incomingByName.get(projectName) ?? null)
    .filter((group): group is UiProjectGroup => group !== null)

  for (const group of incoming) {
    if (!projectOrder.includes(group.projectName)) {
      ordered.push(group)
    }
  }

  return ordered
}

function areStringArraysEqual(first?: string[], second?: string[]): boolean {
  const left = Array.isArray(first) ? first : []
  const right = Array.isArray(second) ? second : []
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function reorderStringArray(items: string[], fromIndex: number, toIndex: number): string[] {
  if (fromIndex < 0 || fromIndex >= items.length || toIndex < 0 || toIndex >= items.length) {
    return items
  }

  if (fromIndex === toIndex) {
    return items
  }

  const next = [...items]
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  return next
}

function areCommandExecutionsEqual(first?: CommandExecutionData, second?: CommandExecutionData): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  return first.status === second.status && first.aggregatedOutput === second.aggregatedOutput && first.exitCode === second.exitCode
}

function arePlanStepsEqual(first: UiPlanStep[] = [], second: UiPlanStep[] = []): boolean {
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index += 1) {
    if (first[index]?.step !== second[index]?.step || first[index]?.status !== second[index]?.status) {
      return false
    }
  }
  return true
}

function arePlanDataEqual(first?: UiPlanData, second?: UiPlanData): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  return (
    first.explanation === second.explanation &&
    first.isStreaming === second.isStreaming &&
    arePlanStepsEqual(first.steps, second.steps)
  )
}

function isUnsupportedChatGptModelError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return (
    message.includes('not supported when using codex with a chatgpt account') ||
    message.includes('model is not supported') ||
    message.includes('requires a newer version of codex')
  )
}

function areMessageFieldsEqual(first: UiMessage, second: UiMessage): boolean {
  if (first.historyOrdinal !== second.historyOrdinal || first.clientUserMessageId !== second.clientUserMessageId) return false
  return (
    first.id === second.id &&
    first.role === second.role &&
    first.text === second.text &&
    first.delivery === second.delivery &&
    first.questionOrdinal === second.questionOrdinal &&
    JSON.stringify(first.questions) === JSON.stringify(second.questions) &&
    first.questionReply?.itemId === second.questionReply?.itemId &&
    first.questionReply?.turnId === second.questionReply?.turnId &&
    first.questionReply?.questionOrdinal === second.questionReply?.questionOrdinal &&
    areStringArraysEqual(first.images, second.images) &&
    areUiFileChangesEqual(first.fileChanges, second.fileChanges) &&
    first.fileChangeStatus === second.fileChangeStatus &&
    first.messageType === second.messageType &&
    first.rawPayload === second.rawPayload &&
    first.isUnhandled === second.isUnhandled &&
    JSON.stringify(first.compaction) === JSON.stringify(second.compaction) &&
    JSON.stringify(first.subtask) === JSON.stringify(second.subtask) &&
    areCommandExecutionsEqual(first.commandExecution, second.commandExecution) &&
    arePlanDataEqual(first.plan, second.plan) &&
    first.turnId === second.turnId &&
    first.turnIndex === second.turnIndex &&
    first.isAutomationRun === second.isAutomationRun &&
    first.automationDisplayName === second.automationDisplayName
  )
}

function areMessageArraysEqual(first: UiMessage[], second: UiMessage[]): boolean {
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) return false
  }
  return true
}

function mergeMessages(
  previous: UiMessage[],
  incoming: UiMessage[],
  options: { preserveMissing?: boolean } = {},
): UiMessage[] {
  const previousById = new Map(previous.map(message => [JSON.stringify([message.turnId || '', message.id]), message]))
  const previousByOrdinal = new Map(previous.filter(message => message.historyOrdinal !== undefined).map(message => [historyMessageKey(message), message]))
  const optimistic = previous.filter(isOptimisticUserMessage)
  const consumed = new Set<UiMessage>()
  const replacements = new Map<UiMessage, UiMessage>()
  const appended: UiMessage[] = []
  const mergedIncoming = incoming.map(message => {
    let before = previousById.get(JSON.stringify([message.turnId || '', message.id]))
      || (message.historyOrdinal !== undefined ? previousByOrdinal.get(historyMessageKey(message)) : undefined)
    if (!before && message.role === 'user') {
      before = optimistic.find(row => !consumed.has(row) && hasEquivalentUserMessage(row, [message]))
    }
    const next = before && areMessageFieldsEqual(before, message) ? before : mergeSubtaskMessage(before, message)
    if (before) {
      consumed.add(before)
      replacements.set(before, next)
    } else appended.push(next)
    return next
  })
  if (options.preserveMissing !== true) return areMessageArraysEqual(previous, mergedIncoming) ? previous : mergedIncoming
  const incomingQuestionKeys = new Set(incoming.flatMap(message => message.questions?.length && message.turnId && message.questionOrdinal !== undefined
    ? [questionRefKey({ itemId: message.id, turnId: message.turnId, questionOrdinal: message.questionOrdinal })] : []))
  const retained = previous.filter(message => consumed.has(message) || !(message.questions?.length && message.turnId && message.questionOrdinal !== undefined
    && incomingQuestionKeys.has(questionRefKey({ itemId: message.id, turnId: message.turnId, questionOrdinal: message.questionOrdinal }))))
  const merged = [...retained.map(message => replacements.get(message) || message), ...appended]

  return areMessageArraysEqual(previous, merged) ? previous : merged
}

function areUiFileChangesEqual(first?: UiFileChange[], second?: UiFileChange[]): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index += 1) {
    const firstChange = first[index]
    const secondChange = second[index]
    if (
      firstChange.path !== secondChange.path ||
      firstChange.operation !== secondChange.operation ||
      firstChange.movedToPath !== secondChange.movedToPath ||
      firstChange.diff !== secondChange.diff ||
      firstChange.addedLineCount !== secondChange.addedLineCount ||
      firstChange.removedLineCount !== secondChange.removedLineCount
    ) {
      return false
    }
  }
  return true
}

function normalizeMessageText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

function isOptimisticUserMessage(message: UiMessage): boolean {
  return message.messageType === 'userMessage.optimistic'
}

function hasOptimisticUserMessages(messages: UiMessage[]): boolean {
  return messages.some(isOptimisticUserMessage)
}

function comparableImageSource(value: string): string {
  try {
    const url = new URL(value, 'http://localhost')
    if (url.pathname === '/codex-local-image') return url.searchParams.get('path') || value
  } catch {}
  return value
}

// Local images also become file chips in the native echo; they are not extra attachments.
function nonImageAttachmentPaths(message: UiMessage): string[] {
  const imagePaths = new Set((message.images ?? []).map(comparableImageSource))
  return (message.fileAttachments ?? []).map(file => file.path).filter(path => !imagePaths.has(path))
}

function hasEquivalentUserMessage(target: UiMessage, messages: UiMessage[]): boolean {
  if (target.role !== 'user') return false
  const targetText = normalizeMessageText(target.text)
  const targetImages = (target.images ?? []).map(comparableImageSource)
  const targetFiles = nonImageAttachmentPaths(target)
  const targetSkillCount = Array.isArray(target.skills) ? target.skills.length : 0

  return messages.some((message) => {
    if (message === target || message.role !== 'user' || isOptimisticUserMessage(message)) return false
    if (!target.turnId || message.turnId !== target.turnId) return false
    if (target.clientUserMessageId && message.clientUserMessageId) return target.clientUserMessageId === message.clientUserMessageId
    if (target.userMessageOrdinal !== undefined && message.userMessageOrdinal !== undefined && target.userMessageOrdinal !== message.userMessageOrdinal) return false
    const messageText = normalizeMessageText(message.text)
    const messageImages = (message.images ?? []).map(comparableImageSource)
    const messageFiles = nonImageAttachmentPaths(message)
    const messageSkillCount = Array.isArray(message.skills) ? message.skills.length : 0
    return (
      messageText === targetText &&
      areStringArraysEqual(messageImages, targetImages) &&
      areStringArraysEqual(messageFiles, targetFiles) &&
      messageSkillCount === targetSkillCount
    )
  })
}

function removeRedundantLiveAgentMessages(previous: UiMessage[], incoming: UiMessage[]): UiMessage[] {
  const incomingMessageIds = new Set(incoming.map((message) => message.id))

  if (incomingMessageIds.size === 0) return previous

  const next = previous.filter((message) => {
    if (message.messageType !== 'agentMessage.live') return true
    if (incoming.some(row => sameMessageIdentity(row, message))) return false
    if (message.questions?.length) return true
    const normalized = normalizeMessageText(message.text)
    if (normalized.length === 0) return false
    return true
  })

  return next.length === previous.length ? previous : next
}

function removePersistedLiveMessages(previous: UiMessage[], incoming: UiMessage[]): UiMessage[] {
  const incomingIds = new Set(incoming.map((message) => message.id))
  const next = previous.filter((message) => !incomingIds.has(message.id))
  return next.length === previous.length ? previous : next
}

function upsertMessage(previous: UiMessage[], nextMessage: UiMessage): UiMessage[] {
  const existingIndex = previous.findIndex((message) => message.id === nextMessage.id)
  if (existingIndex < 0) {
    return [...previous, nextMessage]
  }

  const existing = previous[existingIndex]
  if (areMessageFieldsEqual(existing, nextMessage)) {
    return previous
  }

  const next = [...previous]
  next.splice(existingIndex, 1, nextMessage)
  return next
}

type TurnSummaryState = {
  turnId: string
  durationMs: number
}

type TurnActivityState = {
  label: string
  details: string[]
}

type TurnErrorState = {
  message: string
  transient: boolean
}

type TurnStartedInfo = {
  threadId: string
  turnId: string
  startedAtMs: number
}

type TurnCompletedInfo = {
  threadId: string
  turnId: string
  completedAtMs: number
  startedAtMs?: number
}

const WORKED_MESSAGE_TYPE = 'worked'

function parseIsoTimestamp(value: string): number | null {
  if (!value) return null
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? null : ms
}

function formatTurnDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return '<1s'
  }

  const totalSeconds = Math.max(1, Math.round(durationMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts: string[] = []

  if (hours > 0) {
    parts.push(`${hours}h`)
  }

  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}m`)
  }

  const displaySeconds = seconds > 0 || parts.length === 0 ? seconds : 0
  parts.push(`${displaySeconds}s`)
  return parts.join(' ')
}

function areTurnSummariesEqual(first?: TurnSummaryState, second?: TurnSummaryState): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  return first.turnId === second.turnId && first.durationMs === second.durationMs
}

function areTurnActivitiesEqual(first?: TurnActivityState, second?: TurnActivityState): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  if (first.label !== second.label) return false
  if (first.details.length !== second.details.length) return false
  for (let index = 0; index < first.details.length; index += 1) {
    if (first.details[index] !== second.details[index]) return false
  }
  return true
}

function buildTurnSummaryMessage(summary: TurnSummaryState): UiMessage {
  return {
    id: `turn-summary:${summary.turnId}`,
    role: 'system',
    text: `Worked for ${formatTurnDuration(summary.durationMs)}`,
    messageType: WORKED_MESSAGE_TYPE,
    turnId: summary.turnId,
  }
}

function findLastAssistantMessageIndex(messages: UiMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'assistant') {
      return index
    }
  }
  return -1
}

function insertTurnSummaryMessage(messages: UiMessage[], summary: TurnSummaryState): UiMessage[] {
  const summaryMessage = buildTurnSummaryMessage(summary)
  const sanitizedMessages = messages.filter((message) => message.messageType !== WORKED_MESSAGE_TYPE)
  const insertIndex = findLastAssistantMessageIndex(sanitizedMessages)
  if (insertIndex < 0) {
    return [...sanitizedMessages, summaryMessage]
  }
  const next = [...sanitizedMessages]
  next.splice(insertIndex, 0, summaryMessage)
  return next
}

function omitKey<TValue>(record: Record<string, TValue>, key: string): Record<string, TValue> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
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

function areThreadFieldsEqual(first: UiThread, second: UiThread): boolean {
  return (
    first.id === second.id &&
    first.title === second.title &&
    first.projectName === second.projectName &&
    first.cwd === second.cwd &&
    first.createdAtIso === second.createdAtIso &&
    first.updatedAtIso === second.updatedAtIso &&
    first.preview === second.preview &&
    first.unread === second.unread &&
    first.inProgress === second.inProgress &&
    first.pendingRequestState === second.pendingRequestState &&
    JSON.stringify(first.task) === JSON.stringify(second.task)
  )
}

function areThreadArraysEqual(first: UiThread[], second: UiThread[]): boolean {
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) return false
  }
  return true
}

function areGroupArraysEqual(first: UiProjectGroup[], second: UiProjectGroup[]): boolean {
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) return false
  }
  return true
}

function pruneThreadStateMap<T>(stateMap: Record<string, T>, threadIds: Set<string>): Record<string, T> {
  const nextEntries = Object.entries(stateMap).filter(([threadId]) => threadIds.has(threadId))
  if (nextEntries.length === Object.keys(stateMap).length) {
    return stateMap
  }
  return Object.fromEntries(nextEntries) as Record<string, T>
}

export function removeThreadFromGroups(groups: UiProjectGroup[], threadId: string): UiProjectGroup[] {
  const normalizedThreadId = threadId.trim()
  if (!normalizedThreadId) return groups

  let changed = false
  const nextGroups: UiProjectGroup[] = []

  for (const group of groups) {
    const nextThreads = group.threads.filter((thread) => thread.id !== normalizedThreadId)
    const removedFromGroup = nextThreads.length !== group.threads.length
    if (removedFromGroup) {
      changed = true
    }
    if (nextThreads.length > 0) {
      nextGroups.push(removedFromGroup ? { ...group, threads: nextThreads } : group)
    } else if (group.threads.length === 0) {
      nextGroups.push(group)
    }
  }

  return changed ? nextGroups : groups
}

function mergeThreadGroups(
  previous: UiProjectGroup[],
  incoming: UiProjectGroup[],
): UiProjectGroup[] {
  const previousGroupsByName = new Map(previous.map((group) => [group.projectName, group]))
  const mergedGroups: UiProjectGroup[] = incoming.map((incomingGroup) => {
    const previousGroup = previousGroupsByName.get(incomingGroup.projectName)
    const previousThreadsById = new Map(previousGroup?.threads.map((thread) => [thread.id, thread]) ?? [])

    const mergedThreads = incomingGroup.threads.map((incomingThread) => {
      const previousThread = previousThreadsById.get(incomingThread.id)
      if (previousThread && areThreadFieldsEqual(previousThread, incomingThread)) {
        return previousThread
      }
      return incomingThread
    })

    if (
      previousGroup &&
      previousGroup.projectName === incomingGroup.projectName &&
      areThreadArraysEqual(previousGroup.threads, mergedThreads)
    ) {
      return previousGroup
    }

    return {
      projectName: incomingGroup.projectName,
      threads: mergedThreads,
    }
  })

  return areGroupArraysEqual(previous, mergedGroups) ? previous : mergedGroups
}

function mergeIncomingWithLocalInProgressThreads(
  previous: UiProjectGroup[],
  incoming: UiProjectGroup[],
  inProgressById: Record<string, boolean>,
  pendingThreadIds: ReadonlySet<string> = new Set(),
): UiProjectGroup[] {
  const incomingThreadIds = new Set(flattenThreads(incoming).map((thread) => thread.id))
  const localInProgressThreads = flattenThreads(previous).filter(
    (thread) => (inProgressById[thread.id] === true || pendingThreadIds.has(thread.id)) && !incomingThreadIds.has(thread.id),
  )

  if (localInProgressThreads.length === 0) {
    return incoming
  }

  const incomingByProjectName = new Map(incoming.map((group) => [group.projectName, group]))
  const merged: UiProjectGroup[] = incoming.map((group) => ({
    projectName: group.projectName,
    threads: [...group.threads],
  }))

  for (const thread of localInProgressThreads) {
    const existingGroup = incomingByProjectName.get(thread.projectName)
    if (existingGroup) {
      const mergedGroupIndex = merged.findIndex((group) => group.projectName === thread.projectName)
      if (mergedGroupIndex >= 0) {
        merged[mergedGroupIndex] = {
          projectName: merged[mergedGroupIndex].projectName,
          threads: [thread, ...merged[mergedGroupIndex].threads],
        }
      }
      continue
    }

    merged.push({
      projectName: thread.projectName,
      threads: [thread],
    })
  }

  return merged
}

function toProjectNameFromWorkspaceRoot(value: string): string {
  return toProjectName(value)
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

function getRemoteProjectById(rootsState: WorkspaceRootsState | null): Map<string, NonNullable<WorkspaceRootsState['remoteProjects']>[number]> {
  const remoteProjects = rootsState?.remoteProjects ?? []
  return new Map(remoteProjects.map((project) => [project.id, project]))
}

function getWorkspaceProjectOrderPaths(rootsState: WorkspaceRootsState | null): string[] {
  if (!rootsState) return []
  const savedRoots = new Set([...rootsState.order, ...(rootsState.virtualProjects ?? []).map(project => project.id)])
  const remoteProjectIds = new Set((rootsState.remoteProjects ?? []).map((project) => project.id))
  const orderedRoots = rootsState.projectOrder.filter((item) => savedRoots.has(item) || remoteProjectIds.has(item))
  for (const rootPath of rootsState.order) {
    if (!orderedRoots.includes(rootPath)) orderedRoots.push(rootPath)
  }
  for (const project of rootsState.virtualProjects ?? []) {
    if (!orderedRoots.includes(project.id)) orderedRoots.push(project.id)
  }
  for (const remoteProjectId of remoteProjectIds) {
    if (!orderedRoots.includes(remoteProjectId)) orderedRoots.push(remoteProjectId)
  }
  return orderedRoots
}

function getWorkspaceProjectOrderNames(
  rootsState: WorkspaceRootsState | null,
  duplicateLeafNames: Set<string>,
): string[] {
  const remoteProjectsById = getRemoteProjectById(rootsState)
  return getWorkspaceProjectOrderPaths(rootsState).map((rootPath) => {
    if (remoteProjectsById.has(rootPath) || isVirtualProjectId(rootPath)) return rootPath
    const normalizedRootPath = normalizePathForUi(rootPath).trim()
    const leafName = toProjectNameFromWorkspaceRoot(normalizedRootPath)
    return duplicateLeafNames.has(leafName) ? normalizedRootPath : leafName
  })
}

function matchesWorkspaceRootProject(rootPath: string, projectName: string): boolean {
  const normalizedRootPath = normalizePathForUi(rootPath).trim()
  return normalizedRootPath === projectName || toProjectNameFromWorkspaceRoot(rootPath) === projectName
}

export function collectWorkspaceRootPathsForProjectRemoval(
  rootsState: WorkspaceRootsState,
  projectName: string,
): Set<string> {
  const removedRootPaths = new Set<string>()
  for (const rootPath of rootsState.order) {
    if (matchesWorkspaceRootProject(rootPath, projectName)) {
      removedRootPaths.add(rootPath)
    }
  }
  for (const rootPath of rootsState.active) {
    if (matchesWorkspaceRootProject(rootPath, projectName)) {
      removedRootPaths.add(rootPath)
    }
  }
  for (const rootPath of Object.keys(rootsState.labels)) {
    if (matchesWorkspaceRootProject(rootPath, projectName)) {
      removedRootPaths.add(rootPath)
    }
  }
  return removedRootPaths
}

export function buildWorkspaceRootsProjectOrderState(
  rootsState: WorkspaceRootsState,
  orderedProjectNames: string[],
  groups: UiProjectGroup[],
): Pick<WorkspaceRootsState, 'order' | 'active' | 'projectOrder'> {
  const remoteProjectIds = new Set((rootsState.remoteProjects ?? []).map((project) => project.id))
  const rootByProjectName = new Map<string, string>()
  for (const rootPath of rootsState.order) {
    const projectName = toProjectNameFromWorkspaceRoot(rootPath)
    if (!rootByProjectName.has(projectName)) {
      rootByProjectName.set(projectName, rootPath)
    }
  }
  for (const group of groups) {
    const cwd = group.threads[0]?.cwd?.trim() ?? ''
    if (!cwd) continue
    rootByProjectName.set(group.projectName, cwd)
  }

  const nextProjectOrder: string[] = []
  const pushProjectOrderItem = (item: string): void => {
    if (item && !nextProjectOrder.includes(item)) {
      nextProjectOrder.push(item)
    }
  }

  for (const projectName of orderedProjectNames) {
    if (remoteProjectIds.has(projectName) || isVirtualProjectId(projectName)) {
      pushProjectOrderItem(projectName)
      continue
    }
    const rootPath = rootByProjectName.get(projectName)
    if (rootPath) {
      pushProjectOrderItem(rootPath)
    }
  }
  for (const item of getWorkspaceProjectOrderPaths(rootsState)) {
    pushProjectOrderItem(item)
  }

  const nextOrder = nextProjectOrder.filter((item) => rootsState.order.includes(item))
  for (const rootPath of rootsState.order) {
    if (!nextOrder.includes(rootPath)) {
      nextOrder.push(rootPath)
    }
  }

  const nextActive = rootsState.active.filter((rootPath) => nextOrder.includes(rootPath))
  if (nextActive.length === 0 && nextOrder.length > 0) {
    nextActive.push(nextOrder[0])
  }

  return {
    order: nextOrder,
    active: nextActive,
    projectOrder: nextProjectOrder,
  }
}

function orderGroupsByWorkspaceProjectOrder(
  groups: UiProjectGroup[],
  rootsState: WorkspaceRootsState | null,
  duplicateLeafNames: Set<string>,
): UiProjectGroup[] {
  const order = getWorkspaceProjectOrderNames(rootsState, duplicateLeafNames)
  if (order.length === 0) return groups
  const orderIndexByName = new Map(order.map((name, index) => [name, index]))
  return [...groups].sort((first, second) => {
    if (isProjectlessGroup(first) || isProjectlessGroup(second)) return 0
    const firstIndex = orderIndexByName.get(first.projectName) ?? Number.POSITIVE_INFINITY
    const secondIndex = orderIndexByName.get(second.projectName) ?? Number.POSITIVE_INFINITY
    if (firstIndex === secondIndex) return 0
    return firstIndex - secondIndex
  })
}

function collectDuplicateProjectLeafNames(groups: UiProjectGroup[], rootsState: WorkspaceRootsState | null): Set<string> {
  const rootByLeafName = new Map<string, Set<string>>()
  const canonicalWorkspaceRootCountsByLeafName = new Map<string, number>()
  const addPath = (value: string): void => {
    const normalizedPath = normalizePathForUi(value).trim()
    if (!normalizedPath) return
    const leafName = toProjectName(normalizedPath)
    const existing = rootByLeafName.get(leafName) ?? new Set<string>()
    existing.add(normalizedPath)
    rootByLeafName.set(leafName, existing)
  }

  for (const rootPath of rootsState?.order ?? []) {
    const normalizedRootPath = normalizePathForUi(rootPath).trim()
    if (!normalizedRootPath) continue
    const leafName = toProjectName(normalizedRootPath)
    if (!isManagedCodexWorktreePath(normalizedRootPath)) {
      canonicalWorkspaceRootCountsByLeafName.set(leafName, (canonicalWorkspaceRootCountsByLeafName.get(leafName) ?? 0) + 1)
    }
    addPath(rootPath)
  }
  for (const group of groups) {
    for (const thread of group.threads) {
      const normalizedCwd = normalizePathForUi(thread.cwd).trim()
      const leafName = toProjectName(normalizedCwd)
      const isRegisteredRoot = rootsState?.order.some((rootPath) => normalizePathForUi(rootPath).trim() === normalizedCwd) === true
      if (isManagedCodexWorktreePath(normalizedCwd) && !isRegisteredRoot && canonicalWorkspaceRootCountsByLeafName.get(leafName) === 1) continue
      addPath(thread.cwd)
    }
  }

  const duplicateLeafNames = new Set<string>()
  for (const [leafName, paths] of rootByLeafName.entries()) {
    if (paths.size > 1) duplicateLeafNames.add(leafName)
  }
  return duplicateLeafNames
}

function isManagedCodexWorktreePath(value: string): boolean {
  return value.includes('/.codex/worktrees/')
}

function disambiguateProjectGroupsByCwd(
  groups: UiProjectGroup[],
  rootsState: WorkspaceRootsState | null,
): UiProjectGroup[] {
  const duplicateLeafNames = collectDuplicateProjectLeafNames(groups, rootsState)
  if (duplicateLeafNames.size === 0) return groups

  const uniqueCanonicalWorkspaceRootLeafNames = new Set<string>()
  const duplicateCanonicalWorkspaceRootLeafNames = new Set<string>()
  const canonicalWorkspaceRootByLeafName = new Map<string, string>()
  const registeredWorkspaceRoots = new Set<string>()
  for (const rootPath of rootsState?.order ?? []) {
    const normalizedRootPath = normalizePathForUi(rootPath).trim()
    if (!normalizedRootPath) continue
    registeredWorkspaceRoots.add(normalizedRootPath)
    if (isManagedCodexWorktreePath(normalizedRootPath)) continue
    const leafName = toProjectName(normalizedRootPath)
    if (uniqueCanonicalWorkspaceRootLeafNames.has(leafName)) {
      uniqueCanonicalWorkspaceRootLeafNames.delete(leafName)
      duplicateCanonicalWorkspaceRootLeafNames.add(leafName)
      canonicalWorkspaceRootByLeafName.delete(leafName)
    } else if (!duplicateCanonicalWorkspaceRootLeafNames.has(leafName)) {
      uniqueCanonicalWorkspaceRootLeafNames.add(leafName)
      canonicalWorkspaceRootByLeafName.set(leafName, normalizedRootPath)
    }
  }

  const disambiguatedGroups: UiProjectGroup[] = []
  const groupsByProjectName = new Map<string, UiProjectGroup>()
  for (const group of groups) {
    for (const thread of group.threads) {
      const normalizedCwd = normalizePathForUi(thread.cwd).trim()
      const leafName = toProjectName(normalizedCwd)
      const isRegisteredRoot = registeredWorkspaceRoots.has(normalizedCwd)
      const isCanonicalWorktreeThread = isManagedCodexWorktreePath(normalizedCwd)
        && !isRegisteredRoot
        && uniqueCanonicalWorkspaceRootLeafNames.has(leafName)
      let projectName = group.projectName
      if (isCanonicalWorktreeThread && duplicateLeafNames.has(leafName)) {
        projectName = canonicalWorkspaceRootByLeafName.get(leafName) ?? group.projectName
      } else if (normalizedCwd && duplicateLeafNames.has(leafName)) {
        projectName = normalizedCwd
      }
      const nextThread = thread.projectName === projectName ? thread : { ...thread, projectName }
      const existingGroup = groupsByProjectName.get(projectName)
      if (existingGroup) {
        existingGroup.threads.push(nextThread)
      } else {
        const nextGroup = { projectName, threads: [nextThread] }
        groupsByProjectName.set(projectName, nextGroup)
        disambiguatedGroups.push(nextGroup)
      }
    }
  }

  return disambiguatedGroups
}

function addWorkspaceRootPlaceholderGroups(
  groups: UiProjectGroup[],
  rootsState: WorkspaceRootsState | null,
  duplicateLeafNames: Set<string>,
): UiProjectGroup[] {
  if (!rootsState || (rootsState.order.length === 0 && (rootsState.remoteProjects ?? []).length === 0)) return groups
  const existingProjectNames = new Set(groups.map((group) => group.projectName))
  const nextGroups = [...groups]
  const remoteProjectsById = getRemoteProjectById(rootsState)

  for (const rootPath of getWorkspaceProjectOrderPaths(rootsState)) {
    if (isVirtualProjectId(rootPath)) continue
    if (remoteProjectsById.has(rootPath)) {
      if (existingProjectNames.has(rootPath)) continue
      nextGroups.push({ projectName: rootPath, threads: [] })
      existingProjectNames.add(rootPath)
      continue
    }
    const normalizedRootPath = normalizePathForUi(rootPath).trim()
    if (!normalizedRootPath) continue
    const leafName = toProjectNameFromWorkspaceRoot(normalizedRootPath)
    const projectName = duplicateLeafNames.has(leafName) ? normalizedRootPath : leafName
    if (existingProjectNames.has(projectName)) continue
    nextGroups.push({ projectName, threads: [] })
    existingProjectNames.add(projectName)
  }

  return nextGroups
}

function toOptimisticThreadTitle(message: string): string {
  const firstLine = message
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)

  if (!firstLine) return 'Untitled thread'
  return firstLine.slice(0, 80)
}

function toForkedThreadTitle(title: string): string {
  const normalizedTitle = title.trim() || 'Untitled thread'
  return /^fork:\s+/iu.test(normalizedTitle) ? normalizedTitle : `Fork: ${normalizedTitle}`
}

function isProjectlessGroup(group: UiProjectGroup): boolean {
  return !isVirtualProjectId(group.projectName) && group.threads.some((thread) => thread.cwd.trim().length === 0 || isProjectlessChatPath(thread.cwd))
}

export function filterGroupsByWorkspaceRoots(
  groups: UiProjectGroup[],
  rootsState: WorkspaceRootsState | null,
): UiProjectGroup[] {
  const duplicateLeafNames = collectDuplicateProjectLeafNames(groups, rootsState)
  const disambiguatedGroups = disambiguateProjectGroupsByCwd(groups, rootsState)
  const groupsWithWorkspaceRoots = organizeProjectGroups(addWorkspaceRootPlaceholderGroups(disambiguatedGroups, rootsState, duplicateLeafNames), rootsState?.virtualProjects ?? [])
  if (!rootsState || (rootsState.order.length === 0 && (rootsState.remoteProjects ?? []).length === 0)) return groupsWithWorkspaceRoots
  const allowedProjectNames = new Set<string>()
  for (const projectName of getWorkspaceProjectOrderNames(rootsState, duplicateLeafNames)) {
    allowedProjectNames.add(projectName)
  }
  const filteredGroups = groupsWithWorkspaceRoots.filter((group) => allowedProjectNames.has(group.projectName) || isProjectlessGroup(group))
  return orderGroupsByWorkspaceProjectOrder(filteredGroups, rootsState, duplicateLeafNames)
}

export function useDesktopState(options: { isThreadVisible?: (threadId: string) => boolean } = {}) {
  const conversationDeliveries = useConversationDeliveries()
  const webPreferences = useWebConversationPreferences(typeof window !== 'undefined' ? window.localStorage : undefined)
  const webPreferenceState = webPreferences.state
  const webPreferenceError = webPreferences.error
  const webDefaultChoice = computed<ConversationChoice>(() => webPreferences.state.value.defaults || {
    model: configuredModelSettings.value.model || readSelectedModel(selectedModelIdByContext.value, ''),
    provider: configuredModelSettings.value.provider || activeProviderId.value,
    effort: configuredModelSettings.value.effort, tier: configuredModelSettings.value.tier,
  })
  function initializeWebConversation(threadId: string): void {
    if (!threadId && !webPreferences.state.value.defaults) return
    const value = webPreferences.enter(threadId, webDefaultChoice.value)
    if (value?.model) selectedModelId.value = effectiveConversationChoice(value, availableModels.value).model
  }
  function configureWebDefaults(value: ConversationChoice, remember: boolean): void {
    try {
      webPreferences.configure(value, remember)
    } catch { /* The settings page exposes the storage error. */ }
  }
  const projectGroups = ref<UiProjectGroup[]>([])
  const sourceGroups = ref<UiProjectGroup[]>([])
  const selectedThreadId = ref(loadSelectedThreadId())
  const snapshotThreads = ref<Record<string, UiThread>>({})
  const persistedMessagesByThreadId = ref<Record<string, UiMessage[]>>({})
  const livePlanMessagesByThreadId = ref<Record<string, UiMessage[]>>({})
  const liveAgentMessagesByThreadId = ref<Record<string, UiMessage[]>>({})
  const liveReasoningTextByThreadId = ref<Record<string, string>>({})
  const liveCommandsByThreadId = ref<Record<string, UiMessage[]>>({})
  const liveFileChangeMessagesByThreadId = ref<Record<string, UiMessage[]>>({})
  const inProgressById = ref<Record<string, boolean>>({})
  const threadStatusRevision = new Map<string, number>()
  const finishedTurns = new Set<string>()
  function turnKey(threadId: string, turnId: string): string { return JSON.stringify([threadId, turnId]) }
  function rememberFinishedTurn(threadId: string, turnId: string): void {
    finishedTurns.add(turnKey(threadId, turnId))
    if (finishedTurns.size > 2000) finishedTurns.delete(finishedTurns.values().next().value!)
  }
  function applyListedStatuses(groups: UiProjectGroup[], revisions: Map<string, number>): void {
    for (const thread of flattenThreads(groups)) {
      if ((revisions.get(thread.id) ?? 0) !== (threadStatusRevision.get(thread.id) ?? 0)) continue
      setThreadInProgress(thread.id, thread.inProgress)
    }
  }
  type FileAttachment = { label: string; path: string; fsPath: string }
  type QueuedMessage = StoredQueuedMessage
  const queuedMessagesByThreadId = ref<Record<string, QueuedMessage[]>>({})
  const queueErrorByThreadId = ref<Record<string, string>>({})
  const queueStateError = ref('')
  const queueProcessingByThreadId = ref<Record<string, boolean>>({})
  let hasLoadedPersistedQueueState = false
  const eventUnreadByThreadId = ref<Record<string, string>>({})
  let completionChangesDuringLoad: Record<string, string | null> | null = null
  let completionLoad: Promise<void> | null = null
  function loadCompletionList(): Promise<void> {
    if (completionLoad) return completionLoad
    completionChangesDuringLoad = Object.create(null)
    completionLoad = fetch('/codex-api/thread-completions').then(async response => {
      if (!response.ok) throw new Error('Failed to load completion list')
      const { data } = await response.json()
      const entries: Record<string, string> = Object.create(null)
      for (const [id, token] of Object.entries(data ?? {})) {
        if (typeof token === 'string') entries[id] = token
      }
      for (const [id, token] of Object.entries(completionChangesDuringLoad ?? {})) {
        if (token) entries[id] = token
        else delete entries[id]
      }
      eventUnreadByThreadId.value = entries
      applyThreadFlags()
    }).catch(() => {}).finally(() => {
      completionChangesDuringLoad = null
      completionLoad = null
    })
    return completionLoad
  }
  const availableModelIds = ref<string[]>([])
  const availableModels = ref<ModelCapability[]>([])
  const modelCatalogError = ref('')
  const reportedModelByThreadId = ref<Record<string, string>>({})
  const reportedModel = computed(() => reportedModelByThreadId.value[selectedThreadId.value] || '')
  let modelRefreshGeneration = 0
  let modelRetryTimer: ReturnType<typeof setTimeout> | null = null
  let rateLimitUpdateRevision = 0
  let recentRateLimitsAt = 0
  const availableCollaborationModes = ref<CollaborationModeOption[]>([
    { value: 'default', label: 'Default' },
    { value: 'plan', label: 'Plan' },
  ])
  const selectedCollaborationModeByContext = ref<Record<string, CollaborationModeKind>>(
    loadSelectedCollaborationModeMap(),
  )
  const selectedModelIdByContext = ref<Record<string, string>>(loadSelectedModelMap())
  const selectedCollaborationMode = ref<CollaborationModeKind>(
    readSelectedCollaborationMode(selectedCollaborationModeByContext.value, selectedThreadId.value),
  )
  const selectedModelId = ref(readSelectedModel(selectedModelIdByContext.value, selectedThreadId.value))
  const modelSettingsStorageKey = 'codexapp.model-settings.v1'
  const savedModelSettings = ref<Record<string, { effort: string; tier: string }>>((() => {
    try {
      const value = JSON.parse(window.localStorage.getItem(modelSettingsStorageKey) || '{}')
      return Object.fromEntries(Object.entries(value).flatMap(([key, row]) => row && typeof row === 'object'
        ? [[key, { effort: capabilityValue((row as Record<string, unknown>).effort), tier: capabilityValue((row as Record<string, unknown>).tier) }]] : []))
    } catch { return {} }
  })())
  const configuredModelSettings = ref({ model: '', provider: '', effort: '', tier: '' })
  const modelSettingsKey = computed(() => JSON.stringify([readProviderIdForThread(selectedThreadId.value), selectedModelId.value]))
  const selectedModelCapability = computed(() => availableModels.value.find(model => model.id === selectedModelId.value))
  const currentModelSettings = computed(() => {
    const session = webPreferences.sessions.value[selectedThreadId.value]
    const stored = session ? effectiveConversationChoice(session, availableModels.value) : savedModelSettings.value[modelSettingsKey.value]
    const defaults = configuredModelSettings.value
    const matches = defaults.model === selectedModelId.value && defaults.provider === readProviderIdForThread(selectedThreadId.value)
    const settings = stored || (matches ? defaults : { effort: '', tier: '' })
    const tier = settings.tier === 'fast' && selectedModelCapability.value?.serviceTiers?.some(item => item.value === 'priority') ? 'priority' : settings.tier
    return { effort: settings.effort, tier }
  })
  function saveCurrentModelSettings(patch: Partial<{ effort: string; tier: string }>): void {
    const session = webPreferences.sessions.value[selectedThreadId.value]
    if (session) {
      webPreferences.select(selectedThreadId.value, { ...session, ...patch })
      return
    }
    savedModelSettings.value = { ...savedModelSettings.value, [modelSettingsKey.value]: { ...currentModelSettings.value, ...patch } }
    // Bound preferences without pruning the selected entry.
    const entries = Object.entries(savedModelSettings.value)
    if (entries.length > 200) savedModelSettings.value = Object.fromEntries(entries.slice(-200))
    try { window.localStorage.setItem(modelSettingsStorageKey, JSON.stringify(savedModelSettings.value)) } catch { /* In-memory choices remain usable. */ }
  }
  const selectedReasoningEffort = computed({ get: () => currentModelSettings.value.effort, set: (effort: string) => saveCurrentModelSettings({ effort }) })
  const selectedSpeedMode = computed({ get: () => currentModelSettings.value.tier, set: (tier: string) => saveCurrentModelSettings({ tier }) })
  function checkedModelSettings(modelId: string, hasImages = false) {
    const model = availableModels.value.find(item => item.id === modelId)
    const effort = selectedReasoningEffort.value
    const tier = selectedSpeedMode.value
    const session = webPreferences.sessions.value[selectedThreadId.value]
    if (session && normalizeProviderContextId(session.provider) !== readProviderIdForThread(selectedThreadId.value)) throw new Error('保存的模型属于其他来源，请重新选择模型。')
    if (session?.model && availableModels.value.length && !model) throw new Error('保存的模型暂不可用，请重新选择模型。')
    const problem = modelSettingsProblem(model, effort, tier, hasImages)
    if (problem) throw new Error(problem)
    return { model: model?.model || modelId, effort: effort || model?.defaultEffort || '', serviceTier: session ? tier || null : tier || model?.defaultServiceTier || null }
  }
  const activeProviderId = ref('')
  const codexCliMissingError = ref('')
  const projectOrder = ref<string[]>(loadProjectOrder())
  const projectDisplayNameById = ref<Record<string, string>>(loadProjectDisplayNames())
  const loadedVersionByThreadId = ref<Record<string, string>>({})
  const loadedMessagesByThreadId = ref<Record<string, boolean>>({})
  const threadSearchVersion = ref(0)
  const historyPositionByThreadId = ref<Record<string, ThreadHistoryPosition>>({})
  const hasMoreOlderMessagesByThreadId = ref<Record<string, boolean>>({})
  const loadingOlderMessagesByThreadId = ref<Record<string, boolean>>({})
  const resumedThreadById = ref<Record<string, boolean>>({})
  const turnIndexByTurnIdByThreadId = ref<Record<string, Record<string, number>>>({})
  const turnSummaryByThreadId = ref<Record<string, TurnSummaryState>>({})
  const turnActivityByThreadId = ref<Record<string, TurnActivityState>>({})
  const turnErrorByThreadId = ref<Record<string, TurnErrorState>>({})
  const activeTurnIdByThreadId = ref<Record<string, string>>({})
  const interruptBlockedUntilPersistedByThreadId = ref<Record<string, boolean>>({})
  const threadListedByServerById = ref<Record<string, boolean>>({})
  const persistedUserMessageByThreadId = ref<Record<string, boolean>>({})
  const pendingServerRequestsByThreadId = ref<Record<string, UiServerRequest[]>>({})
  const authRecoveryByThreadId = ref<Record<string, AuthRecoveryState>>({})
  const selectedAuthRecovery = computed(() => authRecoveryByThreadId.value[selectedThreadId.value] ?? null)
  let pendingSnapshot: {
    requests: Map<number, UiServerRequest | null>
    auth: Map<string, AuthRecoveryState | null>
  } | null = null
  const codexRateLimit = ref<UiRateLimitSnapshot | null>(null)
  const threadTokenUsageByThreadId = ref<Record<string, UiThreadTokenUsage>>(loadThreadTokenUsageMap())
  const terminalOpenByThreadId = ref<Record<string, boolean>>(loadThreadTerminalOpenMap())
  const threadModelProviderByThreadId = ref<Record<string, string>>({})

  const threadTitleById = ref<Record<string, string>>({})

  const installedSkills = ref<SkillInfo[]>([])
  const accountRateLimitSnapshots = ref<UiRateLimitSnapshot[]>([])

  const isLoadingThreads = ref(false)
  const isLoadingMessages = ref(false)
  const isThreadListFullyLoaded = ref(false)
  const isSendingMessage = ref(false)
  const isInterruptingTurn = ref(false)
  const isUpdatingSpeedMode = ref(false)
  const isRollingBack = ref(false)

  const error = ref('')
  const isPolling = ref(false)
  const hasLoadedThreads = ref(false)

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
    const persisted = persistedMessagesByThreadId.value[threadId] ?? []
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
  let stopNotificationStream: (() => void) | null = null
  let eventSyncTimer: number | null = null
  let rateLimitRefreshTimer: number | null = null
  const delayedTurnSyncTimerByThreadId = new Map<string, number>()
  let loadThreadsPromise: Promise<void> | null = null
  let accountIdentityRevision = 0
  const loadIdentityRevisionByThreadId = new Map<string, number>()
  const loadMessagePromiseByThreadId = new Map<string, Promise<void>>()
  let refreshSkillsPromise: Promise<void> | null = null
  let lastThreadListLoadAt = 0
  let hasLoadedSkills = false
  let lastSkillsLoadAt = 0
  let lastSkillsLoadKey = ''
  let rateLimitRefreshPromise: Promise<void> | null = null
  let pendingThreadsRefresh = false
  let pendingThreadsRefreshForce = false
  const pendingThreadMessageRefresh = new Set<string>()
  const messageHistoryRevisionByThreadId = new Map<string, number>()
  const loadedHistoryRevisionByThreadId = new Map<string, number>()
  function markThreadHistoryDirty(threadId: string) {
    messageHistoryRevisionByThreadId.set(threadId, (messageHistoryRevisionByThreadId.get(threadId) ?? 0) + 1)
    pendingThreadMessageRefresh.add(threadId)
  }
  const lastMessageLoadAtByThreadId = new Map<string, number>()
  const lastMessageLoadFailureAtByThreadId = new Map<string, number>()
  let threadListNextCursor: string | null = null
  let threadListBackgroundTimer: number | null = null
  let isLoadingRemainingThreadPages = false
  let hasLoadedAllThreadPages = false
  let loadedThreadListGroups: UiProjectGroup[] = []
  let loadedThreadListRootsState: WorkspaceRootsState | null = null
  let hasHydratedWorkspaceRootsState = false
  let activeReasoningItemId = ''
  let shouldAutoScrollOnNextAgentEvent = false
  const pendingTurnStartsById = new Map<string, TurnStartedInfo>()


  const allThreads = computed(() => flattenThreads(projectGroups.value))
  const selectedThread = computed(() => {
    const threadId = selectedThreadId.value
    const listed = allThreads.value.find(thread => thread.id === threadId)
    const snapshot = snapshotThreads.value[threadId]
    const thread = listed ?? snapshot
    if (!thread) return null
    const organization = loadedThreadListRootsState?.virtualProjects?.find(project => project.cwds.includes(thread.cwd))
    return { ...thread, projectName: organization?.id ?? thread.projectName, title: threadTitleById.value[threadId] || thread.title, task: snapshot?.task ?? thread.task }
  })
  const selectedThreadTerminalOpen = computed(() => {
    const threadId = selectedThreadId.value
    return Boolean(threadId && terminalOpenByThreadId.value[threadId] === true)
  })
  const isSelectedThreadInterruptPending = computed(() => {
    const threadId = selectedThreadId.value
    if (!threadId) return false
    return interruptBlockedUntilPersistedByThreadId.value[threadId] === true
  })
  const selectedThreadServerRequests = computed<UiServerRequest[]>(() => {
    const rows: UiServerRequest[] = []
    const selected = selectedThreadId.value
    if (selected && Array.isArray(pendingServerRequestsByThreadId.value[selected])) {
      rows.push(...pendingServerRequestsByThreadId.value[selected])
    }
    if (Array.isArray(pendingServerRequestsByThreadId.value[GLOBAL_SERVER_REQUEST_SCOPE])) {
      rows.push(...pendingServerRequestsByThreadId.value[GLOBAL_SERVER_REQUEST_SCOPE])
    }
    return rows.sort((first, second) => first.receivedAtIso.localeCompare(second.receivedAtIso))
  })
  const selectedLiveOverlay = computed<UiLiveOverlay | null>(() => {
    const threadId = selectedThreadId.value
    if (!threadId) return null

    const isInProgress = inProgressById.value[threadId] === true
    const activity = isInProgress ? turnActivityByThreadId.value[threadId] : undefined
    const reasoningText = isInProgress
      ? (liveReasoningTextByThreadId.value[threadId] ?? '').trim()
      : ''
    const liveErrorText = (turnErrorByThreadId.value[threadId]?.message ?? '').trim()
    let latestPersistedTurnErrorText = ''
    if (!isInProgress && liveErrorText) {
      const persistedMessages = persistedMessagesByThreadId.value[threadId] ?? []
      for (let index = persistedMessages.length - 1; index >= 0; index -= 1) {
        const message = persistedMessages[index]
        if (message.messageType !== 'turnError') continue
        latestPersistedTurnErrorText = normalizeMessageText(message.text)
        break
      }
    }
    const errorText =
      !isInProgress && liveErrorText && latestPersistedTurnErrorText === liveErrorText
        ? ''
        : liveErrorText

    if (!isInProgress && !activity && !reasoningText && !errorText) return null
    return {
      activityLabel: activity?.label || 'Thinking',
      activityDetails: activity?.details ?? [],
      reasoningText,
      errorText,
    }
  })
  const codexQuota = computed<UiRateLimitSnapshot | null>(() => codexRateLimit.value)
  const selectedThreadTokenUsage = computed<UiThreadTokenUsage | null>(() => {
    const threadId = selectedThreadId.value
    if (!threadId) return null
    return threadTokenUsageByThreadId.value[threadId] ?? null
  })
  const messages = computed<UiMessage[]>(() => {
    const threadId = selectedThreadId.value
    if (!threadId) return []

    const persisted = persistedMessagesByThreadId.value[threadId] ?? []
    const livePlan = livePlanMessagesByThreadId.value[threadId] ?? []
    const liveAgent = liveAgentMessagesByThreadId.value[threadId] ?? []
    const liveCommands = liveCommandsByThreadId.value[threadId] ?? []
    const liveFileChanges = liveFileChangeMessagesByThreadId.value[threadId] ?? []
    const combined = combineHistoryAndLive(persisted, [...livePlan, ...liveCommands, ...liveFileChanges, ...liveAgent])

    const summary = turnSummaryByThreadId.value[threadId]
    const history = summary ? insertTurnSummaryMessage(combined, summary) : combined
    return conversationDeliveries.project(threadId, history)
  })
  const hasMoreOlderMessages = computed(() => {
    const threadId = selectedThreadId.value
    return threadId ? hasMoreOlderMessagesByThreadId.value[threadId] === true : false
  })
  const isLoadingOlderMessages = computed(() => {
    const threadId = selectedThreadId.value
    return threadId ? loadingOlderMessagesByThreadId.value[threadId] === true : false
  })

  function getFirstPersistedTurnId(threadId: string): string {
    const persisted = persistedMessagesByThreadId.value[threadId] ?? []
    for (const message of persisted) {
      const turnId = message.turnId?.trim() ?? ''
      if (turnId) return turnId
    }
    return ''
  }

  function readModelIdForThread(threadId: string): string {
    const session = webPreferences.sessions.value[threadId === NEW_THREAD_COLLABORATION_MODE_CONTEXT ? '' : threadId]
    if (session) return effectiveConversationChoice(session, availableModels.value).model
    const contextId = toThreadContextId(threadId)
    if (contextId === NEW_THREAD_COLLABORATION_MODE_CONTEXT) {
      const normalizedProviderId = normalizeProviderContextId(activeProviderId.value)
      const providerContextId = toProviderModelContextId(normalizedProviderId)
      const providerModelId = providerContextId
        ? normalizeStoredModelId(selectedModelIdByContext.value[providerContextId])
        : ''
      if (providerModelId) return providerModelId
    }
    const preferred = readSelectedModel(selectedModelIdByContext.value, threadId).trim()
    if (threadId && selectedModelIdByContext.value[threadId] && availableModels.value.length) {
      return effectiveConversationChoice({ model: preferred, provider: readProviderIdForThread(threadId), effort: '', tier: '' }, availableModels.value).model
    }
    return preferred
  }

  function readProviderIdForThread(threadId: string): string {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return normalizeProviderContextId(activeProviderId.value)
    return normalizeProviderContextId(threadModelProviderByThreadId.value[normalizedThreadId] ?? activeProviderId.value)
  }

  function ensureAvailableModelIds(...modelIds: string[]): void {
    const nextModelIds = [...availableModelIds.value]
    for (const modelId of modelIds) {
      const normalizedModelId = modelId.trim()
      if (normalizedModelId && !nextModelIds.includes(normalizedModelId)) {
        nextModelIds.push(normalizedModelId)
      }
    }
    if (!areStringArraysEqual(availableModelIds.value, nextModelIds)) {
      availableModelIds.value = nextModelIds
    }
  }

  function readProviderCompatibleSelectedModel(modelId: string): string {
    const normalizedModelId = modelId.trim()
    if (availableModelIds.value.length === 0) return normalizedModelId
    if (normalizedModelId && availableModelIds.value.includes(normalizedModelId)) return normalizedModelId
    return availableModelIds.value[0] ?? ''
  }

  function setSelectedThreadId(nextThreadId: string, options: { persist?: boolean } = {}): void {
    if (selectedThreadId.value === nextThreadId) return
    selectedThreadId.value = nextThreadId
    if (options.persist !== false) {
      saveSelectedThreadId(nextThreadId)
    }
    selectedModelId.value = readProviderCompatibleSelectedModel(readModelIdForThread(nextThreadId))
    initializeWebConversation(nextThreadId)
    selectedCollaborationMode.value = readSelectedCollaborationMode(
      selectedCollaborationModeByContext.value,
      nextThreadId,
    )
    activeReasoningItemId = ''
    shouldAutoScrollOnNextAgentEvent = false
    applyThreadFlags()
  }

  function setSelectedModelIdForThread(threadId: string, modelId: string): void {
    const normalizedModelId = modelId.trim()
    const webSessionId = threadId === NEW_THREAD_COLLABORATION_MODE_CONTEXT ? '' : threadId
    const session = webPreferences.sessions.value[webSessionId]
    if (session) {
      webPreferences.select(webSessionId, { model: normalizedModelId, provider: readProviderIdForThread(threadId), effort: '', tier: '' })
      if (webSessionId === selectedThreadId.value) selectedModelId.value = normalizedModelId
      return
    }
    if (configuredModelSettings.value.model && selectedModelId.value && selectedModelId.value !== normalizedModelId && !savedModelSettings.value[modelSettingsKey.value]) saveCurrentModelSettings({})
    const contextId = toThreadContextId(threadId)
    const normalizedProviderId = normalizeProviderContextId(activeProviderId.value)
    const providerContextId =
      contextId === NEW_THREAD_COLLABORATION_MODE_CONTEXT
        ? toProviderModelContextId(normalizedProviderId)
        : ''
    const selectedContextId = providerContextId || contextId
    if (normalizedModelId) {
      const nextModelMap = cloneStringKeyedRecord(selectedModelIdByContext.value)
      nextModelMap[selectedContextId] = normalizedModelId
      if (providerContextId) {
        delete nextModelMap[contextId]
      }
      selectedModelIdByContext.value = nextModelMap
    } else {
      let nextModelMap = omitStringKeyedRecordKey(selectedModelIdByContext.value, selectedContextId)
      if (providerContextId) {
        nextModelMap = omitStringKeyedRecordKey(nextModelMap, contextId)
      }
      selectedModelIdByContext.value = nextModelMap
    }
    if (threadId.trim() === selectedThreadId.value) {
      selectedModelId.value = readModelIdForThread(selectedThreadId.value)
      ensureAvailableModelIds(selectedModelId.value)
    } else {
      ensureAvailableModelIds(normalizedModelId)
    }
    saveSelectedModelMap(selectedModelIdByContext.value)
  }

  function setSelectedModelId(modelId: string): void {
    setSelectedModelIdForThread(selectedThreadId.value, modelId)
  }

  function setThreadModelId(threadId: string, modelId: string): void {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return

    const normalizedModelId = modelId.trim()
    if (normalizedModelId) reportedModelByThreadId.value = { ...reportedModelByThreadId.value, [normalizedThreadId]: normalizedModelId }
    if (selectedModelIdByContext.value[normalizedThreadId]) return
    if (normalizedModelId) {
      const nextModelMap = cloneStringKeyedRecord(selectedModelIdByContext.value)
      nextModelMap[normalizedThreadId] = normalizedModelId
      selectedModelIdByContext.value = nextModelMap
    } else {
      selectedModelIdByContext.value = omitStringKeyedRecordKey(selectedModelIdByContext.value, normalizedThreadId)
    }
    ensureAvailableModelIds(normalizedModelId)
    if (selectedThreadId.value === normalizedThreadId) {
      selectedModelId.value = readModelIdForThread(selectedThreadId.value)
    }
    saveSelectedModelMap(selectedModelIdByContext.value)
  }

  function setThreadModelProviderId(threadId: string, providerId: string): void {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return

    const normalizedProviderId = normalizeProviderContextId(providerId)
    if (normalizedProviderId) {
      threadModelProviderByThreadId.value = {
        ...threadModelProviderByThreadId.value,
        [normalizedThreadId]: normalizedProviderId,
      }
    } else if (threadModelProviderByThreadId.value[normalizedThreadId]) {
      threadModelProviderByThreadId.value = omitKey(threadModelProviderByThreadId.value, normalizedThreadId)
    }
  }

  function resolveThreadModelForProvider(threadId: string, modelId: string, providerId: string): string {
    const normalizedModelId = modelId.trim()
    const normalizedProviderId = normalizeProviderContextId(providerId)
    if (normalizedProviderId !== 'opencode-zen') {
      return normalizedModelId
    }

    const previousThreadModel = readModelIdForThread(threadId).trim()
    if (previousThreadModel && !/^gpt-/i.test(previousThreadModel)) {
      return previousThreadModel
    }
    if (normalizedModelId && !/^gpt-/i.test(normalizedModelId)) {
      return normalizedModelId
    }
    return OPENCODE_ZEN_DEFAULT_MODEL
  }

  function setThreadTokenUsage(threadId: string, usage: UiThreadTokenUsage | null): void {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return

    if (!usage) {
      if (!(normalizedThreadId in threadTokenUsageByThreadId.value)) return
      threadTokenUsageByThreadId.value = omitKey(threadTokenUsageByThreadId.value, normalizedThreadId)
      saveThreadTokenUsageMap(threadTokenUsageByThreadId.value)
      return
    }

    const current = threadTokenUsageByThreadId.value[normalizedThreadId]
    if (current && JSON.stringify(current) === JSON.stringify(usage)) return

    threadTokenUsageByThreadId.value = {
      ...threadTokenUsageByThreadId.value,
      [normalizedThreadId]: usage,
    }
    saveThreadTokenUsageMap(threadTokenUsageByThreadId.value)
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

  function setCodexRateLimit(nextSnapshot: UiRateLimitSnapshot | null): void {
    codexRateLimit.value = nextSnapshot
  }

  function setSelectedReasoningEffort(effort: ReasoningEffort | ''): void {
    if (effort && !capabilityValue(effort)) {
      return
    }
    selectedReasoningEffort.value = effort
  }

  async function updateSelectedSpeedMode(mode: SpeedMode): Promise<void> {
    const nextMode = capabilityValue(mode)
    if (isUpdatingSpeedMode.value || selectedSpeedMode.value === nextMode) {
      return
    }

    const problem = modelSettingsProblem(selectedModelCapability.value, selectedReasoningEffort.value, nextMode)
    if (problem) { error.value = problem; return }
    try {
      selectedSpeedMode.value = nextMode
      error.value = ''
    } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Fast 设置保存失败' }

  }

  async function refreshCollaborationModes(): Promise<void> {
    try {
      const modes = await getAvailableCollaborationModes()
      availableCollaborationModes.value = modes
      if (!modes.some((mode) => mode.value === selectedCollaborationMode.value)) {
        setSelectedCollaborationMode('default')
      }
    } catch {
      // Keep the last known collaboration mode choices on transient failures.
    }
  }

  function buildPendingTurnDetails(
    modelId: string,
    effort: ReasoningEffort | '',
    collaborationMode: CollaborationModeKind = selectedCollaborationMode.value,
  ): string[] {
    const modelLabel = modelId.trim() || 'default'
    const effortLabel = effort || 'default'
    const modeLabel = collaborationMode === 'plan' ? 'Plan' : 'Default'
    const speedLabel = selectedSpeedMode.value || 'Standard'
    return [`Mode: ${modeLabel}`, `Model: ${modelLabel}`, `Thinking: ${effortLabel}`, `Speed: ${speedLabel}`]
  }

  async function refreshModelPreferences(options?: { providerChanged?: boolean; includeProviderModels?: boolean; retry?: boolean }): Promise<void> {
    if (modelRetryTimer) clearTimeout(modelRetryTimer)
    modelRetryTimer = null
    const generation = ++modelRefreshGeneration
    const threadContext = selectedThreadId.value
    if (options?.providerChanged) invalidateModelCatalog()
    codexCliMissingError.value = ''
    try {
      const currentConfig = await getCurrentModelConfig()
      if (generation !== modelRefreshGeneration || threadContext !== selectedThreadId.value) return
      const normalizedConfiguredModelId = currentConfig.model.trim()
      const normalizedProviderId = normalizeProviderContextId(currentConfig.providerId)
      activeProviderId.value = normalizedProviderId
      const targetProviderId = readProviderIdForThread(selectedThreadId.value)
      availableModels.value = availableModels.value.filter(model => model.providerId === targetProviderId)
      const isProviderBacked = targetProviderId !== 'codex'
      const normalizedSelectedModelId = readModelIdForThread(selectedThreadId.value)
      const models = await getAvailableModels({
        ...(!isProviderBacked ? { accountScoped: true } : {}),
        includeProviderModels: isProviderBacked,
        requireProviderModels: isProviderBacked,
        providerId: isProviderBacked ? targetProviderId : undefined,
      })
      if (generation !== modelRefreshGeneration || threadContext !== selectedThreadId.value) return
      availableModels.value = models
      modelCatalogError.value = ''
      const modelIds = models.map(model => model.id)
      const providerModelContextId = toProviderModelContextId(targetProviderId)
      const providerScopedModelId = providerModelContextId
        ? normalizeStoredModelId(selectedModelIdByContext.value[providerModelContextId])
        : ''
      const nextModelIds = [...modelIds]
      if (
        !options?.providerChanged
        && isProviderBacked
        && targetProviderId === normalizedProviderId
        && normalizedConfiguredModelId
        && !nextModelIds.includes(normalizedConfiguredModelId)
      ) {
        nextModelIds.push(normalizedConfiguredModelId)
      }
      availableModelIds.value = nextModelIds

      configuredModelSettings.value = { model: normalizedConfiguredModelId, provider: normalizedProviderId, effort: currentConfig.reasoningEffort, tier: currentConfig.speedMode }
      if (!webPreferences.sessions.value[selectedThreadId.value]) initializeWebConversation(selectedThreadId.value)
      const webSession = webPreferences.sessions.value[selectedThreadId.value]
      if (webSession?.model) {
        selectedModelId.value = effectiveConversationChoice(webSession, models).model
        return
      }
      const rememberedModel = selectedModelIdByContext.value[selectedThreadId.value]
      if (selectedThreadId.value && rememberedModel && targetProviderId === 'codex') {
        // Catalog fallback is effective state, never a new user preference.
        selectedModelId.value = effectiveConversationChoice({ model: rememberedModel, provider: targetProviderId, effort: '', tier: '' }, models).model
        return
      }
      const currentModelInNewList = normalizedSelectedModelId && modelIds.includes(normalizedSelectedModelId)
      if (!normalizedSelectedModelId || !currentModelInNewList || options?.providerChanged) {
        if (options?.providerChanged && nextModelIds.length > 0) {
          if (providerScopedModelId && modelIds.includes(providerScopedModelId)) {
            setSelectedModelId(providerScopedModelId)
          } else if (targetProviderId === normalizedProviderId && normalizedConfiguredModelId && nextModelIds.includes(normalizedConfiguredModelId)) {
            setSelectedModelId(normalizedConfiguredModelId)
          } else {
            setSelectedModelId(nextModelIds[0])
          }
        } else if (targetProviderId === normalizedProviderId && normalizedConfiguredModelId && nextModelIds.includes(normalizedConfiguredModelId)) {
          setSelectedModelId(currentConfig.model)
        } else if (nextModelIds.length > 0) {
          setSelectedModelId(nextModelIds[0])
        } else {
          setSelectedModelId('')
        }
      } else if (selectedModelId.value.trim() !== normalizedSelectedModelId) {
        setSelectedModelId(normalizedSelectedModelId)
      }
      if (providerModelContextId && selectedModelId.value.trim().length > 0) {
        const nextModelMap = cloneStringKeyedRecord(selectedModelIdByContext.value)
        nextModelMap[providerModelContextId] = selectedModelId.value.trim()
        const activeProviderModelContextId = toProviderModelContextId(normalizedProviderId)
        if (
          activeProviderModelContextId
          && activeProviderModelContextId !== providerModelContextId
          && normalizedConfiguredModelId
        ) {
          nextModelMap[activeProviderModelContextId] = normalizedConfiguredModelId
        }
        selectedModelIdByContext.value = nextModelMap
        saveSelectedModelMap(selectedModelIdByContext.value)
      }

      configuredModelSettings.value = { model: normalizedConfiguredModelId, provider: normalizedProviderId, effort: currentConfig.reasoningEffort, tier: currentConfig.speedMode }

    } catch (unknownError) {
      if (isCodexCliMissingError(unknownError)) {
        codexCliMissingError.value = CODEX_CLI_MISSING_MESSAGE
      } else {
        codexCliMissingError.value = ''
      }
      if (generation === modelRefreshGeneration) modelCatalogError.value = '模型目录暂时不可用'
      if (!options?.retry && generation === modelRefreshGeneration) {
        modelRetryTimer = setTimeout(() => {
          modelRetryTimer = null
          if (generation === modelRefreshGeneration && threadContext === selectedThreadId.value) {
            void refreshModelPreferences({ ...options, retry: true })
          }
        }, 3000)
      }
      // Keep chat UI usable even if model metadata is temporarily unavailable.
    }
  }

  async function refreshRateLimits(): Promise<void> {
    if (Date.now() - recentRateLimitsAt < 2000) return
    if (rateLimitRefreshPromise) {
      await rateLimitRefreshPromise
      return
    }

    rateLimitRefreshPromise = (async () => {
      try {
        const revision = rateLimitUpdateRevision
        const snapshot = await getAccountRateLimits()
        recentRateLimitsAt = Date.now()
        if (revision === rateLimitUpdateRevision) setCodexRateLimit(snapshot)
        accountRateLimitSnapshots.value = codexRateLimit.value ? [codexRateLimit.value] : []
      } catch {
        // Keep the last known rate-limit state if the endpoint is temporarily unavailable.
      } finally {
        rateLimitRefreshPromise = null
      }
    })()

    await rateLimitRefreshPromise
  }

  function scheduleRateLimitRefresh(): void {
    recentRateLimitsAt = 0
    if (typeof window === 'undefined') {
      void refreshRateLimits()
      return
    }

    if (rateLimitRefreshTimer !== null) {
      window.clearTimeout(rateLimitRefreshTimer)
    }

    rateLimitRefreshTimer = window.setTimeout(() => {
      rateLimitRefreshTimer = null
      void refreshRateLimits()
    }, RATE_LIMIT_REFRESH_DEBOUNCE_MS)
  }

  function clearDelayedTurnSync(threadId: string): void {
    if (!threadId || typeof window === 'undefined') return
    const timerId = delayedTurnSyncTimerByThreadId.get(threadId)
    if (timerId === undefined) return
    window.clearTimeout(timerId)
    delayedTurnSyncTimerByThreadId.delete(threadId)
  }

  function scheduleDelayedTurnSync(threadId: string): void {
    if (!threadId || typeof window === 'undefined') return
    clearDelayedTurnSync(threadId)
    const timerId = window.setTimeout(() => {
      delayedTurnSyncTimerByThreadId.delete(threadId)
      markThreadHistoryDirty(threadId)
      void syncFromNotifications()
    }, TURN_START_FOLLOW_UP_SYNC_DELAY_MS)
    delayedTurnSyncTimerByThreadId.set(threadId, timerId)
  }

  function applyCachedTitlesToGroups(groups: UiProjectGroup[]): UiProjectGroup[] {
    const titles = threadTitleById.value
    if (Object.keys(titles).length === 0) return groups
    return groups.map((group) => ({
      projectName: group.projectName,
      threads: group.threads.map((thread) => {
        const cached = titles[thread.id]
        return cached ? { ...thread, title: cached } : thread
      }),
    }))
  }

  function getThreadPendingRequests(threadId: string): UiServerRequest[] {
    if (!threadId) return []
    return Array.isArray(pendingServerRequestsByThreadId.value[threadId])
      ? pendingServerRequestsByThreadId.value[threadId]
      : []
  }

  function isApprovalRequestMethod(method: string): boolean {
    return (
      method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval' ||
      method === 'item/permissions/requestApproval' ||
      method === 'execCommandApproval' ||
      method === 'applyPatchApproval'
    )
  }

  function readPendingRequestState(requests: UiServerRequest[]): UiPendingRequestState | null {
    if (requests.some((request) => isApprovalRequestMethod(request.method))) {
      return 'approval'
    }
    return requests.some(request => !isAsyncUserInputRequest(request)) ? 'response' : null
  }

  function applyThreadFlags(): void {
    const withTitles = applyCachedTitlesToGroups(sourceGroups.value)
    const flaggedGroups: UiProjectGroup[] = withTitles.map((group) => ({
      projectName: group.projectName,
      threads: group.threads.map((thread) => {
        const inProgress = inProgressById.value[thread.id] === true
        const pendingRequestState = readPendingRequestState(getThreadPendingRequests(thread.id))
        const isSelected = selectedThreadId.value === thread.id
        const unread = !isSelected && !inProgress && Boolean(eventUnreadByThreadId.value[thread.id])

        return {
          ...thread,
          inProgress,
          unread,
          pendingRequestState,
        }
      }),
    }))
    projectGroups.value = mergeThreadGroups(projectGroups.value, flaggedGroups)
  }

  const pendingListedThreadIds = new Set<string>()

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

  function pruneThreadScopedState(flatThreads: UiThread[]): void {
    const activeThreadIds = new Set(flatThreads.map((thread) => thread.id))
    const currentThreadId = selectedThreadId.value.trim()
    if (currentThreadId) {
      activeThreadIds.add(currentThreadId)
    }
    snapshotThreads.value = pruneThreadContextStateMap(snapshotThreads.value, activeThreadIds)
    const nextSelectedModelMap = pruneThreadContextStateMap(selectedModelIdByContext.value, activeThreadIds)
    if (nextSelectedModelMap !== selectedModelIdByContext.value) {
      selectedModelIdByContext.value = nextSelectedModelMap
      selectedModelId.value = readProviderCompatibleSelectedModel(readModelIdForThread(selectedThreadId.value))
      saveSelectedModelMap(nextSelectedModelMap)
    }
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
    // The current list may be paginated or filtered. Absence is not deletion;
    // retaining read markers prevents older pages becoming unread after reload.
    loadedMessagesByThreadId.value = pruneThreadStateMap(loadedMessagesByThreadId.value, activeThreadIds)
    for (const map of [messageHistoryRevisionByThreadId, loadedHistoryRevisionByThreadId]) {
      for (const id of map.keys()) if (!activeThreadIds.has(id)) map.delete(id)
    }
    loadedVersionByThreadId.value = pruneThreadStateMap(loadedVersionByThreadId.value, activeThreadIds)
    resumedThreadById.value = pruneThreadStateMap(resumedThreadById.value, activeThreadIds)
    historyPositionByThreadId.value = pruneThreadStateMap(historyPositionByThreadId.value, activeThreadIds)
    turnIndexByTurnIdByThreadId.value = pruneThreadStateMap(turnIndexByTurnIdByThreadId.value, activeThreadIds)
    persistedMessagesByThreadId.value = pruneThreadStateMap(persistedMessagesByThreadId.value, activeThreadIds)
    liveAgentMessagesByThreadId.value = pruneThreadStateMap(liveAgentMessagesByThreadId.value, activeThreadIds)
    liveReasoningTextByThreadId.value = pruneThreadStateMap(liveReasoningTextByThreadId.value, activeThreadIds)
    liveCommandsByThreadId.value = pruneThreadStateMap(liveCommandsByThreadId.value, activeThreadIds)
    liveFileChangeMessagesByThreadId.value = pruneThreadStateMap(liveFileChangeMessagesByThreadId.value, activeThreadIds)
    turnSummaryByThreadId.value = pruneThreadStateMap(turnSummaryByThreadId.value, activeThreadIds)
    turnActivityByThreadId.value = pruneThreadStateMap(turnActivityByThreadId.value, activeThreadIds)
    turnErrorByThreadId.value = pruneThreadStateMap(turnErrorByThreadId.value, activeThreadIds)
    activeTurnIdByThreadId.value = pruneThreadStateMap(activeTurnIdByThreadId.value, activeThreadIds)
    interruptBlockedUntilPersistedByThreadId.value = pruneThreadStateMap(
      interruptBlockedUntilPersistedByThreadId.value,
      activeThreadIds,
    )
    threadListedByServerById.value = pruneThreadStateMap(threadListedByServerById.value, activeThreadIds)
    persistedUserMessageByThreadId.value = pruneThreadStateMap(persistedUserMessageByThreadId.value, activeThreadIds)
    reportedModelByThreadId.value = pruneThreadStateMap(reportedModelByThreadId.value, activeThreadIds)
    threadModelProviderByThreadId.value = pruneThreadStateMap(threadModelProviderByThreadId.value, activeThreadIds)
    threadTokenUsageByThreadId.value = pruneThreadStateMap(threadTokenUsageByThreadId.value, activeThreadIds)
    inProgressById.value = pruneThreadStateMap(inProgressById.value, activeThreadIds)
    const nextPending: Record<string, UiServerRequest[]> = {}
    for (const [threadId, requests] of Object.entries(pendingServerRequestsByThreadId.value)) {
      if (threadId === GLOBAL_SERVER_REQUEST_SCOPE || activeThreadIds.has(threadId)) {
        nextPending[threadId] = requests
      }
    }
    pendingServerRequestsByThreadId.value = nextPending
  }

  const completionAcknowledgements = new Map<string, string>()

  function markThreadAsRead(threadId: string): void {
    const token = eventUnreadByThreadId.value[threadId]
    if (!token || completionAcknowledgements.get(threadId) === token) return
    completionAcknowledgements.set(threadId, token)
    void fetch('/codex-api/thread-completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId, token }),
    }).then(response => {
      if (response.ok && eventUnreadByThreadId.value[threadId] === token) {
        eventUnreadByThreadId.value = omitKey(eventUnreadByThreadId.value, threadId)
        if (completionChangesDuringLoad) completionChangesDuringLoad[threadId] = null
        applyThreadFlags()
      }
    }).catch(() => {}).finally(() => {
      if (completionAcknowledgements.get(threadId) === token) completionAcknowledgements.delete(threadId)
    })
  }

  function setTurnSummaryForThread(threadId: string, summary: TurnSummaryState | null): void {
    if (!threadId) return

    const previous = turnSummaryByThreadId.value[threadId]
    if (summary) {
      if (areTurnSummariesEqual(previous, summary)) return
      turnSummaryByThreadId.value = {
        ...turnSummaryByThreadId.value,
        [threadId]: summary,
      }
    } else {
      if (previous) {
        turnSummaryByThreadId.value = omitKey(turnSummaryByThreadId.value, threadId)
      }
    }
  }

  function setThreadInProgress(threadId: string, nextInProgress: boolean): void {
    if (!threadId) return
    threadStatusRevision.set(threadId, (threadStatusRevision.get(threadId) ?? 0) + 1)
    const currentValue = inProgressById.value[threadId] === true
    if (currentValue === nextInProgress) return
    if (nextInProgress) {
      inProgressById.value = {
        ...inProgressById.value,
        [threadId]: true,
      }
    } else {
      inProgressById.value = omitKey(inProgressById.value, threadId)
      clearCompletedTurnLiveState(threadId)
      clearInterruptPersistenceGate(threadId)
    }
    applyThreadFlags()
    if (!nextInProgress && !hasActiveInProgressThreads() && threadListNextCursor) {
      scheduleRemainingThreadPages()
    }
  }

  function clearInterruptPersistenceGate(threadId: string): void {
    if (!threadId) return
    if (interruptBlockedUntilPersistedByThreadId.value[threadId]) {
      interruptBlockedUntilPersistedByThreadId.value = omitKey(interruptBlockedUntilPersistedByThreadId.value, threadId)
    }
    if (threadListedByServerById.value[threadId]) {
      threadListedByServerById.value = omitKey(threadListedByServerById.value, threadId)
    }
    if (persistedUserMessageByThreadId.value[threadId]) {
      persistedUserMessageByThreadId.value = omitKey(persistedUserMessageByThreadId.value, threadId)
    }
  }

  function blockInterruptUntilThreadIsPersisted(threadId: string): void {
    if (!threadId) return
    interruptBlockedUntilPersistedByThreadId.value = {
      ...interruptBlockedUntilPersistedByThreadId.value,
      [threadId]: true,
    }
    if (threadListedByServerById.value[threadId]) {
      threadListedByServerById.value = omitKey(threadListedByServerById.value, threadId)
    }
    if (persistedUserMessageByThreadId.value[threadId]) {
      persistedUserMessageByThreadId.value = omitKey(persistedUserMessageByThreadId.value, threadId)
    }
  }

  function maybeUnblockInterruptForPersistedThread(threadId: string): void {
    if (!threadId) return
    if (interruptBlockedUntilPersistedByThreadId.value[threadId] !== true) return
    if (threadListedByServerById.value[threadId] !== true) return
    if (persistedUserMessageByThreadId.value[threadId] !== true) return
    clearInterruptPersistenceGate(threadId)
  }

  function maybeUnblockInterruptForActiveTurn(threadId: string, turnId: string): void {
    if (!threadId || !turnId) return
    if (interruptBlockedUntilPersistedByThreadId.value[threadId] !== true) return
    clearInterruptPersistenceGate(threadId)
  }

  function markServerListedThreads(serverThreadIds: Set<string>): void {
    const pendingThreadIds = Object.keys(interruptBlockedUntilPersistedByThreadId.value)
    if (pendingThreadIds.length === 0) return

    let nextListedState = threadListedByServerById.value
    let changed = false
    for (const threadId of pendingThreadIds) {
      if (!serverThreadIds.has(threadId) || nextListedState[threadId] === true) continue
      nextListedState = {
        ...nextListedState,
        [threadId]: true,
      }
      changed = true
    }

    if (!changed) return
    threadListedByServerById.value = nextListedState
    for (const threadId of pendingThreadIds) {
      maybeUnblockInterruptForPersistedThread(threadId)
    }
  }

  function markThreadMessagesPersisted(threadId: string, messages: UiMessage[]): void {
    if (!threadId) return
    if (interruptBlockedUntilPersistedByThreadId.value[threadId] !== true) return
    if (!messages.some((message) => message.role === 'user')) return
    if (persistedUserMessageByThreadId.value[threadId] !== true) {
      persistedUserMessageByThreadId.value = {
        ...persistedUserMessageByThreadId.value,
        [threadId]: true,
      }
    }
    maybeUnblockInterruptForPersistedThread(threadId)
  }

  function setTurnActivityForThread(threadId: string, activity: TurnActivityState | null): void {
    if (!threadId) return

    const previous = turnActivityByThreadId.value[threadId]
    if (!activity) {
      if (previous) {
        turnActivityByThreadId.value = omitKey(turnActivityByThreadId.value, threadId)
      }
      return
    }

    const normalizedLabel = sanitizeDisplayText(activity.label) || 'Thinking'
    const incomingDetails = activity.details
      .map((line) => sanitizeDisplayText(line))
      .filter((line) => line.length > 0 && line !== normalizedLabel)
    const mergedDetails = Array.from(new Set([...(previous?.details ?? []), ...incomingDetails])).slice(-3)
    const nextActivity: TurnActivityState = {
      label: normalizedLabel,
      details: mergedDetails,
    }

    if (areTurnActivitiesEqual(previous, nextActivity)) return
    turnActivityByThreadId.value = {
      ...turnActivityByThreadId.value,
      [threadId]: nextActivity,
    }
  }

  function setTurnErrorForThread(
    threadId: string,
    message: string | null,
    options: { transient?: boolean } = {},
  ): void {
    if (!threadId) return

    const previous = turnErrorByThreadId.value[threadId]
    const normalizedMessage = message ? normalizeMessageText(message) : ''
    if (!normalizedMessage) {
      if (previous) {
        turnErrorByThreadId.value = omitKey(turnErrorByThreadId.value, threadId)
      }
      return
    }

    const transient = options.transient === true
    if (previous?.message === normalizedMessage && previous.transient === transient) return

    turnErrorByThreadId.value = {
      ...turnErrorByThreadId.value,
      [threadId]: { message: normalizedMessage, transient },
    }
  }

  function clearTransientTurnErrorForThread(threadId: string): void {
    if (!threadId) return
    if (!turnErrorByThreadId.value[threadId]?.transient) return
    setTurnErrorForThread(threadId, null)
  }

  function clearAllTransientTurnErrors(): void {
    const transientThreadIds = Object.entries(turnErrorByThreadId.value)
      .filter(([, state]) => state?.transient)
      .map(([threadId]) => threadId)
    if (transientThreadIds.length === 0) return

    let nextState = turnErrorByThreadId.value
    for (const threadId of transientThreadIds) {
      nextState = omitKey(nextState, threadId)
    }
    turnErrorByThreadId.value = nextState
  }

  function currentThreadVersion(threadId: string): string {
    const thread = flattenThreads(sourceGroups.value).find((row) => row.id === threadId)
    return thread?.updatedAtIso ?? ''
  }

  function setThreadTerminalOpen(threadId: string, isOpen: boolean): void {
    if (!threadId) return
    const next = { ...terminalOpenByThreadId.value }
    if (isOpen) {
      next[threadId] = true
    } else {
      delete next[threadId]
    }
    terminalOpenByThreadId.value = next
    saveThreadTerminalOpenMap(next)
  }

  function toggleSelectedThreadTerminal(): void {
    const threadId = selectedThreadId.value
    if (!threadId) return
    setThreadTerminalOpen(threadId, !selectedThreadTerminalOpen.value)
  }

  function setPersistedMessagesForThread(threadId: string, nextMessages: UiMessage[]): void {
    conversationDeliveries.observe(threadId, nextMessages)
    const failedCompactionTurns = new Set(nextMessages.filter(message => message.compaction?.status === 'failed' && message.id === `${message.turnId}-compaction`).map(message => message.turnId))
    if (failedCompactionTurns.size) nextMessages = nextMessages.filter(message => !failedCompactionTurns.has(message.turnId)
      || (message.messageType !== 'turnError' && (message.compaction?.status !== 'failed' || message.id === `${message.turnId}-compaction`)))
    nextMessages = bindMessageTurnOrder(nextMessages, turnIndexByTurnIdByThreadId.value[threadId] ?? {})
    const previous = persistedMessagesByThreadId.value[threadId] ?? []
    if (areMessageArraysEqual(previous, nextMessages)) return
    persistedMessagesByThreadId.value = {
      ...persistedMessagesByThreadId.value,
      [threadId]: nextMessages,
    }
  }

  function appendOptimisticUserMessage(
    threadId: string,
    text: string,
    imageUrls: string[] = [],
    skills: Array<{ name: string; path: string }> = [],
    fileAttachments: FileAttachment[] = [],
    delivery?: { id: string; turnId: string; userMessageOrdinal?: number },
  ): void {
    const existing = persistedMessagesByThreadId.value[threadId] ?? []
    const nextMessage: UiMessage = {
      id: delivery ? `optimistic-user:${delivery.id}` : `optimistic-user:${threadId}:${Date.now()}`,
      turnId: delivery?.turnId,
      clientUserMessageId: delivery?.id,
      userMessageOrdinal: delivery?.userMessageOrdinal,
      role: 'user',
      ...readQuestionReply(text),
      images: imageUrls.length > 0 ? [...imageUrls] : undefined,
      skills: skills.length > 0 ? skills.map((skill) => ({ name: skill.name, path: skill.path })) : undefined,
      fileAttachments: fileAttachments.length > 0 ? fileAttachments.map((file) => ({ ...file })) : undefined,
      messageType: 'userMessage.optimistic',
    }
    if (!hasEquivalentUserMessage(nextMessage, existing)) setPersistedMessagesForThread(threadId, [...existing.filter(message => message.id !== nextMessage.id), nextMessage])
  }

  function setLiveAgentMessagesForThread(threadId: string, nextMessages: UiMessage[]): void {
    const previous = liveAgentMessagesByThreadId.value[threadId] ?? []
    if (areMessageArraysEqual(previous, nextMessages)) return
    liveAgentMessagesByThreadId.value = {
      ...liveAgentMessagesByThreadId.value,
      [threadId]: nextMessages,
    }
  }

  function clearLiveAgentMessagesForThread(threadId: string): void {
    if (!threadId) return
    if (!(threadId in liveAgentMessagesByThreadId.value)) return
    liveAgentMessagesByThreadId.value = omitKey(liveAgentMessagesByThreadId.value, threadId)
  }

  function setLiveFileChangeMessagesForThread(threadId: string, nextMessages: UiMessage[]): void {
    const previous = liveFileChangeMessagesByThreadId.value[threadId] ?? []
    if (areMessageArraysEqual(previous, nextMessages)) return
    liveFileChangeMessagesByThreadId.value = {
      ...liveFileChangeMessagesByThreadId.value,
      [threadId]: nextMessages,
    }
  }

  function setLivePlanMessagesForThread(threadId: string, nextMessages: UiMessage[]): void {
    const previous = livePlanMessagesByThreadId.value[threadId] ?? []
    if (areMessageArraysEqual(previous, nextMessages)) return
    livePlanMessagesByThreadId.value = {
      ...livePlanMessagesByThreadId.value,
      [threadId]: nextMessages,
    }
  }

  function upsertLivePlanMessage(threadId: string, nextMessage: UiMessage): void {
    const previous = livePlanMessagesByThreadId.value[threadId] ?? []
    const next = upsertMessage(previous, nextMessage)
    setLivePlanMessagesForThread(threadId, next)
  }

  function upsertLiveAgentMessage(threadId: string, nextMessage: UiMessage): void {
    nextMessage = { ...nextMessage, turnId: nextMessage.turnId || activeTurnIdByThreadId.value[threadId] }
    const previous = liveAgentMessagesByThreadId.value[threadId] ?? []
    const next = upsertMessage(previous, nextMessage)
    setLiveAgentMessagesForThread(threadId, next)
  }

  function upsertLiveFileChangeMessage(threadId: string, nextMessage: UiMessage): void {
    const previous = liveFileChangeMessagesByThreadId.value[threadId] ?? []
    const next = upsertMessage(previous, nextMessage)
    setLiveFileChangeMessagesForThread(threadId, next)
  }

  function setLiveReasoningText(threadId: string, text: string): void {
    if (!threadId) return
    const normalized = text.trim()
    const previous = liveReasoningTextByThreadId.value[threadId] ?? ''
    if (normalized.length === 0) {
      if (!previous) return
      liveReasoningTextByThreadId.value = omitKey(liveReasoningTextByThreadId.value, threadId)
      return
    }
    if (previous === normalized) return
    liveReasoningTextByThreadId.value = {
      ...liveReasoningTextByThreadId.value,
      [threadId]: normalized,
    }
  }

  function appendLiveReasoningText(threadId: string, delta: string): void {
    if (!threadId) return
    const previous = liveReasoningTextByThreadId.value[threadId] ?? ''
    setLiveReasoningText(threadId, `${previous}${delta}`)
  }

  function clearLiveReasoningForThread(threadId: string): void {
    if (!threadId) return
    if (!(threadId in liveReasoningTextByThreadId.value)) return
    liveReasoningTextByThreadId.value = omitKey(liveReasoningTextByThreadId.value, threadId)
  }

  function clearLivePlansForThread(threadId: string): void {
    if (!threadId) return
    if (!(threadId in livePlanMessagesByThreadId.value)) return
    livePlanMessagesByThreadId.value = omitKey(livePlanMessagesByThreadId.value, threadId)
  }

  function clearLiveFileChangesForThread(threadId: string): void {
    if (!threadId) return
    if (!(threadId in liveFileChangeMessagesByThreadId.value)) return
    liveFileChangeMessagesByThreadId.value = omitKey(liveFileChangeMessagesByThreadId.value, threadId)
  }

  function clearCompletedTurnLiveState(threadId: string): void {
    if (!threadId) return
    clearLivePlansForThread(threadId)
    clearLiveReasoningForThread(threadId)
    setTurnActivityForThread(threadId, null)
    if (threadId === selectedThreadId.value) {
      activeReasoningItemId = ''
    }
    if (liveCommandsByThreadId.value[threadId]) {
      liveCommandsByThreadId.value = omitKey(liveCommandsByThreadId.value, threadId)
    }
    if (activeTurnIdByThreadId.value[threadId]) {
      activeTurnIdByThreadId.value = omitKey(activeTurnIdByThreadId.value, threadId)
    }
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
    const existing = (livePlanMessagesByThreadId.value[threadId] ?? []).find((message) => message.id === messageId)
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

  function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  }

  function readString(value: unknown): string {
    return typeof value === 'string' ? value : ''
  }

  function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }

  function getRateLimitSnapshotKey(snapshot: UiRateLimitSnapshot): string {
    return snapshot.limitId?.trim() || snapshot.limitName?.trim() || '__default__'
  }

  function normalizeRateLimitWindow(value: unknown): UiRateLimitSnapshot['primary'] {
    const record = asRecord(value)
    if (!record) return null

    const windowValue = readNumber(record.windowDurationMins)
    return {
      usedPercent: clamp(readNumber(record.usedPercent) ?? 0, 0, 100),
      windowDurationMins: windowValue,
      windowMinutes: windowValue,
      resetsAt: readNumber(record.resetsAt),
    }
  }

  function normalizeRateLimitSnapshot(value: unknown): UiRateLimitSnapshot | null {
    const record = asRecord(value)
    if (!record) return null

    const credits = asRecord(record.credits)
    return {
      limitId: readString(record.limitId) || null,
      limitName: readString(record.limitName) || null,
      primary: normalizeRateLimitWindow(record.primary),
      secondary: normalizeRateLimitWindow(record.secondary),
      credits: credits
        ? {
            hasCredits: credits.hasCredits === true,
            unlimited: credits.unlimited === true,
            balance: readString(credits.balance) || null,
          }
        : null,
      planType: readString(record.planType) || null,
    }
  }

  function normalizeRateLimitSnapshotsPayload(value: unknown): UiRateLimitSnapshot[] {
    const record = asRecord(value)
    if (!record) return []

    const next: UiRateLimitSnapshot[] = []
    const seen = new Set<string>()
    const pushSnapshot = (snapshot: UiRateLimitSnapshot | null): void => {
      if (!snapshot) return
      const key = getRateLimitSnapshotKey(snapshot)
      if (seen.has(key)) return
      seen.add(key)
      next.push(snapshot)
    }

    pushSnapshot(normalizeRateLimitSnapshot(record.rateLimits))

    const byLimitId = asRecord(record.rateLimitsByLimitId)
    if (byLimitId) {
      for (const snapshot of Object.values(byLimitId)) {
        pushSnapshot(normalizeRateLimitSnapshot(snapshot))
      }
    }

    return next
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

  function extractThreadIdFromNotification(notification: RpcNotification): string {
    const params = asRecord(notification.params)
    if (!params) return ''

    const directThreadId = readString(params.threadId)
    if (directThreadId) return directThreadId
    const snakeThreadId = readString(params.thread_id)
    if (snakeThreadId) return snakeThreadId

    const conversationId = readString(params.conversationId)
    if (conversationId) return conversationId
    const snakeConversationId = readString(params.conversation_id)
    if (snakeConversationId) return snakeConversationId

    const thread = asRecord(params.thread)
    const nestedThreadId = readString(thread?.id)
    if (nestedThreadId) return nestedThreadId

    const turn = asRecord(params.turn)
    const turnThreadId = readString(turn?.threadId)
    if (turnThreadId) return turnThreadId
    const turnSnakeThreadId = readString(turn?.thread_id)
    if (turnSnakeThreadId) return turnSnakeThreadId

    return ''
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

  function normalizeServerRequest(params: unknown): UiServerRequest | null {
    const row = asRecord(params)
    if (!row) return null

    const id = row.id
    const rawMethod = readString(row.method)
    const requestParams = row.params
    if (typeof id !== 'number' || !Number.isInteger(id) || !rawMethod) {
      return null
    }

    const requestParamRecord = asRecord(requestParams)
    const method = normalizePendingServerRequestMethod(rawMethod, requestParamRecord)
    const threadId = (
      readString(requestParamRecord?.threadId) ||
      readString(requestParamRecord?.thread_id) ||
      readString(requestParamRecord?.conversationId) ||
      readString(requestParamRecord?.conversation_id) ||
      GLOBAL_SERVER_REQUEST_SCOPE
    )
    const turnId = readString(requestParamRecord?.turnId) || readString(requestParamRecord?.turn_id)
    const itemId = (
      readString(requestParamRecord?.itemId) ||
      readString(requestParamRecord?.item_id) ||
      readString(requestParamRecord?.callId) ||
      readString(requestParamRecord?.call_id)
    )
    const receivedAtIso = readString(row.receivedAtIso) || new Date().toISOString()

    return {
      id,
      method,
      threadId,
      turnId,
      itemId,
      receivedAtIso,
      params: requestParams ?? null,
    }
  }

  function normalizePendingServerRequestMethod(
    method: string,
    params: Record<string, unknown> | null,
  ): string {
    const normalized = method.trim()
    if (!normalized) return normalized

    if (
      normalized === 'item/commandExecution/requestApproval' ||
      normalized === 'execCommandApproval' ||
      normalized === 'exec_approval_request' ||
      looksLikeExecApprovalRequest(params)
    ) {
      return 'item/commandExecution/requestApproval'
    }

    if (
      normalized === 'item/fileChange/requestApproval' ||
      normalized === 'applyPatchApproval' ||
      normalized === 'apply_patch_approval_request' ||
      looksLikePatchApprovalRequest(params)
    ) {
      return 'item/fileChange/requestApproval'
    }

    if (
      normalized === 'item/tool/requestUserInput' ||
      normalized === 'request_user_input' ||
      looksLikeToolUserInputRequest(params)
    ) {
      return 'item/tool/requestUserInput'
    }

    if (
      normalized === 'mcpServer/elicitation/request' ||
      normalized === 'elicitation_request' ||
      looksLikeMcpServerElicitationRequest(params)
    ) {
      return 'mcpServer/elicitation/request'
    }

    if (normalized === 'item/permissions/requestApproval' || looksLikePermissionsApprovalRequest(params)) {
      return 'item/permissions/requestApproval'
    }

    if (
      normalized === 'item/tool/call' ||
      normalized === 'dynamic_tool_call_request' ||
      looksLikeToolCallRequest(params)
    ) {
      return 'item/tool/call'
    }

    return normalized
  }

  function looksLikeExecApprovalRequest(params: Record<string, unknown> | null): boolean {
    if (!params) return false
    const command = params.command
    if (Array.isArray(command) && command.some((part) => typeof part === 'string' && part.trim().length > 0)) {
      return true
    }
    if (typeof command === 'string' && command.trim().length > 0) {
      return true
    }
    return Array.isArray(params.commandActions)
  }

  function looksLikePatchApprovalRequest(params: Record<string, unknown> | null): boolean {
    if (!params) return false
    if (typeof params.grantRoot === 'string' && params.grantRoot.trim().length > 0) return true
    if (typeof params.grant_root === 'string' && params.grant_root.trim().length > 0) return true
    if (asRecord(params.fileChanges)) return true
    return asRecord(params.changes) !== null
  }

  function looksLikeToolUserInputRequest(params: Record<string, unknown> | null): boolean {
    return Boolean(params && Array.isArray(params.questions))
  }

  function looksLikeToolCallRequest(params: Record<string, unknown> | null): boolean {
    if (!params) return false
    return (
      typeof params.toolName === 'string' ||
      typeof params.tool_name === 'string' ||
      typeof params.name === 'string' ||
      Array.isArray(params.arguments)
    )
  }

  function looksLikeMcpServerElicitationRequest(params: Record<string, unknown> | null): boolean {
    if (!params) return false
    const mode = readString(params.mode)
    return (
      typeof params.serverName === 'string' &&
      typeof params.threadId === 'string' &&
      typeof params.message === 'string' &&
      (mode === 'form' || mode === 'url')
    )
  }

  function looksLikePermissionsApprovalRequest(params: Record<string, unknown> | null): boolean {
    if (!params) return false
    return (
      typeof params.threadId === 'string' &&
      typeof params.turnId === 'string' &&
      typeof params.itemId === 'string' &&
      asRecord(params.permissions) !== null
    )
  }

  function upsertPendingServerRequest(request: UiServerRequest): void {
    pendingSnapshot?.requests.set(request.id, request)
    const threadId = request.threadId || GLOBAL_SERVER_REQUEST_SCOPE
    const current = pendingServerRequestsByThreadId.value[threadId] ?? []
    const index = current.findIndex((row) => row.id === request.id)
    const nextRows = [...current]
    if (index >= 0) {
      nextRows.splice(index, 1, request)
    } else {
      nextRows.push(request)
    }

    pendingServerRequestsByThreadId.value = {
      ...pendingServerRequestsByThreadId.value,
      [threadId]: nextRows.sort((first, second) => first.receivedAtIso.localeCompare(second.receivedAtIso)),
    }
    applyThreadFlags()
  }

  function removePendingServerRequestById(requestId: number): void {
    pendingSnapshot?.requests.set(requestId, null)
    const next: Record<string, UiServerRequest[]> = {}
    for (const [threadId, requests] of Object.entries(pendingServerRequestsByThreadId.value)) {
      const filtered = requests.filter((request) => request.id !== requestId)
      if (filtered.length > 0) {
        next[threadId] = filtered
      }
    }
    pendingServerRequestsByThreadId.value = next
    applyThreadFlags()
  }

  function replacePendingServerRequests(requests: UiServerRequest[]): void {
    const next: Record<string, UiServerRequest[]> = {}
    for (const request of requests) {
      const threadId = request.threadId || GLOBAL_SERVER_REQUEST_SCOPE
      const current = next[threadId] ?? []
      current.push(request)
      next[threadId] = current
    }

    for (const rows of Object.values(next)) {
      rows.sort((first, second) => first.receivedAtIso.localeCompare(second.receivedAtIso))
    }

    pendingServerRequestsByThreadId.value = next
  }

  function handleServerRequestNotification(notification: RpcNotification): boolean {
    if (notification.method === 'server/request') {
      const request = normalizeServerRequest(notification.params)
      if (!request) return true
      upsertPendingServerRequest(request)
      return true
    }

    if (notification.method === 'server/request/resolved') {
      const row = asRecord(notification.params)
      const id = row?.id
      if (typeof id === 'number' && Number.isInteger(id)) {
        removePendingServerRequestById(id)
      }
      return true
    }

    return false
  }

  function sanitizeDisplayText(value: string): string {
    return value.replace(/\s+/gu, ' ').trim()
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

  function readTurnStartedInfo(notification: RpcNotification): TurnStartedInfo | null {
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

  function inferNextTurnIndex(threadId: string): number {
    const persisted = persistedMessagesByThreadId.value[threadId] ?? []
    let maxTurnIndex = Math.max(-1, ...Object.values(turnIndexByTurnIdByThreadId.value[threadId] ?? {}))
    for (const message of persisted) {
      if (typeof message.turnIndex === 'number' && Number.isFinite(message.turnIndex)) {
        maxTurnIndex = Math.max(maxTurnIndex, message.turnIndex)
      }
    }
    return maxTurnIndex + 1
  }

  function setTurnIndexForThread(threadId: string, turnId: string, turnIndex: number): void {
    if (!threadId || !turnId || !Number.isInteger(turnIndex) || turnIndex < 0) return
    const previous = turnIndexByTurnIdByThreadId.value[threadId] ?? {}
    if (previous[turnId] === turnIndex) return
    turnIndexByTurnIdByThreadId.value = {
      ...turnIndexByTurnIdByThreadId.value,
      [threadId]: {
        ...previous,
        [turnId]: turnIndex,
      },
    }
  }

  function replaceTurnIndexLookupForThread(threadId: string, nextLookup: Record<string, number>): void {
    const previous = turnIndexByTurnIdByThreadId.value[threadId] ?? {}
    const previousEntries = Object.entries(previous)
    const nextEntries = Object.entries(nextLookup)
    if (
      previousEntries.length === nextEntries.length
      && previousEntries.every(([turnId, turnIndex]) => nextLookup[turnId] === turnIndex)
    ) {
      return
    }

    turnIndexByTurnIdByThreadId.value = {
      ...turnIndexByTurnIdByThreadId.value,
      [threadId]: { ...nextLookup },
    }
  }

  function rebindLiveFileChangeTurnIndices(threadId: string): void {
    const current = liveFileChangeMessagesByThreadId.value[threadId]
    if (!current || current.length === 0) return

    const turnIndexByTurnId = turnIndexByTurnIdByThreadId.value[threadId] ?? {}
    let changed = false
    const next = current.map((message) => {
      if (!message.turnId) {
        return message
      }
      const turnIndex = turnIndexByTurnId[message.turnId]
      if (typeof turnIndex !== 'number' || turnIndex === message.turnIndex) return message
      changed = true
      return { ...message, turnIndex }
    })

    if (!changed) return
    liveFileChangeMessagesByThreadId.value = {
      ...liveFileChangeMessagesByThreadId.value,
      [threadId]: next,
    }
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
    const turnIndex = threadId && turnId
      ? turnIndexByTurnIdByThreadId.value[threadId]?.[turnId]
      : undefined
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
    const turnIndex = threadId && turnId
      ? turnIndexByTurnIdByThreadId.value[threadId]?.[turnId]
      : undefined
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
    const turnIndex = threadId && turnId
      ? turnIndexByTurnIdByThreadId.value[threadId]?.[turnId]
      : undefined

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

  function upsertLiveCommand(threadId: string, msg: UiMessage): void {
    const previous = liveCommandsByThreadId.value[threadId] ?? []
    const next = upsertMessage(previous, msg)
    if (next === previous) return
    liveCommandsByThreadId.value = { ...liveCommandsByThreadId.value, [threadId]: next }
  }

  function removeLiveCommandsPersistedIn(threadId: string, persistedMessages: UiMessage[]): void {
    const current = liveCommandsByThreadId.value[threadId]
    if (!current || current.length === 0) return
    const persistedIds = new Set(persistedMessages.map((m) => m.id))
    const next = current.filter((m) => !persistedIds.has(m.id))
    if (next.length === current.length) return
    if (next.length === 0) {
      liveCommandsByThreadId.value = omitKey(liveCommandsByThreadId.value, threadId)
    } else {
      liveCommandsByThreadId.value = { ...liveCommandsByThreadId.value, [threadId]: next }
    }
  }

  function removeLiveFileChangesPersistedIn(threadId: string, persistedMessages: UiMessage[]): void {
    const current = liveFileChangeMessagesByThreadId.value[threadId]
    if (!current || current.length === 0) return
    const persistedIds = new Set(persistedMessages.map((message) => message.id))
    const persistedTurnIds = new Set(
      persistedMessages
        .filter((message) => message.messageType === 'fileChange' && typeof message.turnId === 'string' && message.turnId.length > 0)
        .map((message) => message.turnId as string),
    )
    const persistedTurnIndices = new Set(
      persistedMessages
        .filter((message) => message.messageType === 'fileChange' && typeof message.turnIndex === 'number')
        .map((message) => message.turnIndex as number),
    )
    const next = current.filter((message) => (
      !persistedIds.has(message.id)
      && !(message.turnId && persistedTurnIds.has(message.turnId))
      && !(typeof message.turnIndex === 'number' && persistedTurnIndices.has(message.turnIndex))
    ))
    if (next.length === current.length) return
    if (next.length === 0) {
      liveFileChangeMessagesByThreadId.value = omitKey(liveFileChangeMessagesByThreadId.value, threadId)
    } else {
      liveFileChangeMessagesByThreadId.value = { ...liveFileChangeMessagesByThreadId.value, [threadId]: next }
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
      const updated = updateCompactionMessages(persistedMessagesByThreadId.value[compactionThreadId] ?? [], notification.method, notification.params)
      if (updated) setPersistedMessagesForThread(compactionThreadId, updated)
    }
    if (changesThreadSearch(notification.method)) threadSearchVersion.value += 1
    if (notification.method === 'item/started' || notification.method === 'item/completed') {
      const params = asRecord(notification.params)
      const item = asRecord(params?.item)
      const threadId = readString(params?.threadId)
      const turnId = readString(params?.turnId) || activeTurnIdByThreadId.value[threadId]
      if (item?.type === 'userMessage' && threadId && turnId) {
        const normalized = normalizeThreadMessagesV2({ thread: { turns: [{ id: turnId, items: [item] }] } } as Parameters<typeof normalizeThreadMessagesV2>[0])
          .map(message => ({ ...message, historyOrdinal: undefined, userMessageOrdinal: undefined }))
        setPersistedMessagesForThread(threadId, mergeMessages(persistedMessagesByThreadId.value[threadId] || [], normalized, { preserveMissing: true }))
      }
    }
    if (notification.method === 'item/started' || notification.method === 'item/completed') {
      const params = asRecord(notification.params)
      const threadId = readString(params?.threadId)
      const summary = normalizeToolSummary(params?.item)
      if (threadId && summary) {
        const messages = persistedMessagesByThreadId.value[threadId] || []
        const next = { ...summary, turnId: readString(params?.turnId) || undefined }
        const index = messages.findIndex(message => message.id === summary.id)
        setPersistedMessagesForThread(threadId, index < 0 ? [...messages, next] : messages.map((message, offset) => offset === index ? mergeSubtaskMessage(message, next) : message))
      }
    }
    if (['account/updated', 'model/list/updated', 'models/updated', 'config/updated'].includes(notification.method)) {
      invalidateModelCatalog()
      void refreshModelPreferences()
    }
    const authRecovery = authRecoveryFromNotification(notification.method, notification.params)
    if (authRecovery) {
      pendingSnapshot?.auth.set(authRecovery.threadId, authRecovery)
      const states = { ...authRecoveryByThreadId.value, [authRecovery.threadId]: authRecovery }
      const ids = Object.keys(states)
      if (ids.length > 100) delete states[ids[0]]
      authRecoveryByThreadId.value = states
      return
    }
    if (notification.method === 'turn/started' || notification.method === 'turn/completed' || notification.method === 'turn/cancelled') {
      const threadId = extractThreadIdFromNotification(notification)
      if (threadId) {
        pendingSnapshot?.auth.set(threadId, null)
        authRecoveryByThreadId.value = omitKey(authRecoveryByThreadId.value, threadId)
      }
    }
    if (notification.method === 'model/rerouted') {
      const params = asRecord(notification.params)
      const threadId = readString(params?.threadId)
      const model = readString(params?.toModel)
      if (threadId && model) {
        reportedModelByThreadId.value = { ...reportedModelByThreadId.value, [threadId]: model }
        setTurnActivityForThread(threadId, { label: '实际执行模型已变更', details: [model] })
        setPersistedMessagesForThread(threadId, [...(persistedMessagesByThreadId.value[threadId] || []).filter(message => message.id !== `model-rerouted-${params?.turnId}`), { id: `model-rerouted-${params?.turnId}`, role: 'system', text: `实际执行模型：${model}`, messageType: 'modelRerouted', turnId: readString(params?.turnId) || undefined }])
      }
    }
    if (handleServerRequestNotification(notification)) {
      return
    }

    if (notification.method === 'account/updated' || notification.method === 'account/login/completed') {
      rateLimitUpdateRevision += 1
      scheduleRateLimitRefresh()
    }

    if (notification.method === 'thread/name/updated') {
      const params = asRecord(notification.params)
      const threadId = readString(params?.threadId)
      const threadName = readString(params?.threadName)
      if (threadId && threadName) {
        threadTitleById.value = { ...threadTitleById.value, [threadId]: threadName }
        applyThreadFlags()
        void persistThreadTitle(threadId, threadName)
      }
    }

    if (notification.method === 'account/rateLimits/updated') {
      rateLimitUpdateRevision += 1
      setCodexRateLimit(pickCodexRateLimitSnapshot({ rateLimits: mergeQuotaUpdate(codexRateLimit.value, notification.params) }))
      accountRateLimitSnapshots.value = codexRateLimit.value ? [codexRateLimit.value] : []
      return
    }

    const tokenUsageUpdate = readThreadTokenUsageUpdate(notification)
    if (tokenUsageUpdate) {
      setThreadTokenUsage(tokenUsageUpdate.threadId, tokenUsageUpdate.usage)
      return
    }

    if (notification.method === 'thread/status/changed') {
      const params = asRecord(notification.params)
      const threadId = extractThreadIdFromNotification(notification)
      const status = readString(asRecord(params?.status)?.type) || readString(params?.status)
      if (threadId && ['active', 'inProgress', 'running', 'idle', 'notLoaded', 'systemError'].includes(status)) {
        const running = ['active', 'inProgress', 'running'].includes(status)
        setThreadInProgress(threadId, running)
      }
    }
    const turnActivity = readTurnActivity(notification)
    if (turnActivity) {
      setTurnActivityForThread(turnActivity.threadId, turnActivity.activity)
    }

    const notificationThreadId = extractThreadIdFromNotification(notification)
    const notificationErrorState = readNotificationErrorState(notification)
    if (!notificationErrorState && notificationThreadId) {
      clearTransientTurnErrorForThread(notificationThreadId)
    }

    const startedTurn = readTurnStartedInfo(notification)
    if (startedTurn && finishedTurns.has(turnKey(startedTurn.threadId, startedTurn.turnId))) return
    if (startedTurn) {
      pendingTurnStartsById.set(startedTurn.turnId, startedTurn)
      setTurnIndexForThread(startedTurn.threadId, startedTurn.turnId, inferNextTurnIndex(startedTurn.threadId))
      activeTurnIdByThreadId.value = {
        ...activeTurnIdByThreadId.value,
        [startedTurn.threadId]: startedTurn.turnId,
      }
      maybeUnblockInterruptForActiveTurn(startedTurn.threadId, startedTurn.turnId)
      clearLivePlansForThread(startedTurn.threadId)
      clearLiveFileChangesForThread(startedTurn.threadId)
      setTurnSummaryForThread(startedTurn.threadId, null)
      setTurnErrorForThread(startedTurn.threadId, null)
      setThreadInProgress(startedTurn.threadId, true)
      scheduleQueueStateRefresh(startedTurn.threadId)

    }

    const completedTurn = readTurnCompletedInfo(notification)
    const turnErrorMessage = readTurnErrorMessage(notification)
    if (completedTurn) {
      rememberFinishedTurn(completedTurn.threadId, completedTurn.turnId)
      const activeTurn = activeTurnIdByThreadId.value[completedTurn.threadId]
      if (activeTurn && activeTurn !== completedTurn.turnId) return
      const startedTurnState = pendingTurnStartsById.get(completedTurn.turnId)
      if (startedTurnState) {
        pendingTurnStartsById.delete(completedTurn.turnId)
      }

      const rawDurationMs =
        readNumber(asRecord(notification.params)?.durationMs) ??
        readNumber(asRecord(asRecord(notification.params)?.turn)?.durationMs) ??
        (typeof completedTurn.startedAtMs === 'number'
          ? completedTurn.completedAtMs - completedTurn.startedAtMs
          : null) ??
        (startedTurnState ? completedTurn.completedAtMs - startedTurnState.startedAtMs : null)

      const durationMs = typeof rawDurationMs === 'number' ? Math.max(0, rawDurationMs) : 0
      setTurnSummaryForThread(completedTurn.threadId, {
        turnId: completedTurn.turnId,
        durationMs,
      })
      if (activeTurnIdByThreadId.value[completedTurn.threadId]) {
        activeTurnIdByThreadId.value = omitKey(activeTurnIdByThreadId.value, completedTurn.threadId)
      }
      setThreadInProgress(completedTurn.threadId, false)
      setTurnActivityForThread(completedTurn.threadId, null)
      scheduleQueueStateRefresh(completedTurn.threadId)
    }

    if (turnErrorMessage) {
      const failedThreadId = completedTurn?.threadId || extractThreadIdFromNotification(notification)
      if (failedThreadId) {
        setTurnErrorForThread(failedThreadId, turnErrorMessage)
      }
      error.value = turnErrorMessage

    } else if (completedTurn) {
      setTurnErrorForThread(completedTurn.threadId, null)
    }

    if (notificationErrorState) {
      const errorThreadId = notificationThreadId
      if (errorThreadId) {
        setTurnErrorForThread(errorThreadId, notificationErrorState.message, {
          transient: notificationErrorState.transient,
        })
      }
      error.value = notificationErrorState.message

    }

    const planUpdate = readPlanUpdate(notification)
    if (planUpdate) {
      upsertLivePlanMessage(planUpdate.threadId, planUpdate.message)
      setTurnActivityForThread(planUpdate.threadId, {
        label: 'Planning',
        details: planUpdate.message.plan?.steps.map((step) => step.step).slice(0, 2) ?? [],
      })
    }

    const planDelta = readPlanDelta(notification)
    if (planDelta) {
      upsertLivePlanMessage(planDelta.threadId, planDelta.message)
      setTurnActivityForThread(planDelta.threadId, {
        label: 'Planning',
        details: [],
      })
    }

    if (!notificationThreadId || notificationThreadId !== selectedThreadId.value) return

    const startedAgentMessageId = readAgentMessageStartedId(notification)
    if (startedAgentMessageId) {
      activeReasoningItemId = ''
    }

    const liveAgentMessageDelta = readAgentMessageDelta(notification)
    if (liveAgentMessageDelta) {
      const existing = (liveAgentMessagesByThreadId.value[notificationThreadId] ?? [])
        .find((message) => message.id === liveAgentMessageDelta.messageId)
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
      const current = liveReasoningTextByThreadId.value[notificationThreadId] ?? ''
      if (current.trim().length > 0 && !current.endsWith('\n\n')) {
        setLiveReasoningText(notificationThreadId, `${current}\n\n`)
      }
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
      setTurnActivityForThread(notificationThreadId, { label: 'Running command', details: [commandStarted.commandExecution?.command ?? ''] })
    }

    const commandDelta = readCommandOutputDelta(notification)
    if (commandDelta) {
      const current = (liveCommandsByThreadId.value[notificationThreadId] ?? []).find((m) => m.id === commandDelta.itemId)
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
      shouldAutoScrollOnNextAgentEvent = false
      clearLiveReasoningForThread(notificationThreadId)
      if (liveCommandsByThreadId.value[notificationThreadId]) {
        liveCommandsByThreadId.value = omitKey(liveCommandsByThreadId.value, notificationThreadId)
      }
      const completedThreadId = extractThreadIdFromNotification(notification)
      if (completedThreadId) {
        clearDelayedTurnSync(completedThreadId)

      }
    }

  }

  function queueEventDrivenSync(notification: RpcNotification): void {
    if (notification.method === 'thread/tokenUsage/updated' || notification.method.startsWith('thread/goal/')) return

    const method = notification.method
    const shouldRefreshMessages =
      method === 'turn/started' ||
      method === 'turn/completed' ||
      method === 'turn/cancelled' ||
      method === 'thread/status/changed' ||
      method === 'error'
    const shouldRefreshThreads =
      method.startsWith('thread/') ||
      method === 'turn/completed'

    if (!shouldRefreshMessages && !shouldRefreshThreads) return

    const threadId = extractThreadIdFromNotification(notification)
    if (threadId && shouldRefreshMessages) {
      markThreadHistoryDirty(threadId)
    }

    if (shouldRefreshThreads) {
      pendingThreadsRefresh = true
      pendingThreadsRefreshForce = true
    }

    if (eventSyncTimer !== null || typeof window === 'undefined') return
    eventSyncTimer = window.setTimeout(() => {
      eventSyncTimer = null
      void syncFromNotifications()
    }, EVENT_SYNC_DEBOUNCE_MS)
  }

  async function hydrateWorkspaceRootsStateIfNeeded(
    groups: UiProjectGroup[],
    rootsState: WorkspaceRootsState | null,
  ): Promise<void> {
    if (hasHydratedWorkspaceRootsState) return
    hasHydratedWorkspaceRootsState = true

    try {
      if (!rootsState) return
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

  async function loadThreadTitleCacheIfNeeded(options: { force?: boolean } = {}): Promise<void> {
    if (options.force !== true && Object.keys(threadTitleById.value).length > 0) return
    try {
      const cache = await getThreadTitleCache()
      if (Object.keys(cache.titles).length > 0) {
        threadTitleById.value = cache.titles
      }
    } catch {
      // Title cache is optional; keep UI functional.
    }
  }

  async function loadWorkspaceRootsStateForThreadList(): Promise<WorkspaceRootsState | null> {
    try {
      return await getWorkspaceRootsState()
    } catch {
      return null
    }
  }

  async function requestThreadTitleGeneration(threadId: string, prompt: string, cwd: string | null): Promise<void> {
    if (threadTitleById.value[threadId]) return
    const trimmed = prompt.trim()
    if (!trimmed) return
    const truncated = trimmed.length > 300 ? trimmed.slice(0, 300) : trimmed
    try {
      const title = await generateThreadTitle(truncated, cwd)
      if (!title || threadTitleById.value[threadId]) return
      threadTitleById.value = { ...threadTitleById.value, [threadId]: title }
      applyThreadFlags()
      void persistThreadTitle(threadId, title)
    } catch {
      // Title generation is best-effort.
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
    markServerListedThreads(listedIds)
    const mergedWithInProgress = mergeIncomingWithLocalInProgressThreads(
      sourceGroups.value,
      orderedGroups,
      inProgressById.value,
      pendingListedThreadIds,
    )
    sourceGroups.value = mergeThreadGroups(sourceGroups.value, mergedWithInProgress)
    inProgressById.value = pruneThreadStateMap(
      inProgressById.value,
      new Set(flattenThreads(sourceGroups.value).map((thread) => thread.id)),
    )
    applyThreadFlags()
  }

  let queueMutationChain: Promise<unknown> = Promise.resolve()
  let queueRequestGeneration = 0
  const deliveryReceiptReads = new Map<string, Promise<void>>()

  function refreshVisibleDeliveryReceipts(threadId = selectedThreadId.value): Promise<void> {
    if (!threadId) return Promise.resolve()
    const pending = deliveryReceiptReads.get(threadId)
    if (pending) return pending
    const queuedIds = new Set((queuedMessagesByThreadId.value[threadId] ?? []).map(row => row.id))
    const ids = conversationDeliveries.rows.value.filter(row => row.threadId === threadId
      && !['accepted', 'cancelled', 'submitting'].includes(row.status) && !queuedIds.has(row.id)
      && /^[a-zA-Z0-9_-]{1,160}$/.test(row.id)).map(row => row.id).slice(0, 100)
    if (!ids.length) return Promise.resolve()
    const request = (async () => {
      try {
        const receipts = await getDeliveryStatuses(threadId, ids)
        for (const receipt of receipts) conversationDeliveries.patch(receipt.id, receipt)
        if (receipts.some(receipt => receipt.status === 'accepted')) {
          conversationDeliveries.observe(threadId, persistedMessagesByThreadId.value[threadId] ?? [])
          markThreadHistoryDirty(threadId)
          scheduleDelayedTurnSync(threadId)
        }
      } catch { /* A failed read is not proof of cancellation or delivery. Keep the content visible. */ }
    })().finally(() => deliveryReceiptReads.delete(threadId))
    deliveryReceiptReads.set(threadId, request)
    return request
  }

  function commitQueueOperation(operation: ThreadQueueOperation): Promise<ThreadQueueResult> {
    queueRequestGeneration += 1
    const pending = queueMutationChain.then(async () => {
      try {
        const result = await mutateThreadQueueState(operation)
        queuedMessagesByThreadId.value = result.state
        conversationDeliveries.syncQueue(result.state)
        if (result.removed) conversationDeliveries.patch(result.removed.id, { status: 'cancelled' })
        void refreshVisibleDeliveryReceipts(operation.threadId)
        queueErrorByThreadId.value = omitKey(queueErrorByThreadId.value, operation.threadId)
        return result
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : '队列保存失败，请重试'
        queueErrorByThreadId.value = { ...queueErrorByThreadId.value, [operation.threadId]: error.value }
        if (selectedThreadId.value === operation.threadId) notifyOperation(error.value, 'error', operation.threadId)
        throw cause
      }
    })
    queueMutationChain = pending.catch(() => {})
    return pending
  }

  async function refreshQueueState(): Promise<void> {
    const generation = ++queueRequestGeneration
    await queueMutationChain
    try {
      const state = await getThreadQueueState()
      if (generation === queueRequestGeneration) {
        queuedMessagesByThreadId.value = state
        conversationDeliveries.syncQueue(state)
        void refreshVisibleDeliveryReceipts()
        queueStateError.value = ''
      }
    } catch (cause) {
      queueStateError.value = cause instanceof Error ? cause.message : '无法读取发送队列'
      throw cause
    }
  }

  async function loadPersistedQueueStateIfNeeded(): Promise<void> {
    if (hasLoadedPersistedQueueState) return
    try {
      await refreshQueueState()
      hasLoadedPersistedQueueState = true
    } catch {
      // Retry at the next refresh; a temporary read failure must not erase queues.
    }
  }

  function removeArchivedThreadFromLoadedLists(threadId: string): void {
    pendingListedThreadIds.delete(threadId)
    loadedThreadListGroups = removeThreadFromGroups(loadedThreadListGroups, threadId)
    sourceGroups.value = removeThreadFromGroups(sourceGroups.value, threadId)
    inProgressById.value = omitKey(inProgressById.value, threadId)
    applyThreadFlags()
  }

  function mergeThreadGroupPages(previous: UiProjectGroup[], incoming: UiProjectGroup[]): UiProjectGroup[] {
    if (previous.length === 0) return incoming
    if (incoming.length === 0) return previous

    const threadById = new Map<string, UiThread>()
    for (const thread of flattenThreads(previous)) {
      threadById.set(thread.id, thread)
    }
    for (const thread of flattenThreads(incoming)) {
      threadById.set(thread.id, thread)
    }
    const groupsByProject = new Map<string, UiThread[]>()
    for (const thread of threadById.values()) {
      const existing = groupsByProject.get(thread.projectName)
      if (existing) existing.push(thread)
      else groupsByProject.set(thread.projectName, [thread])
    }

    return Array.from(groupsByProject.entries())
      .map(([projectName, threads]) => ({
        projectName,
        threads: threads.sort(
          (first, second) => new Date(second.updatedAtIso).getTime() - new Date(first.updatedAtIso).getTime(),
        ),
      }))
      .sort((first, second) => {
        const firstUpdated = new Date(first.threads[0]?.updatedAtIso ?? 0).getTime()
        const secondUpdated = new Date(second.threads[0]?.updatedAtIso ?? 0).getTime()
        return secondUpdated - firstUpdated
      })
  }

  function hasActiveInProgressThreads(): boolean {
    return Object.values(inProgressById.value).some((value) => value === true)
  }

  function scheduleRemainingThreadPages(rootsState: WorkspaceRootsState | null = loadedThreadListRootsState): void {
    if (!threadListNextCursor || isLoadingRemainingThreadPages || hasActiveInProgressThreads()) return

    loadedThreadListRootsState = rootsState

    if (typeof window === 'undefined') {
      void loadRemainingThreadPages(rootsState)
      return
    }

    if (threadListBackgroundTimer !== null) {
      window.clearTimeout(threadListBackgroundTimer)
    }

    threadListBackgroundTimer = window.setTimeout(() => {
      threadListBackgroundTimer = null
      if (!threadListNextCursor || hasActiveInProgressThreads()) return
      void loadRemainingThreadPages(loadedThreadListRootsState)
    }, BACKGROUND_THREAD_PAGINATION_DELAY_MS)
  }

  async function loadRemainingThreadPages(rootsState: WorkspaceRootsState | null): Promise<void> {
    if (isLoadingRemainingThreadPages || !threadListNextCursor || hasActiveInProgressThreads()) return
    isLoadingRemainingThreadPages = true

    try {
      const revisions = new Map(threadStatusRevision)
      const page = await getThreadGroupsPage(threadListNextCursor, getBackgroundThreadListLimit())
      applyListedStatuses(page.groups, revisions)
      threadListNextCursor = page.nextCursor
      hasLoadedAllThreadPages = page.nextCursor === null
      isThreadListFullyLoaded.value = hasLoadedAllThreadPages
      loadedThreadListGroups = mergeThreadGroupPages(loadedThreadListGroups, page.groups)
      applyThreadGroups(loadedThreadListGroups, rootsState)
    } catch {
      // Keep the first page usable; a later refresh can retry remaining pages.
    } finally {
      isLoadingRemainingThreadPages = false
      if (threadListNextCursor && !hasActiveInProgressThreads()) {
        scheduleRemainingThreadPages(rootsState)
      }
    }
  }

  async function loadThreads(options: { force?: boolean } = {}) {
    if (loadThreadsPromise) {
      await loadThreadsPromise
      return
    }
    if (
      options.force !== true &&
      hasLoadedThreads.value &&
      Date.now() - lastThreadListLoadAt < RECENT_THREAD_LIST_LOAD_REUSE_MS
    ) {
      return
    }

    loadThreadsPromise = (async () => {
    if (!hasLoadedThreads.value) {
      isLoadingThreads.value = true
    }

    try {
      const revisions = new Map(threadStatusRevision)
      const [page, rootsState] = await Promise.all([
        getThreadGroupsPage(),
        loadWorkspaceRootsStateForThreadList(),
        loadThreadTitleCacheIfNeeded({ force: options.force === true }),
      ])
      applyListedStatuses(page.groups, revisions)
      loadedThreadListRootsState = rootsState
      const groups = page.groups
      loadedThreadListGroups = hasLoadedThreads.value
        ? mergeThreadGroupPages(loadedThreadListGroups, groups)
        : groups
      threadListNextCursor = hasLoadedThreads.value && !hasLoadedAllThreadPages
        ? threadListNextCursor
        : page.nextCursor
      hasLoadedAllThreadPages = page.nextCursor === null
      isThreadListFullyLoaded.value = hasLoadedAllThreadPages
      await hydrateWorkspaceRootsStateIfNeeded(groups, rootsState)

      applyThreadGroups(loadedThreadListGroups, rootsState)
      hasLoadedThreads.value = true
      lastThreadListLoadAt = Date.now()
      if (!hasLoadedAllThreadPages) {
        scheduleRemainingThreadPages(rootsState)
      }

      const flatThreads = flattenThreads(projectGroups.value)
      pruneThreadScopedState(flatThreads)

      const currentExists = flatThreads.some((thread) => thread.id === selectedThreadId.value)

      if (!currentExists && !selectedThreadId.value) {
        setSelectedThreadId(flatThreads[0]?.id ?? '')
      }
    } finally {
      isLoadingThreads.value = false
    }
    })().finally(() => {
      loadThreadsPromise = null
    })

    await loadThreadsPromise
  }

  async function loadMessages(threadId: string, options: { silent?: boolean; retry?: boolean } = {}) {
    if (!threadId) {
      return
    }
    conversationDeliveries.refresh()
    void refreshVisibleDeliveryReceipts(threadId)
    const recentLoadFailure =
      Date.now() - (lastMessageLoadFailureAtByThreadId.get(threadId) ?? 0) < RECENT_THREAD_MESSAGE_LOAD_REUSE_MS
    if (!options.retry && turnErrorByThreadId.value[threadId]?.transient && (options.silent === true || recentLoadFailure)) {
      return
    }

    const existingLoad = loadMessagePromiseByThreadId.get(threadId)
    if (existingLoad) {
      const identity = loadIdentityRevisionByThreadId.get(threadId)
      try { await existingLoad } catch (cause) { if (identity === accountIdentityRevision) throw cause }
      if (identity !== accountIdentityRevision) await loadMessages(threadId, options)
      return
    }

    const alreadyLoaded = loadedMessagesByThreadId.value[threadId] === true
    const shouldShowLoading = options.silent !== true && !alreadyLoaded
    if (shouldShowLoading) {
      isLoadingMessages.value = true
    }

    const identityRevision = accountIdentityRevision
    const requestedRevision = messageHistoryRevisionByThreadId.get(threadId) ?? 0
    let loadedSnapshot = false
    const loadPromise = (async () => {
      try {
      const version = currentThreadVersion(threadId)
      const loadedVersion = loadedVersionByThreadId.value[threadId] ?? ''
      const loadedRecently =
        Date.now() - (lastMessageLoadAtByThreadId.get(threadId) ?? 0) < RECENT_THREAD_MESSAGE_LOAD_REUSE_MS
      const canReuseLoadedMessages =
        alreadyLoaded && !turnErrorByThreadId.value[threadId]?.transient &&
        requestedRevision === (loadedHistoryRevisionByThreadId.get(threadId) ?? 0) &&
        (
          loadedRecently ||
          (
            (version.length === 0 || loadedVersion === version) &&
            inProgressById.value[threadId] !== true
          )
        )

      if (canReuseLoadedMessages) {
        return
      }

      const needsResume = resumedThreadById.value[threadId] !== true
      const resumedThread = needsResume ? await resumeThread(threadId) : null
      let detail = resumedThread
      if (!detail) {
        try { detail = await getThreadDetail(threadId) } catch (cause) {
          if (!/thread.*(?:not loaded|not found)|no.*thread.*found/i.test(String(cause))) throw cause
          invalidateThreadResumeCache(threadId)
          detail = await resumeThread(threadId)
        }
      }
      if (identityRevision !== accountIdentityRevision) return
      if (detail.thread) snapshotThreads.value = { ...snapshotThreads.value, [threadId]: detail.thread }

      if (detail.modelProvider) {
        setThreadModelProviderId(threadId, detail.modelProvider)
      }
      if (detail.model) {
        setThreadModelId(threadId, resolveThreadModelForProvider(threadId, detail.model, detail.modelProvider))
      }
      if (resumedThread) {
        resumedThreadById.value = {
          ...resumedThreadById.value,
          [threadId]: true,
        }
      }

      const { messages: nextMessages, inProgress, activeTurnId, turnIndexByTurnId } = detail
      const previousLookup = turnIndexByTurnIdByThreadId.value[threadId] ?? {}
      const firstLoaded = orderedTurnIds(previousLookup)[0]
      const keepOlder = alreadyLoaded && !!firstLoaded && !(firstLoaded in turnIndexByTurnId)
      if (!keepOlder) {
        hasMoreOlderMessagesByThreadId.value = { ...hasMoreOlderMessagesByThreadId.value, [threadId]: detail.hasMoreOlder === true }
        if (detail.historyPosition) historyPositionByThreadId.value = { ...historyPositionByThreadId.value, [threadId]: detail.historyPosition }
      }
      markThreadMessagesPersisted(threadId, nextMessages)
      replaceTurnIndexLookupForThread(threadId, mergeTurnOrder(previousLookup, turnIndexByTurnId))
      rebindLiveFileChangeTurnIndices(threadId)
      const previousPersisted = persistedMessagesByThreadId.value[threadId] ?? []
      const mergedMessages = mergeMessages(previousPersisted, nextMessages, {
        preserveMissing: alreadyLoaded || options.silent === true || hasOptimisticUserMessages(previousPersisted),
      })
      setPersistedMessagesForThread(threadId, mergedMessages)

      const previousLiveAgent = liveAgentMessagesByThreadId.value[threadId] ?? []
      if (inProgress || requestedRevision !== (messageHistoryRevisionByThreadId.get(threadId) ?? 0)) {
        const nextLiveAgent = removeRedundantLiveAgentMessages(previousLiveAgent, nextMessages)
        setLiveAgentMessagesForThread(threadId, nextLiveAgent)
      } else {
        clearLiveAgentMessagesForThread(threadId)
      }
      removeLiveCommandsPersistedIn(threadId, nextMessages)
      removeLiveFileChangesPersistedIn(threadId, nextMessages)

      loadedMessagesByThreadId.value = {
        ...loadedMessagesByThreadId.value,
        [threadId]: true,
      }
      loadedSnapshot = true
      loadedHistoryRevisionByThreadId.set(threadId, requestedRevision)
      lastMessageLoadAtByThreadId.set(threadId, Date.now())
      lastMessageLoadFailureAtByThreadId.delete(threadId)

      if (version) {
        loadedVersionByThreadId.value = {
          ...loadedVersionByThreadId.value,
          [threadId]: version,
        }
      }
      const snapshotIsCurrent = requestedRevision === (messageHistoryRevisionByThreadId.get(threadId) ?? 0)
      if (snapshotIsCurrent) setThreadInProgress(threadId, inProgress)
      clearTransientTurnErrorForThread(threadId)
      if (snapshotIsCurrent && activeTurnId) {
        activeTurnIdByThreadId.value = {
          ...activeTurnIdByThreadId.value,
          [threadId]: activeTurnId,
        }
      } else if (snapshotIsCurrent && activeTurnIdByThreadId.value[threadId]) {
        activeTurnIdByThreadId.value = omitKey(activeTurnIdByThreadId.value, threadId)
      }
      if (snapshotIsCurrent && !inProgress) {
        clearCompletedTurnLiveState(threadId)
      }
      } catch (unknownError) {
        if (identityRevision !== accountIdentityRevision) return
        const message = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
        if (selectedThreadId.value === threadId) {
          setTurnErrorForThread(threadId, message, { transient: true })
        }
        lastMessageLoadFailureAtByThreadId.set(threadId, Date.now())
        throw unknownError
      } finally {
      if (shouldShowLoading) {
        isLoadingMessages.value = false
      }
      }
    })().finally(() => {
      loadMessagePromiseByThreadId.delete(threadId)
      loadIdentityRevisionByThreadId.delete(threadId)
      if (loadedSnapshot && requestedRevision !== (messageHistoryRevisionByThreadId.get(threadId) ?? 0)
        && selectedThreadId.value === threadId && typeof window !== 'undefined') {
        pendingThreadMessageRefresh.add(threadId)
        if (eventSyncTimer === null) eventSyncTimer = window.setTimeout(() => {
          eventSyncTimer = null
          void syncFromNotifications()
        }, EVENT_SYNC_DEBOUNCE_MS)
      }
    })

    loadIdentityRevisionByThreadId.set(threadId, identityRevision)
    loadMessagePromiseByThreadId.set(threadId, loadPromise)
    await loadPromise
  }

  async function loadOlderMessages(threadId: string = selectedThreadId.value): Promise<void> {
    if (!threadId) return
    if (loadingOlderMessagesByThreadId.value[threadId] === true) return
    if (hasMoreOlderMessagesByThreadId.value[threadId] !== true) return

    const beforeTurnId = orderedTurnIds(turnIndexByTurnIdByThreadId.value[threadId] ?? {})[0] || getFirstPersistedTurnId(threadId)
    if (!beforeTurnId) {
      hasMoreOlderMessagesByThreadId.value = {
        ...hasMoreOlderMessagesByThreadId.value,
        [threadId]: false,
      }
      return
    }

    loadingOlderMessagesByThreadId.value = {
      ...loadingOlderMessagesByThreadId.value,
      [threadId]: true,
    }

    try {
      const page = await getOlderThreadMessages(threadId, beforeTurnId, undefined, historyPositionByThreadId.value[threadId])
      const previousPersisted = persistedMessagesByThreadId.value[threadId] ?? []
      const mergedMessages = mergeMessages(page.messages, previousPersisted, { preserveMissing: true })
      replaceTurnIndexLookupForThread(threadId, mergeTurnOrder(turnIndexByTurnIdByThreadId.value[threadId] ?? {}, page.turnIndexByTurnId, true))
      setPersistedMessagesForThread(threadId, mergedMessages)
      if (page.historyPosition) historyPositionByThreadId.value = { ...historyPositionByThreadId.value, [threadId]: page.historyPosition }
      rebindLiveFileChangeTurnIndices(threadId)
      hasMoreOlderMessagesByThreadId.value = {
        ...hasMoreOlderMessagesByThreadId.value,
        [threadId]: page.hasMoreOlder,
      }
    } catch (loadError) {
      error.value = loadError instanceof Error ? loadError.message : 'Failed to load earlier messages'
      throw loadError
    } finally {
      loadingOlderMessagesByThreadId.value = {
        ...loadingOlderMessagesByThreadId.value,
        [threadId]: false,
      }
    }
  }

  async function ensureThreadMessagesLoaded(threadId: string, options: { silent?: boolean } = {}): Promise<void> {
    if (!threadId) return
    if (loadedMessagesByThreadId.value[threadId] === true) return
    if (options.silent === true && turnErrorByThreadId.value[threadId]?.transient) return
    await loadMessages(threadId, options)
  }

  async function refreshSkills(options: { force?: boolean } = {}): Promise<void> {
    const selectedCwd = selectedThread.value?.cwd?.trim() ?? ''
    const skillsLoadKey = selectedCwd || '__global__'
    if (refreshSkillsPromise) {
      await refreshSkillsPromise
      return
    }
    if (
      options.force !== true &&
      hasLoadedSkills &&
      lastSkillsLoadKey === skillsLoadKey &&
      Date.now() - lastSkillsLoadAt < RECENT_SKILLS_LOAD_REUSE_MS
    ) {
      return
    }

    refreshSkillsPromise = (async () => {
      try {
        installedSkills.value = await getSkillsList(selectedCwd ? [selectedCwd] : undefined)
        hasLoadedSkills = true
        lastSkillsLoadAt = Date.now()
        lastSkillsLoadKey = skillsLoadKey
      } catch {
        // keep previous skills on failure
      } finally {
        refreshSkillsPromise = null
      }
    })()

    await refreshSkillsPromise
  }

  async function refreshAncillaryState(
    options: { providerChanged?: boolean; includeProviderModels?: boolean } = {},
  ): Promise<void> {
    await Promise.allSettled([
      refreshModelPreferences({
        providerChanged: options.providerChanged,
        includeProviderModels: options.includeProviderModels,
      }),
      refreshRateLimits(),
      refreshCollaborationModes(),
      refreshSkills(),
    ])
  }

  function scheduleAncillaryStateRefresh(
    options: { providerChanged?: boolean; includeProviderModels?: boolean } = {},
  ): void {
    const run = () => {
      void refreshAncillaryState(options)
    }

    if (typeof window === 'undefined') {
      run()
      return
    }

    window.setTimeout(run, 0)
  }

  async function refreshAll(
    options: { includeSelectedThreadMessages?: boolean; awaitAncillaryRefreshes?: boolean; providerChanged?: boolean; forceThreadRefresh?: boolean; accountChanged?: boolean } = {},
  ) {
    error.value = ''
    codexCliMissingError.value = ''
    if (options.accountChanged) {
      accountIdentityRevision++
      modelRefreshGeneration++
      invalidateThreadResumeCache()
      invalidateModelCatalog()
      recentRateLimitsAt = 0
      const ids = new Set([...Object.keys(loadedMessagesByThreadId.value), ...Object.keys(turnErrorByThreadId.value), ...loadMessagePromiseByThreadId.keys(), selectedThreadId.value])
      const resumed = { ...resumedThreadById.value }
      for (const id of ids) {
        if (!id || inProgressById.value[id]) continue
        delete resumed[id]
        loadedHistoryRevisionByThreadId.set(id, -1)
        lastMessageLoadFailureAtByThreadId.delete(id)
        clearTransientTurnErrorForThread(id)
      }
      resumedThreadById.value = resumed
    }
    if (options.providerChanged) { invalidateModelCatalog(); recentRateLimitsAt = 0 }
    const includeSelectedThreadMessages = options.includeSelectedThreadMessages !== false
    const awaitAncillaryRefreshes = options.awaitAncillaryRefreshes === true

    try {
      await loadPersistedQueueStateIfNeeded()
      await loadThreads({ force: options.forceThreadRefresh === true })
      if (includeSelectedThreadMessages) {
        try {
          await loadMessages(selectedThreadId.value)
        } catch (unknownError) {
          error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
        }
      }
      if (awaitAncillaryRefreshes) {
        await refreshAncillaryState({
          providerChanged: options.providerChanged,
          includeProviderModels: options.providerChanged === true || awaitAncillaryRefreshes,
        })
      } else {
        scheduleAncillaryStateRefresh({
          providerChanged: options.providerChanged,
          includeProviderModels: false,
        })
      }
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      if (isCodexCliMissingError(unknownError)) {
        codexCliMissingError.value = CODEX_CLI_MISSING_MESSAGE
      } else {
        codexCliMissingError.value = ''
      }
    }
  }

  async function selectThread(threadId: string): Promise<SelectThreadResult> {
    setSelectedThreadId(threadId)

    try {
      await loadMessages(threadId, { retry: true })
      await refreshModelPreferences({ includeProviderModels: true })
      void refreshSkills()
      return 'ok'
    } catch (unknownError) {
      const message = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      error.value = message
      const result = isThreadNotFoundError(unknownError) ? 'not-found' : 'error'
      if (threadId.trim()) {
        setTurnErrorForThread(threadId, message, { transient: true })
      }
      return result
    }
  }

  async function archiveThreadById(threadId: string) {
    const wasSelectedThread = selectedThreadId.value === threadId
    const nextSelectedThreadId = wasSelectedThread
      ? findAdjacentThreadId(flattenThreads(projectGroups.value), threadId)
      : ''

    if (wasSelectedThread) {
      setSelectedThreadId(nextSelectedThreadId)
      if (nextSelectedThreadId) {
        void loadMessages(nextSelectedThreadId, { silent: true })
      }
    }

    try {
      await archiveThread(threadId)
      threadSearchVersion.value += 1
      removeArchivedThreadFromLoadedLists(threadId)
      await loadThreads()

      if (wasSelectedThread && nextSelectedThreadId && selectedThreadId.value === nextSelectedThreadId) {
        await ensureThreadMessagesLoaded(nextSelectedThreadId, { silent: true })
      }
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
    }
  }

  async function renameThreadById(threadId: string, threadName: string) {
    const normalizedName = threadName.trim()
    if (!threadId || !normalizedName) return

    try {
      await renameThread(threadId, normalizedName)
      threadTitleById.value = { ...threadTitleById.value, [threadId]: normalizedName }
      applyThreadFlags()
      await persistThreadTitle(threadId, normalizedName)
      threadSearchVersion.value += 1
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
    }
  }

  async function forkThreadById(threadId: string): Promise<string> {
    const sourceThreadId = threadId.trim()
    if (!sourceThreadId) return ''

    const sourceThread = flattenThreads(sourceGroups.value).find((row) => row.id === sourceThreadId)
    const sourceCwd = sourceThread?.cwd?.trim() ?? ''
    const sourceTitle = sourceThread?.title?.trim() ?? 'Forked chat'
    const selectedModel = readModelIdForThread(sourceThreadId)
    error.value = ''

    try {
      const forkedThread = await forkThread(sourceThreadId, sourceCwd || undefined, selectedModel || undefined)
      const nextThreadId = forkedThread.threadId.trim()
      if (!nextThreadId) return ''

      insertOptimisticThread(nextThreadId, sourceCwd, sourceTitle)
      setThreadModelId(nextThreadId, forkedThread.model)
      resumedThreadById.value = {
        ...resumedThreadById.value,
        [nextThreadId]: true,
      }
      setSelectedThreadId(nextThreadId)
      await loadThreads()
      await loadMessages(nextThreadId)
      return nextThreadId
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      return ''
    }
  }

  async function forkThreadFromTurn(threadId: string, turnId: string): Promise<string> {
    if (!threadId.trim() || !turnId.trim()) return ''
    const sourceMessages = persistedMessagesByThreadId.value[threadId] ?? []
    if (!sourceMessages.some(message => message.turnId === turnId)) return ''
    const sourceThread = flattenThreads(sourceGroups.value).find(row => row.id === threadId)
    try {
      error.value = ''
      const forked = await forkThreadAtTurn(threadId, turnId)
      const nextId = forked.threadId.trim()
      const title = toForkedThreadTitle(sourceThread?.title || sourceThread?.preview || 'Untitled thread')
      insertOptimisticThread(nextId, sourceThread?.cwd ?? '', title)
      setThreadModelId(nextId, forked.model)
      await renameThreadById(nextId, title)
      setSelectedThreadId(nextId)
      await loadMessages(nextId)
      void loadThreads().catch(() => {})
      return nextId
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : '无法创建历史分支。'
      return ''
    }
  }

  async function answerAsyncQuestions(reply: AsyncQuestionReply): Promise<void> {
    const known = [
      ...(persistedMessagesByThreadId.value[reply.threadId] ?? []),
      ...(liveAgentMessagesByThreadId.value[reply.threadId] ?? []),
    ].find(message => message.id === reply.itemId && message.turnId === reply.turnId && message.questions?.length)
    if (!known) throw new Error('找不到对应问题，请刷新会话后重试。')
    // While a turn is running the CLI may reconstruct item-N IDs, then publish
    // the original call ID on completion. Resolve an ordinal in the native turn
    // once on explicit submission; never infer an answer from ordinary text.
    const detail = await getThreadDetail(reply.threadId)
    const turnMessages = detail.messages.some(message => message.turnId === reply.turnId && message.questions?.length)
      ? detail.messages.filter(message => message.turnId === reply.turnId)
      : await getThreadTurnMessages(reply.threadId, reply.turnId)
    const candidates = turnMessages.filter(message => message.questions?.length)
    const question = candidates.find(message => reply.questionOrdinal !== undefined
      ? message.questionOrdinal === reply.questionOrdinal
      : message.id === reply.itemId)
      ?? (candidates.filter(message => JSON.stringify(message.questions) === JSON.stringify(known.questions)).length === 1
        ? candidates.find(message => JSON.stringify(message.questions) === JSON.stringify(known.questions))
        : undefined)
    if (!question) throw new Error('问题状态已变化，请刷新会话后重试。')
    const key = questionRefKey({ itemId: question.id, turnId: reply.turnId, questionOrdinal: question.questionOrdinal })
    if ([...(persistedMessagesByThreadId.value[reply.threadId] ?? []), ...detail.messages, ...turnMessages].some(message => message.questionReply && questionRefKey(message.questionReply) === key)) return
    setPersistedMessagesForThread(reply.threadId, mergeMessages(persistedMessagesByThreadId.value[reply.threadId] ?? [], detail.messages, { preserveMissing: true }))
    await startTurnForThread(reply.threadId, buildQuestionReply(question, reply.answers), [], [], [], undefined, 'steer',
      { id: createDeliveryId(), requireConfirmed: true })
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
    if (isUpdatingSpeedMode.value) return

    const threadId = selectedThreadId.value
    const nextText = text.trim()
    if (!threadId || (!nextText && imageUrls.length === 0 && fileAttachments.length === 0)) return

    const isInProgress = inProgressById.value[threadId] === true

    if (isInProgress && mode === 'queue') {
      const queue = queuedMessagesByThreadId.value[threadId] ?? []
      const insertIndex = typeof queueInsertIndex === 'number'
        ? Math.max(0, Math.min(queueInsertIndex, queue.length))
        : queue.length
      await commitQueueOperation({
        type: 'add',
        threadId,
        beforeId: queue[insertIndex]?.id,
        message: {
          id: createDeliveryId(),
          text: nextText,
          imageUrls,
          skills,
          fileAttachments,
          collaborationMode: collaborationModeOverride ?? selectedCollaborationMode.value,
          ...checkedModelSettings(readModelIdForThread(threadId), imageUrls.length > 0),
        },
      })
      return
    }

    if (isInProgress) {
      shouldAutoScrollOnNextAgentEvent = true
      await startTurnForThread(threadId, nextText, imageUrls, skills, fileAttachments, collaborationModeOverride, 'steer')
      return
    }

    error.value = ''
    shouldAutoScrollOnNextAgentEvent = true
    setTurnSummaryForThread(threadId, null)
    setTurnActivityForThread(
      threadId,
      {
        label: 'Thinking',
        details: buildPendingTurnDetails(
          readModelIdForThread(threadId),
          selectedReasoningEffort.value,
          collaborationModeOverride === 'plan'
            ? 'plan'
            : collaborationModeOverride === 'default'
              ? 'default'
              : selectedCollaborationMode.value,
        ),
      },
    )
    setTurnErrorForThread(threadId, null)
    setThreadInProgress(threadId, true)

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
      shouldAutoScrollOnNextAgentEvent = false
      setThreadInProgress(threadId, false)
      setTurnActivityForThread(threadId, null)
      const errorMessage = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      setTurnErrorForThread(threadId, errorMessage)
      error.value = errorMessage
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
    if (isUpdatingSpeedMode.value) return ''

    const nextText = text.trim()
    const targetCwd = cwd.trim()
    let selectedModel = readModelIdForThread(NEW_THREAD_COLLABORATION_MODE_CONTEXT).trim()
    const preferredChoice = webPreferences.sessions.value[''] ? { ...webPreferences.sessions.value[''] } : null
    const selectedMode = selectedCollaborationMode.value
    const newThreadSettings = checkedModelSettings(selectedModel, imageUrls.length > 0)
    if (!nextText && imageUrls.length === 0 && fileAttachments.length === 0) return ''

    isSendingMessage.value = true
    error.value = ''
    let threadId = ''

    try {
      try {
        const startedThread = await startThread(targetCwd || undefined, selectedModel || undefined)
        threadId = startedThread.threadId
        setThreadModelId(threadId, startedThread.model)
        setThreadModelProviderId(threadId, startedThread.modelProvider || activeProviderId.value)
        setSelectedCollaborationModeForThread(threadId, selectedMode)
      } catch (unknownError) {
        if (selectedModel && selectedModel !== MODEL_FALLBACK_ID && isUnsupportedChatGptModelError(unknownError)) {
          // A rejected catalog entry affects this runtime only, never saved preferences.
          availableModels.value = availableModels.value.filter(model => model.id !== selectedModel)
          selectedModel = preferredChoice && availableModels.value.length
            ? effectiveConversationChoice(preferredChoice, availableModels.value).model
            : MODEL_FALLBACK_ID
          ensureAvailableModelIds(selectedModel)
          const fallbackThread = await startThread(targetCwd || undefined, selectedModel)
          threadId = fallbackThread.threadId
          setThreadModelId(threadId, fallbackThread.model)
          setThreadModelProviderId(threadId, fallbackThread.modelProvider || activeProviderId.value)
          setSelectedCollaborationModeForThread(threadId, selectedMode)
        } else {
          throw unknownError
        }
      }
      if (!threadId) return ''

      insertOptimisticThread(threadId, targetCwd, nextText || '[Image]', confirmedProjectId)
      appendOptimisticUserMessage(threadId, nextText, imageUrls, skills, fileAttachments)
      blockInterruptUntilThreadIsPersisted(threadId)
      resumedThreadById.value = {
        ...resumedThreadById.value,
        [threadId]: true,
      }
      setSelectedThreadId(threadId)
      webPreferences.register(threadId, preferredChoice || { model: selectedModel || newThreadSettings.model, provider: readProviderIdForThread(threadId), effort: newThreadSettings.effort, tier: newThreadSettings.serviceTier || '' })
      selectedModelId.value = selectedModel || newThreadSettings.model
      if (!preferredChoice) saveCurrentModelSettings({ effort: newThreadSettings.effort, tier: newThreadSettings.serviceTier || '' })
      shouldAutoScrollOnNextAgentEvent = true
      setTurnSummaryForThread(threadId, null)
      setTurnActivityForThread(
        threadId,
        {
          label: 'Thinking',
          details: buildPendingTurnDetails(
            readModelIdForThread(threadId),
            selectedReasoningEffort.value,
            selectedMode,
          ),
        },
      )
      setTurnErrorForThread(threadId, null)
      setThreadInProgress(threadId, true)
      const capturedThreadId = threadId
      const capturedCwd = targetCwd || null
      const capturedPrompt = nextText
      await startTurnForThread(threadId, nextText, imageUrls, skills, fileAttachments, selectedMode)
        .catch((unknownError) => {
          shouldAutoScrollOnNextAgentEvent = false
          setThreadInProgress(threadId, false)
          setTurnActivityForThread(threadId, null)
          const errorMessage = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
          setTurnErrorForThread(threadId, errorMessage)
          error.value = errorMessage
          throw unknownError
        })
        .finally(() => {
          isSendingMessage.value = false
        })
      void requestThreadTitleGeneration(capturedThreadId, capturedPrompt, capturedCwd)
      return threadId
    } catch (unknownError) {
      shouldAutoScrollOnNextAgentEvent = false
      if (threadId) {
        setThreadInProgress(threadId, false)
        setTurnActivityForThread(threadId, null)
      }
      const errorMessage = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      if (threadId) {
        setTurnErrorForThread(threadId, errorMessage)
      }
      error.value = errorMessage
      isSendingMessage.value = false
      if (threadId && unknownError instanceof Error) Object.assign(unknownError, { createdThreadId: threadId })
      throw unknownError
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
    const executionSettings = checkedModelSettings(readModelIdForThread(threadId), imageUrls.length > 0)
    const reasoningEffort = executionSettings.effort
    const collaborationMode = collaborationModeOverride === 'plan' ? 'plan' : collaborationModeOverride === 'default'
      ? 'default'
      : selectedCollaborationMode.value
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
    const previousTurnId = activeTurnIdByThreadId.value[threadId]
    const userMessageOrdinal = (persistedMessagesByThreadId.value[threadId] ?? []).filter(message => message.role === 'user' && message.turnId === previousTurnId).length
      + conversationDeliveries.rows.value.filter(row => row.threadId === threadId && row.status === 'accepted' && row.turnId === previousTurnId).length
    if (isSteering) conversationDeliveries.begin(threadId, {
      id: deliveryId, text: nextText, imageUrls: normalizedImageUrls, skills, fileAttachments, collaborationMode,
    }, userMessageOrdinal, false, previousTurnId)
    try {
      if (resumedThreadById.value[threadId] !== true) {
        const resumedThread = await resumeThread(threadId)
        if (resumedThread.model) {
          setThreadModelId(threadId, resolveThreadModelForProvider(threadId, resumedThread.model, resumedThread.modelProvider))
        }
        if (resumedThread.modelProvider) {
          setThreadModelProviderId(threadId, resumedThread.modelProvider)
        }
        resumedThreadById.value = {
          ...resumedThreadById.value,
          [threadId]: true,
        }
      }
      const startedTurnId = await startThreadTurn(
        threadId, nextText, normalizedImageUrls, executionSettings.model || undefined,
        reasoningEffort || undefined, skills.length > 0 ? skills : undefined,
        fileAttachments, collaborationMode, executionSettings.serviceTier,
        deliveryMode || 'immediate', { id: deliveryId, requireConfirmed: deliveryOptions?.requireConfirmed,
          onPrepared: id => {
            if (!isSteering) return
            conversationDeliveries.replaceId(deliveryId, id)
            deliveryId = id
            conversationDeliveries.refresh()
          },
          onResult: result => {
            if (!isSteering) return
            conversationDeliveries.replaceId(deliveryId, result.id)
            deliveryId = result.id
            conversationDeliveries.refresh()
          },
        },
      )
      if (!startedTurnId) {
        // A queued steer must not clear the already running turn.
        if (!previousTurnId) {
          setThreadInProgress(threadId, false)
          setTurnActivityForThread(threadId, null)
        }
        const messages = persistedMessagesByThreadId.value[threadId] ?? []
        setPersistedMessagesForThread(threadId, messages.filter(message => !(isOptimisticUserMessage(message) && !message.turnId && message.text === readQuestionReply(nextText).text)))
        await refreshQueueState().catch(() => {})
      }

      if (startedTurnId) {
        setThreadInProgress(threadId, true)
        const previous = persistedMessagesByThreadId.value[threadId] ?? []
        setPersistedMessagesForThread(threadId, previous.filter(message => !(isOptimisticUserMessage(message) && !message.turnId && message.text === readQuestionReply(nextText).text)))
        if (isSteering) {
          conversationDeliveries.patch(deliveryId, { status: 'accepted', turnId: startedTurnId, userMessageOrdinal: startedTurnId === previousTurnId ? userMessageOrdinal : 0 })
          conversationDeliveries.observe(threadId, previous)
        } else {
          appendOptimisticUserMessage(threadId, nextText, normalizedImageUrls, skills, fileAttachments, { id: deliveryId, turnId: startedTurnId, userMessageOrdinal: startedTurnId === previousTurnId ? userMessageOrdinal : 0 })
        }
        activeTurnIdByThreadId.value = {
          ...activeTurnIdByThreadId.value,
          [threadId]: startedTurnId,
        }
        maybeUnblockInterruptForActiveTurn(threadId, startedTurnId)
      }

      markThreadHistoryDirty(threadId)
      // Delivery is already durably acknowledged; a later read failure cannot undo it.
      await syncFromNotifications().catch(() => {})
      scheduleDelayedTurnSync(threadId)
    } catch (unknownError) {
      if (isSteering) {
        conversationDeliveries.refresh()
        // A saved outbox/queue record keeps its real uncertain status. Only a
        // preflight failure, before any durable submission, is known not sent.
        const row = conversationDeliveries.rows.value.find(row => row.id === deliveryId)
        if (row?.status === 'submitting') conversationDeliveries.patch(deliveryId, { status: 'failed', error: String(unknownError) })
        void refreshQueueState().catch(() => {})
      }
      throw unknownError
    }
  }

  async function processQueuedMessages(threadId: string): Promise<void> {
    if (queueProcessingByThreadId.value[threadId] === true) return
    queueProcessingByThreadId.value = {
      ...queueProcessingByThreadId.value,
      [threadId]: true,
    }
    try {
      await refreshQueueState()
    } catch {
      // Backend queue state is optional during transient bridge failures.
    } finally {
      queueProcessingByThreadId.value = omitKey(queueProcessingByThreadId.value, threadId)
    }
  }

  function scheduleQueueStateRefresh(threadId: string): void {
    void processQueuedMessages(threadId)
    if (typeof window === 'undefined') return
    window.setTimeout(() => {
      void processQueuedMessages(threadId)
    }, 650)
  }

  async function interruptSelectedThreadTurn(): Promise<void> {
    const threadId = selectedThreadId.value
    if (!threadId) return
    if (inProgressById.value[threadId] !== true) return
    if (interruptBlockedUntilPersistedByThreadId.value[threadId] === true) return
    let turnId = activeTurnIdByThreadId.value[threadId]
    if (!turnId) {
      const { activeTurnId } = await getThreadDetail(threadId)
      turnId = activeTurnId
      if (turnId) {
        activeTurnIdByThreadId.value = {
          ...activeTurnIdByThreadId.value,
          [threadId]: turnId,
        }
      }
    }
    if (!turnId) {
      throw new Error('Could not determine active turn id for interrupt')
    }

    isInterruptingTurn.value = true
    error.value = ''
    try {
      await interruptThreadTurn(threadId, turnId)
      setThreadInProgress(threadId, false)
      setTurnActivityForThread(threadId, null)
      setTurnErrorForThread(threadId, null)
      if (activeTurnIdByThreadId.value[threadId]) {
        activeTurnIdByThreadId.value = omitKey(activeTurnIdByThreadId.value, threadId)
      }
      markThreadHistoryDirty(threadId)
      pendingThreadsRefresh = true
      await syncFromNotifications()
    } catch (unknownError) {
      const errorMessage = unknownError instanceof Error ? unknownError.message : 'Failed to interrupt active turn'
      setTurnErrorForThread(threadId, errorMessage)
      error.value = errorMessage
    } finally {
      isInterruptingTurn.value = false
    }
  }

  async function rollbackSelectedThread(turnId: string): Promise<boolean> {
    const threadId = selectedThreadId.value
    if (!threadId) return false
    if (isRollingBack.value) return false
    if (!turnId.trim()) return false

    const persisted = persistedMessagesByThreadId.value[threadId] ?? []
    const matchedMessage = persisted.find((message) => message.turnId === turnId)
    const turnIndex = typeof matchedMessage?.turnIndex === 'number' ? matchedMessage.turnIndex : -1
    if (turnIndex < 0) return false
    const maxTurnIndex = Math.max(-1, ...Object.values(turnIndexByTurnIdByThreadId.value[threadId] ?? {}))
    if (maxTurnIndex < 0 || turnIndex > maxTurnIndex) return false
    const numTurns = maxTurnIndex - turnIndex + 1
    if (numTurns < 1) return false

    isRollingBack.value = true
    error.value = ''
    try {
      const threadCwd = selectedThread.value?.cwd?.trim() ?? ''
      if (threadCwd) {
        const files = await revertThreadFileChanges(threadId, turnId, threadCwd)
        if (files.errors.length) throw new Error(files.errors.join('\n'))
      }
      const nextMessages = await rollbackThread(threadId, numTurns)
      replaceTurnIndexLookupForThread(threadId, {})
      historyPositionByThreadId.value = omitKey(historyPositionByThreadId.value, threadId)
      hasMoreOlderMessagesByThreadId.value = { ...hasMoreOlderMessagesByThreadId.value, [threadId]: false }
      lastMessageLoadAtByThreadId.delete(threadId)
      loadedMessagesByThreadId.value = omitKey(loadedMessagesByThreadId.value, threadId)
      setPersistedMessagesForThread(threadId, nextMessages)
      setLiveAgentMessagesForThread(threadId, [])
      clearLiveReasoningForThread(threadId)
      if (liveCommandsByThreadId.value[threadId]) {
        liveCommandsByThreadId.value = omitKey(liveCommandsByThreadId.value, threadId)
      }
      setTurnSummaryForThread(threadId, null)
      setTurnActivityForThread(threadId, null)
      setTurnErrorForThread(threadId, null)
      pendingThreadsRefresh = true
      await syncFromNotifications()
      return true
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Failed to rollback thread'
      return false
    } finally {
      isRollingBack.value = false
    }
  }

  let renameProjectTimer: ReturnType<typeof setTimeout> | null = null

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
      await loadThreads({ force: true })
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
    pruneThreadScopedState(flatThreads)

    const currentExists = flatThreads.some((thread) => thread.id === selectedThreadId.value)
    if (!currentExists) {
      setSelectedThreadId(flatThreads[0]?.id ?? '')
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
    const reorderedVisibleOrder = reorderStringArray(visibleOrder, fromIndex, clampedToIndex)
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

  async function syncThreadStatus(): Promise<void> {
    if (isPolling.value) return
    isPolling.value = true

    try {
      await loadThreads()

      if (!selectedThreadId.value) return

      const threadId = selectedThreadId.value
      const currentVersion = currentThreadVersion(threadId)
      const loadedVersion = loadedVersionByThreadId.value[threadId] ?? ''
      const hasVersionChange = currentVersion.length > 0 && currentVersion !== loadedVersion
      const isInProgress = inProgressById.value[threadId] === true

      if (isInProgress || hasVersionChange) {
        await loadMessages(threadId, { silent: true })
      }
    } catch {
      // ignore poll failures and keep last known state
    } finally {
      isPolling.value = false
    }
  }

  async function syncFromNotifications(): Promise<void> {
    if (isPolling.value) {
      if (typeof window !== 'undefined' && eventSyncTimer === null) {
        eventSyncTimer = window.setTimeout(() => {
          eventSyncTimer = null
          void syncFromNotifications()
        }, EVENT_SYNC_DEBOUNCE_MS)
      }
      return
    }

    isPolling.value = true

    const shouldRefreshThreads = pendingThreadsRefresh
    const shouldForceThreadRefresh = pendingThreadsRefreshForce
    const threadIdsToRefresh = new Set(pendingThreadMessageRefresh)
    pendingThreadsRefresh = false
    pendingThreadsRefreshForce = false
    pendingThreadMessageRefresh.clear()

    try {
      if (shouldRefreshThreads) {
        await loadThreads({ force: shouldForceThreadRefresh })
      }

      const activeThreadId = selectedThreadId.value
      if (!activeThreadId) return

      const isActiveDirty = threadIdsToRefresh.has(activeThreadId)
      const isInProgress = inProgressById.value[activeThreadId] === true
      const currentVersion = currentThreadVersion(activeThreadId)
      const loadedVersion = loadedVersionByThreadId.value[activeThreadId] ?? ''
      const hasVersionChange = currentVersion.length > 0 && currentVersion !== loadedVersion

      const shouldRefreshActiveThread =
        hasVersionChange ||
        isActiveDirty ||
        (isInProgress && loadedMessagesByThreadId.value[activeThreadId] !== true) ||
        (shouldRefreshThreads && loadedMessagesByThreadId.value[activeThreadId] !== true)

      if (shouldRefreshActiveThread) {
        await loadMessages(activeThreadId, { silent: true })
      }
    } catch {
      // Keep UI stable on transient event sync failures.
    } finally {
      isPolling.value = false

      if (
        (pendingThreadsRefresh || pendingThreadMessageRefresh.size > 0) &&
        typeof window !== 'undefined' &&
        eventSyncTimer === null
      ) {
        eventSyncTimer = window.setTimeout(() => {
          eventSyncTimer = null
          void syncFromNotifications()
        }, EVENT_SYNC_DEBOUNCE_MS)
      }
    }
  }

  async function recoverBridgeState(reconnected = false): Promise<void> {
    await loadPendingServerRequestsFromBridge()
    pendingThreadsRefresh ||= reconnected || !hasLoadedThreads.value
    pendingThreadsRefreshForce ||= reconnected
    if (selectedThreadId.value && (reconnected || loadedMessagesByThreadId.value[selectedThreadId.value] !== true)) {
      markThreadHistoryDirty(selectedThreadId.value)
    }
    await syncFromNotifications()
  }

  function startPolling(): void {
    if (typeof window === 'undefined') return
    restoreCompactionRequests()

    if (stopNotificationStream) return
    conversationDeliveries.start()
    void loadPendingServerRequestsFromBridge()
    let notificationReady = false
    stopNotificationStream = subscribeCodexNotifications((notification) => {
      if (notification.method === 'codexapp/completions/changed') {
        const params = asRecord(notification.params)
        const threadId = readString(params?.threadId)
        const token = typeof params?.token === 'string' ? params.token : null
        if (threadId) {
          if (completionChangesDuringLoad) completionChangesDuringLoad[threadId] = token
          if (token) eventUnreadByThreadId.value = { ...eventUnreadByThreadId.value, [threadId]: token }
          else eventUnreadByThreadId.value = omitKey(eventUnreadByThreadId.value, threadId)
          applyThreadFlags()
          if (token && selectedThreadId.value === threadId
            && typeof document !== 'undefined' && document.visibilityState === 'visible'
            && options.isThreadVisible?.(threadId)) {
            markThreadAsRead(threadId)
          }
        }
        return
      }
      if (notification.method === 'codexapp/queue/changed') {
        void refreshQueueState().catch(() => {})
        return
      }
      if (notification.method === 'ready') {
        void loadCompletionList()
        const reconnected = notificationReady
        if (notificationReady) {
          observeTaskNotification({ method: 'codexapp/reconnected', params: {} })
          invalidateModelCatalog()
          availableModels.value = []
          recentRateLimitsAt = 0
          void refreshModelPreferences()
          void refreshRateLimits()
        }
        notificationReady = true
        clearAllTransientTurnErrors()
        void recoverBridgeState(reconnected)
        return
      }
      applyRealtimeUpdates(notification)
      queueEventDrivenSync(notification)
    })
  }

  async function loadPendingServerRequestsFromBridge(): Promise<void> {
    const changes = {
      requests: new Map<number, UiServerRequest | null>(),
      auth: new Map<string, AuthRecoveryState | null>(),
    }
    pendingSnapshot = changes
    let recoverySnapshot: AuthRecoveryState[] | undefined
    try {
      const rows = await getPendingServerRequests(states => { recoverySnapshot = states })
      if (pendingSnapshot !== changes) return
      const requests = new Map(rows
        .map(row => normalizeServerRequest(row))
        .filter((request): request is UiServerRequest => request !== null)
        .map(request => [request.id, request]))
      // Live events that arrive during the read are newer than its snapshot.
      // Apply both additions and resolutions without another network request.
      for (const [id, request] of changes.requests) {
        if (request) requests.set(id, request)
        else requests.delete(id)
      }
      replacePendingServerRequests([...requests.values()])
      if (recoverySnapshot) {
        const recovery = new Map(recoverySnapshot.map(state => [state.threadId, state]))
        for (const [id, state] of changes.auth) {
          if (state) recovery.set(id, state)
          else recovery.delete(id)
        }
        authRecoveryByThreadId.value = Object.fromEntries(recovery)
      }
      applyThreadFlags()
    } catch {
      // Keep current requests and drafts available for a later reconnect.
    } finally {
      if (pendingSnapshot === changes) pendingSnapshot = null
    }
  }

  async function respondToPendingServerRequest(reply: UiServerRequestReply): Promise<boolean> {
    try {
      await replyToServerRequest(reply.id, {
        result: reply.result,
        error: reply.error,
      })
      removePendingServerRequestById(reply.id)
      return true
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Failed to reply to server request'
      return false
    }
  }

  function stopPolling(): void {
    if (typeof window !== 'undefined') conversationDeliveries.stop()
    if (modelRetryTimer) clearTimeout(modelRetryTimer)
    modelRetryTimer = null
    pendingSnapshot = null
    modelRefreshGeneration++
    authRecoveryByThreadId.value = {}
    invalidateModelCatalog()
    availableModels.value = []
    recentRateLimitsAt = 0
    if (stopNotificationStream) {
      stopNotificationStream()
      stopNotificationStream = null
    }

    pendingThreadsRefresh = false
    pendingThreadMessageRefresh.clear()
    pendingTurnStartsById.clear()
    if (eventSyncTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(eventSyncTimer)
      eventSyncTimer = null
    }
    if (rateLimitRefreshTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(rateLimitRefreshTimer)
      rateLimitRefreshTimer = null
    }
    if (threadListBackgroundTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(threadListBackgroundTimer)
      threadListBackgroundTimer = null
    }
    if (typeof window !== 'undefined') {
      for (const timerId of delayedTurnSyncTimerByThreadId.values()) {
        window.clearTimeout(timerId)
      }
    }
    delayedTurnSyncTimerByThreadId.clear()
    activeReasoningItemId = ''
    shouldAutoScrollOnNextAgentEvent = false
    persistedMessagesByThreadId.value = {}
    livePlanMessagesByThreadId.value = {}
    liveAgentMessagesByThreadId.value = {}
    liveReasoningTextByThreadId.value = {}
    liveCommandsByThreadId.value = {}
    liveFileChangeMessagesByThreadId.value = {}
    turnIndexByTurnIdByThreadId.value = {}
    historyPositionByThreadId.value = {}
    turnActivityByThreadId.value = {}
    turnSummaryByThreadId.value = {}
    turnErrorByThreadId.value = {}
    activeTurnIdByThreadId.value = {}
    interruptBlockedUntilPersistedByThreadId.value = {}
    threadListedByServerById.value = {}
    persistedUserMessageByThreadId.value = {}
    hasLoadedPersistedQueueState = false
    queueRequestGeneration += 1
    queueProcessingByThreadId.value = {}
    codexRateLimit.value = null
    threadTokenUsageByThreadId.value = {}
  }

  const selectedThreadQueueError = computed(() => queueErrorByThreadId.value[selectedThreadId.value] || queueStateError.value)

  const selectedThreadQueuedMessages = computed<QueuedMessage[]>(() => {
    const threadId = selectedThreadId.value
    if (!threadId) return []
    return queuedMessagesByThreadId.value[threadId] ?? []
  })

  async function removeQueuedMessage(messageId: string): Promise<QueuedMessage | null> {
    const threadId = selectedThreadId.value
    if (!threadId) return null
    try {
      const message = queuedMessagesByThreadId.value[threadId]?.find(row => row.id === messageId)
      const result = await commitQueueOperation({ type: 'remove', threadId, messageId, revision: message?.delivery?.revision })
      return result.removed ?? null
    } catch {
      void refreshQueueState().catch(() => {})
      return null
    }
  }

  async function reorderQueuedMessage(draggedId: string, targetId: string): Promise<void> {
    const threadId = selectedThreadId.value
    if (!threadId || draggedId === targetId) return
    try {
      const message = queuedMessagesByThreadId.value[threadId]?.find(row => row.id === draggedId)
      await commitQueueOperation({ type: 'move', threadId, messageId: draggedId, targetId, revision: message?.delivery?.revision })
    } catch {
      void refreshQueueState().catch(() => {})
    }
  }

  async function changeQueuedMessage(messageId: string, type: 'steer' | 'reconcile' | 'resume' | 'abandon'): Promise<void> {
    const threadId = selectedThreadId.value
    const message = queuedMessagesByThreadId.value[threadId]?.find(row => row.id === messageId)
    if (!message) return
    const showDelivery = type === 'steer' || message.delivery?.mode === 'steer'
    const previousTurnId = activeTurnIdByThreadId.value[threadId]
    const ordinal = (persistedMessagesByThreadId.value[threadId] ?? []).filter(row => row.role === 'user' && row.turnId === previousTurnId).length
      + conversationDeliveries.rows.value.filter(row => row.threadId === threadId && row.status === 'accepted' && row.turnId === previousTurnId).length
    if (type === 'steer') conversationDeliveries.begin(threadId, message, ordinal, true, previousTurnId)
    try {
      const result = await commitQueueOperation({ type, threadId, messageId, revision: message.delivery?.revision })
      if (result.delivered) {
        if (showDelivery) {
          conversationDeliveries.patch(messageId, { status: 'accepted', turnId: result.delivered.turnId,
            userMessageOrdinal: result.delivered.turnId === previousTurnId ? ordinal : 0 })
          conversationDeliveries.observe(threadId, persistedMessagesByThreadId.value[threadId] ?? [])
        } else {
          appendOptimisticUserMessage(threadId, message.text, message.imageUrls, message.skills, message.fileAttachments,
            { ...result.delivered, userMessageOrdinal: result.delivered.turnId === previousTurnId ? ordinal : 0 })
        }
        markThreadHistoryDirty(threadId)
        scheduleDelayedTurnSync(threadId)
      }
    } catch (cause) {
      if (showDelivery && conversationDeliveries.rows.value.find(row => row.id === messageId)?.status === 'submitting') {
        conversationDeliveries.patch(messageId, { status: 'unknown', error: String(cause) })
      }
      void refreshQueueState().catch(() => {})
    }
  }

  async function beginQueuedMessageEdit(messageId: string): Promise<QueuedMessage | null> {
    const threadId = selectedThreadId.value
    const message = queuedMessagesByThreadId.value[threadId]?.find(row => row.id === messageId)
    if (!message?.delivery) return null
    if (message.delivery.status === 'editing') return message
    try {
      const result = await commitQueueOperation({ type: 'edit', threadId, messageId, revision: message.delivery.revision, editToken: createDeliveryId() })
      return result.state[threadId]?.find(row => row.id === messageId) ?? null
    } catch {
      void refreshQueueState().catch(() => {})
      return null
    }
  }

  async function updateQueuedMessage(threadId: string, messageId: string, revision: number, editToken: string, contents: Pick<QueuedMessage, 'text' | 'imageUrls' | 'skills' | 'fileAttachments'>): Promise<void> {
    await commitQueueOperation({ type: 'update', threadId, messageId, revision, editToken, message: { ...contents, id: messageId, collaborationMode: 'default' } })
  }

  function steerQueuedMessage(messageId: string): Promise<void> {
    return changeQueuedMessage(messageId, 'steer')
  }

  function primeSelectedThread(threadId: string, options: { persist?: boolean } = {}): void {
    setSelectedThreadId(threadId, options)
  }

  return {
    webPreferenceState, webPreferenceError, webDefaultChoice, configureWebDefaults, initializeWebConversation,
    webDefaultsProvider: computed(() => readProviderIdForThread(selectedThreadId.value)),
    projectGroups,
    projectDisplayNameById,
    selectedThread,
    selectedThreadTokenUsage,
    selectedThreadTerminalOpen,
    isSelectedThreadInterruptPending,
    selectedThreadServerRequests,
    selectedLiveOverlay,
    codexQuota,
    selectedThreadId,
    availableCollaborationModes,
    availableModelIds,
    availableModels,
    modelCatalogError,
    reportedModel,
    selectedCollaborationMode,
    selectedModelId,
    selectedReasoningEffort,
    selectedSpeedMode,
    codexCliMissingError,
    installedSkills,
    accountRateLimitSnapshots,
    messages,
    hasMoreOlderMessages,
    threadSearchVersion,
    isLoadingThreads,
    isThreadListFullyLoaded,
    isLoadingMessages,
    isLoadingOlderMessages,
    isSendingMessage,
    isInterruptingTurn,
    isUpdatingSpeedMode,
    isRollingBack,

    error,
    refreshAll,
    refreshSkills,
    selectThread,
    markThreadAsRead,
    loadMessages,
    loadOlderMessages,
    ensureThreadMessagesLoaded,
    setThreadTerminalOpen,
    toggleSelectedThreadTerminal,
    archiveThreadById,
    renameThreadById,
    forkThreadById,
    forkThreadFromTurn,
    rollbackSelectedThread,

    sendMessageToSelectedThread,
    sendMessageToNewThread,
    interruptSelectedThreadTurn,
    selectedThreadQueuedMessages,
    selectedThreadQueueError,
    queueStateError,
    removeQueuedMessage,
    beginQueuedMessageEdit,
    updateQueuedMessage,
    changeQueuedMessage,
    refreshQueueState,
    reorderQueuedMessage,
    steerQueuedMessage,
    setSelectedCollaborationMode,
    readModelIdForThread,
    setSelectedModelIdForThread,
    setSelectedModelId,

    setSelectedReasoningEffort,
    updateSelectedSpeedMode,
    selectedAuthRecovery,
    respondToPendingServerRequest,
    answerAsyncQuestions,
    renameProject,
    removeProject,
    reorderProject,
    pinProjectToTop,
    startPolling,
    stopPolling,
    primeSelectedThread,
  }
}
