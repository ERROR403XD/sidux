import type { ThreadSearchMode } from '../threadSearchMatch'
import { normalizeResetCredits } from '../accountResetCredits'
import { normalizeInstalledApps, readDirectoryPages, type InstalledDirectoryApp, type DirectoryMcpSnapshot } from '../directory'
import { prepareWebDelivery, submitRememberedDelivery } from './deliveryOutbox'
import { createDeliveryId } from '../delivery'
import { observeCompactionHistory, restoreTrackedCompactionMessage } from './threadCompaction'
import { loadModelCatalog, type ModelCatalogOptions } from './modelCatalog'
export { invalidateModelCatalog } from './modelCatalog'
import { capabilityValue } from '../modelCapabilities.js'
import { normalizeThreadQueueState, type ThreadQueueState, type ThreadQueueOperation, type ThreadQueueResult } from '../threadQueue'
export type { StoredQueuedMessage, ThreadQueueState } from '../threadQueue'
import {
  fetchRpcMethodCatalog,
  fetchRpcNotificationCatalog,
  fetchPendingServerRequests,
  rpcCall,
  respondServerRequest,
  subscribeRpcNotifications,
  type RpcNotification,
} from './codexRpcClient'
import type {
  CollaborationModeListResponse,
  ConfigReadResponse,
  GetAccountRateLimitsResponse,
  ReasoningEffort,
  ThreadForkResponse,
  ThreadListResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadStartResponse,
  Turn,
} from './appServerDtos'
import { extractErrorMessage, normalizeCodexApiError } from './codexErrors'
import {
  readActiveTurnIdFromResponse,
  normalizeThreadGroupsV2,
  normalizeThreadMessagesV2 as normalizeNativeThreadMessagesV2,
  normalizeThreadSummaryV2,
  readThreadInProgressFromResponse,
} from './normalizers/v2'
import type {
  SpeedMode,
  UiAccountEntry,
  UiAccountQuotaStatus,
  UiAccountUnavailableReason,
  CollaborationModeKind,
  CollaborationModeOption,
  UiCreditsSnapshot,
  UiFileChange,
  UiMessage,
  UiProjectGroup,
  UiThread,
  UiReviewAction,
  UiReviewActionLevel,
  UiReviewFile,
  UiReviewFinding,
  UiReviewHunk,
  UiReviewLine,
  UiReviewResult,
  UiReviewScope,
  UiReviewSnapshot,
  UiReviewSummary,
  UiReviewWorkspaceView,
  UiRateLimitSnapshot,
  UiRateLimitWindow,
  UiThreadAutomation,
  UiThreadAutomationStatus,
} from '../types/codex'
import { normalizePathForUi } from '../pathUtils.js'

type CurrentModelConfig = {
  model: string
  providerId: string
  reasoningEffort: ReasoningEffort | ''
  speedMode: SpeedMode
}

export type DirectoryPluginSummary = {
  id: string
  name: string
  displayName: string
  description: string
  longDescription: string
  developerName: string
  category: string
  marketplaceName: string
  marketplaceDisplayName: string
  marketplacePath: string | null
  remoteMarketplaceName: string | null
  sourceType: string
  sourceUrl: string
  installed: boolean
  enabled: boolean
  availability: string
  disabledReason: string
  installPolicy: string
  authPolicy: string
  logoUrl: string
  logoPath: string
  composerIconUrl: string
  composerIconPath: string
  brandColor: string
  capabilities: string[]
  defaultPrompt: string[]
  screenshotUrls: string[]
  screenshots: string[]
  websiteUrl: string
  privacyPolicyUrl: string
  termsOfServiceUrl: string
}

export type DirectoryPluginDetail = {
  summary: DirectoryPluginSummary
  description: string
  apps: DirectoryPluginAppSummary[]
  skills: DirectoryPluginSkillSummary[]
  mcpServers: string[]
}

export type DirectoryPluginAppSummary = {
  id: string
  name: string
  description: string
  installUrl: string
  needsAuth: boolean
}

export type DirectoryPluginSkillSummary = {
  name: string
  description: string
  path: string
  enabled: boolean
  displayName: string
  shortDescription: string
}

export type DirectoryPluginInstallResult = {
  authPolicy: string
  appsNeedingAuth: DirectoryPluginAppSummary[]
}

export type DirectoryAppInfo = {
  runtimeOnly?: boolean
  id: string
  name: string
  description: string
  logoUrl: string
  logoUrlDark: string
  distributionChannel: string
  installUrl: string
  isAccessible: boolean
  isEnabled: boolean
  pluginDisplayNames: string[]
  category: string
  developer: string
  website: string
  privacyPolicy: string
  termsOfService: string
  catalogRank: number
}

export type DirectoryMcpServerStatus = DirectoryMcpSnapshot

export type DirectoryMcpLoginResult = {
  authorizationUrl: string
}

export type ComposerPromptInfo = {
  name: string
  path: string
  content: string
  description: string
}


type ResolvedCollaborationModeSettings = {
  model: string
  reasoningEffort: ReasoningEffort | null
}

function normalizePlanModeReasoningEffort(value: ReasoningEffort | '' | null | undefined): ReasoningEffort | null {
  return value && value.length > 0 ? value : null
}

function normalizeCollaborationModeReasoningEffort(value: ReasoningEffort | '' | null | undefined): ReasoningEffort | null {
  return value && value.length > 0 ? value : null
}

export type WorkspaceRootsState = {
  order: string[]
  labels: Record<string, string>
  active: string[]
  projectOrder: string[]
  remoteProjects?: Array<{
    id: string
    hostId: string
    remotePath: string
    label: string
  }>
}

let workspaceRootsStatePromise: Promise<WorkspaceRootsState> | null = null
let cachedWorkspaceRootsState: WorkspaceRootsState | null = null

export type ComposerFileSuggestion = {
  path: string
}

const DEFAULT_COLLABORATION_MODE_OPTIONS: CollaborationModeOption[] = [
  { value: 'default', label: 'Default' },
  { value: 'plan', label: 'Plan' },
]

export type WorktreeCreateResult = {
  cwd: string
  branch: string | null
  gitRoot: string
}

export type WorktreeBranchOption = {
  value: string
  label: string
  isCurrent?: boolean
  isRemote?: boolean
}

export type GitBranchState = {
  currentBranch: string | null
  headSha: string | null
  headSubject: string | null
  headDate: string | null
  detached: boolean
  dirty: boolean
  gitRoot: string
  options: WorktreeBranchOption[]
}

export type GitCommitOption = {
  sha: string
  shortSha: string
  subject: string
  date: string
}

export type GitCommitFileChange = {
  path: string
  previousPath: string | null
  status: string
  label: string
  addedLineCount: number | null
  removedLineCount: number | null
}

export type GitRepositoryStatus = {
  isGitRepo: boolean
  gitRoot: string
}



export type ThreadSearchResult = {
  groups?: UiProjectGroup[]
  threadIds: string[]
  indexedThreadCount: number
  titleScopeComplete?: boolean
  bodyThreadCount?: number
  bodyTurnLimit?: number
  bodyThreadLimit?: number
  partialBodyCount?: number
  failedBodyCount?: number
}

export type TelegramStatus = {
  configured: boolean
  active: boolean
  mappedChats: number
  mappedThreads: number
  allowedUsers: number
  allowAllUsers: boolean
  lastError: string
}

export type TelegramConfig = {
  botToken: string
  notificationsEnabled: boolean
  quietEnabled: boolean
  quietStart: string
  quietEnd: string
  timezone: string
  allowedUserIds: Array<number | '*'>
}

export type LocalDirectoryEntry = {
  name: string
  path: string
}

export type LocalDirectoryListing = {
  path: string
  parentPath: string
  entries: LocalDirectoryEntry[]
}

export type ThreadTerminalSession = {
  id: string
  threadId: string
  cwd: string
  shell: string
  buffer: string
  truncated: boolean
}

export type ThreadTerminalAttachInput = {
  threadId: string
  cwd: string
  sessionId?: string
  cols?: number
  rows?: number
  newSession?: boolean
}

export type ThreadTerminalQuickCommand = {
  label: string
  value: string
  source: 'package' | 'script' | 'make'
}

export type AccountsListResult = {
  activeAccountId: string | null
  activeStorageId: string | null
  accounts: UiAccountEntry[]
  importedAccountId?: string
  importedStorageId?: string
  operation?: { kind: string; storageId: string | null; startedAt: number } | null
}

export type AccountLoginStartResult = { loginSessionId: string; loginUrl: string; method?: 'link' | 'device'; userCode?: string | null; expiresAt?: string }
export type AccountLoginStatus = AccountLoginStartResult & {
  intent: 'add' | 'reauth'; targetStorageId: string | null
  status: 'waiting' | 'verifying' | 'completed' | 'failed' | 'expired'
  error: string | null; result?: AccountLoginCompleteResult
}
export async function getCodexLoginStatus(): Promise<AccountLoginStatus | null> {
  const response = await fetch('/codex-api/accounts/login/status', { cache: 'no-store' })
  const payload = await response.json()
  if (!response.ok) throw new Error(getErrorMessageFromPayload(payload, '读取登录状态失败。'))
  return payload.data ?? null
}
export type AccountLoginCompleteResult = AccountsListResult & {
  outcome: 'added' | 'reauthenticated'
  account: UiAccountEntry
  poolSize: number
}

export type AccountSwitchResult = {
  account: UiAccountEntry
  activeStorageId: string
  workspaceContinuity: { checked: boolean; restored: boolean; threadId: string | null }
}

type ThreadFileChangeFallbackEntry = {
  turnId: string
  turnIndex: number
  fileChanges: UiFileChange[]
}

type ThreadTurnIndexById = Record<string, number>

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : []
}

function normalizeAccountUnavailableReason(value: unknown): UiAccountUnavailableReason | null {
  return value === 'payment_required' || value === 'reauth_required' ? value : null
}

function normalizeAccountAuthStatus(value: unknown): UiAccountEntry['authStatus'] {
  return value === 'refreshing' || value === 'switching' || value === 'reauth_required' || value === 'payment_required'
    || value === 'stale' || value === 'transient_error' || value === 'materialization_dirty'
    ? value
    : 'ready'
}

function isPaymentRequiredErrorMessage(value: string | null): boolean {
  if (!value) return false
  const normalized = value.toLowerCase()
  return normalized.includes('payment required') || /\b402\b/.test(normalized)
}

function normalizeRateLimitWindow(value: unknown): UiRateLimitWindow | null {
  const record = asRecord(value)
  if (!record) return null

  const usedPercent = readNumber(record.usedPercent ?? record.used_percent)
  if (usedPercent === null) return null

  const windowValue = readNumber(record.windowDurationMins ?? record.windowMinutes ?? record.window_minutes)
  return {
    usedPercent,
    windowDurationMins: windowValue,
    windowMinutes: windowValue,
    resetsAt: readNumber(record.resetsAt ?? record.resets_at),
  }
}

function normalizeCreditsSnapshot(value: unknown): UiCreditsSnapshot | null {
  const record = asRecord(value)
  if (!record) return null

  const hasCredits = readBoolean(record.hasCredits ?? record.has_credits)
  const unlimited = readBoolean(record.unlimited)
  if (hasCredits === null || unlimited === null) return null

  return {
    hasCredits,
    unlimited,
    balance: readString(record.balance),
  }
}

function normalizeRateLimitSnapshot(value: unknown): UiRateLimitSnapshot | null {
  const record = asRecord(value)
  if (!record) return null

  const primary = normalizeRateLimitWindow(record.primary)
  const secondary = normalizeRateLimitWindow(record.secondary)
  const credits = normalizeCreditsSnapshot(record.credits)

  if (!primary && !secondary && !credits) return null

  return {
    limitId: readString(record.limitId ?? record.limit_id),
    limitName: readString(record.limitName ?? record.limit_name),
    primary,
    secondary,
    credits,
    planType: readString(record.planType ?? record.plan_type),
  }
}

export function normalizeAccountEntry(
  value: unknown,
  activeAccountId: string | null = null,
  activeStorageId: string | null = null,
): UiAccountEntry | null {
  const record = asRecord(value)
  if (!record) return null
  const accountId = readString(record.accountId)
  const storageId = readString(record.storageId) ?? accountId
  const quotaStatusRaw = readString(record.quotaStatus)
  const quotaStatus: UiAccountQuotaStatus =
    quotaStatusRaw === 'loading' || quotaStatusRaw === 'ready' || quotaStatusRaw === 'error' ? quotaStatusRaw : 'idle'
  if (!accountId) return null
  return {
    accountId,
    storageId: storageId ?? accountId,
    alias: readString(record.alias) ?? '',
    userId: readString(record.userId),
    authMode: readString(record.authMode),
    email: readString(record.email),
    planType: readString(record.planType),
    credentialRevision: Math.max(0, Math.trunc(readNumber(record.credentialRevision) ?? 0)),
    authStatus: normalizeAccountAuthStatus(record.authStatus),
    lastVerifiedAtIso: readString(record.lastVerifiedAtIso),
    lastRefreshedAtIso: readString(record.lastRefreshedAtIso) ?? '',
    lastActivatedAtIso: readString(record.lastActivatedAtIso),
    quotaSnapshot: normalizeRateLimitSnapshot(record.quotaSnapshot),
    resetCredits: normalizeResetCredits(record.resetCredits),
    protectionPercent: readNumber(record.protectionPercent) ?? 0,
    quotaUpdatedAtIso: readString(record.quotaUpdatedAtIso),
    quotaStatus,
    quotaError: readString(record.quotaError),
    unavailableReason: normalizeAccountUnavailableReason(record.unavailableReason)
      ?? (isPaymentRequiredErrorMessage(readString(record.quotaError)) ? 'payment_required' : null),
    canSwitch: readBoolean(record.canSwitch) ?? true,
    actionRequired: record.actionRequired === 'reauthenticate' || record.actionRequired === 'resolve_payment' || record.actionRequired === 'repair_active_credential'
      ? record.actionRequired
      : null,
    isActive: readBoolean(record.isActive) ?? (storageId === activeStorageId || accountId === activeAccountId),
  }
}

export function pickCodexRateLimitSnapshot(payload: unknown): UiRateLimitSnapshot | null {
  const record = asRecord(payload)
  if (!record) return null

  const rateLimitsByLimitId = asRecord(record.rateLimitsByLimitId ?? record.rate_limits_by_limit_id)
  const codexBucket = normalizeRateLimitSnapshot(rateLimitsByLimitId?.codex)
  if (codexBucket) return codexBucket

  return normalizeRateLimitSnapshot(record.rateLimits ?? record.rate_limits)
}

async function callRpc<T>(method: string, params?: unknown): Promise<T> {
  try {
    const result = await rpcCall<T>(method, params)
    if (method === 'thread/read' || method === 'thread/resume') observeCompactionHistory(result)
    return result
  } catch (error) {
    throw normalizeCodexApiError(error, `RPC ${method} failed`, method)
  }
}

function normalizeThreadMessagesV2(payload: ThreadReadResponse, startTurnIndex = 0): UiMessage[] {
  return restoreTrackedCompactionMessage(normalizeNativeThreadMessagesV2(payload, startTurnIndex), payload, startTurnIndex)
}

function normalizeFallbackFileChange(value: unknown): UiFileChange | null {
  const record = asRecord(value)
  if (!record) return null

  const path = readString(record.path)
  const operation = readString(record.operation)
  if (!path || (operation !== 'add' && operation !== 'delete' && operation !== 'update')) {
    return null
  }

  return {
    path,
    operation,
    movedToPath: readString(record.movedToPath) ?? null,
    diff: readString(record.diff) ?? '',
    addedLineCount: readNumber(record.addedLineCount) ?? 0,
    removedLineCount: readNumber(record.removedLineCount) ?? 0,
  }
}

function normalizeThreadFileChangeFallback(value: unknown): ThreadFileChangeFallbackEntry[] {
  const payload = asRecord(value)
  const rows = Array.isArray(payload?.data) ? payload.data : []
  const normalized: ThreadFileChangeFallbackEntry[] = []

  for (const row of rows) {
    const record = asRecord(row)
    if (!record) continue

    const turnId = readString(record.turnId)
    const turnIndex = readNumber(record.turnIndex)
    const fileChanges = Array.isArray(record.fileChanges)
      ? record.fileChanges
        .map((entry) => normalizeFallbackFileChange(entry))
        .filter((entry): entry is UiFileChange => entry !== null)
      : []

    if (!turnId || turnIndex === null || fileChanges.length === 0) continue
    normalized.push({ turnId, turnIndex, fileChanges })
  }

  return normalized
}

function buildTurnIndexByTurnId(payload: ThreadReadResponse, baseTurnIndex = 0): ThreadTurnIndexById {
  const turns = Array.isArray(payload.thread.turns) ? payload.thread.turns : []
  const lookup: ThreadTurnIndexById = {}

  for (let turnOffset = 0; turnOffset < turns.length; turnOffset += 1) {
    const turnIndex = baseTurnIndex + turnOffset
    const turn = turns[turnOffset]
    if (typeof turn?.id !== 'string' || turn.id.length === 0) continue
    lookup[turn.id] = turnIndex
  }

  return lookup
}

function readThreadTurnStartIndex(payload: ThreadReadResponse): number {
  const record = asRecord(payload)
  const raw = record?.threadTurnStartIndex
  return Math.max(0, Math.floor(typeof raw === 'number' ? raw : 0))
}

async function fetchThreadFileChangeFallback(threadId: string): Promise<ThreadFileChangeFallbackEntry[]> {
  const response = await fetch(`/codex-api/thread-file-change-fallback?threadId=${encodeURIComponent(threadId)}`)
  if (!response.ok) {
    throw new Error(`Fallback request failed with ${response.status}`)
  }
  return normalizeThreadFileChangeFallback(await response.json())
}

function mergeRecoveredFileChangeMessages(messages: UiMessage[], fallbackEntries: ThreadFileChangeFallbackEntry[]): UiMessage[] {
  if (fallbackEntries.length === 0) return messages

  const localTurnIndexByTurnId = new Map<string, number>()
  const coveredTurnIds = new Set<string>()

  for (const message of messages) {
    const tid = typeof message.turnId === 'string' && message.turnId.length > 0 ? message.turnId : undefined
    const tIdx = typeof message.turnIndex === 'number' ? message.turnIndex : undefined
    if (tid && tIdx !== undefined) localTurnIndexByTurnId.set(tid, tIdx)

    const hasFileData =
      message.messageType === 'fileChange' ||
      (Array.isArray(message.fileChanges) && message.fileChanges.length > 0)
    if (hasFileData && tid) coveredTurnIds.add(tid)
  }

  const extraMessages = fallbackEntries
    .filter((entry) => localTurnIndexByTurnId.has(entry.turnId) && !coveredTurnIds.has(entry.turnId))
    .map<UiMessage>((entry) => ({
      id: `session-file-change:${entry.turnId}`,
      role: 'system',
      text: '',
      messageType: 'fileChange',
      fileChangeStatus: 'completed',
      fileChanges: entry.fileChanges,
      turnId: entry.turnId,
      turnIndex: localTurnIndexByTurnId.get(entry.turnId) ?? entry.turnIndex,
    }))

  if (extraMessages.length === 0) return messages

  const extrasByTurnIndex = new Map<number, UiMessage[]>()
  for (const message of extraMessages) {
    const turnIndex = message.turnIndex
    if (typeof turnIndex !== 'number') continue
    const current = extrasByTurnIndex.get(turnIndex)
    if (current) current.push(message)
    else extrasByTurnIndex.set(turnIndex, [message])
  }

  const insertedTurnIndices = new Set<number>()
  const merged: UiMessage[] = []

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    merged.push(message)

    const turnIndex = message.turnIndex
    if (typeof turnIndex !== 'number' || insertedTurnIndices.has(turnIndex)) continue
    const nextTurnIndex = messages[index + 1]?.turnIndex
    if (nextTurnIndex === turnIndex) continue

    const extras = extrasByTurnIndex.get(turnIndex)
    if (!extras || extras.length === 0) continue

    merged.push(...extras)
    insertedTurnIndices.add(turnIndex)
  }

  return merged
}

async function enrichThreadMessagesWithFallback(threadId: string, messages: UiMessage[]): Promise<UiMessage[]> {
  try {
    const fallbackEntries = await fetchThreadFileChangeFallback(threadId)
    return mergeRecoveredFileChangeMessages(messages, fallbackEntries)
  } catch {
    return messages
  }
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | '' {
  return capabilityValue(value)
}

function normalizeSpeedMode(value: unknown): SpeedMode {
  return capabilityValue(value)
}

const INITIAL_THREAD_LIST_LIMIT = 50
const BACKGROUND_THREAD_LIST_LIMIT = 100

export type ThreadGroupsPage = {
  groups: UiProjectGroup[]
  nextCursor: string | null
}

export type ThreadHistoryPosition = { nextCursor: string | null; source: 'native' | 'legacy' }

function readHistoryPosition(payload: unknown): ThreadHistoryPosition {
  const history = asRecord(asRecord(payload)?.threadHistory)
  return { nextCursor: typeof history?.nextCursor === 'string' ? history.nextCursor : null, source: history?.source === 'native' ? 'native' : 'legacy' }
}

function readHasMoreHistory(payload: ThreadReadResponse): boolean {
  return asRecord(asRecord(payload)?.threadHistory)?.hasMoreOlder === true || readThreadTurnStartIndex(payload) > 0
}

export type ThreadTurnPage = {
  messages: UiMessage[]
  inProgress: boolean
  activeTurnId: string
  hasMoreOlder: boolean
  historyPosition?: ThreadHistoryPosition
  startTurnIndex: number
  turnIndexByTurnId: ThreadTurnIndexById
}

async function getThreadGroupsPageV2(cursor: string | null, limit: number): Promise<ThreadGroupsPage> {
  const payload = await callRpc<ThreadListResponse>('thread/list', {
    archived: false,
    limit,
    sortKey: 'updated_at',
    modelProviders: [],
    cursor,
  })
  return {
    groups: normalizeThreadGroupsV2(payload),
    nextCursor: typeof payload.nextCursor === 'string' && payload.nextCursor.length > 0
      ? payload.nextCursor
      : null,
  }
}

async function getThreadMessagesV2(threadId: string): Promise<UiMessage[]> {
  const payload = await callRpc<ThreadReadResponse>('thread/read', {
    threadId,
    includeTurns: true,
  })
  return normalizeThreadMessagesV2(payload, readThreadTurnStartIndex(payload))
}

async function getThreadSummaryV2(threadId: string): Promise<UiThread> {
  const payload = await callRpc<ThreadReadResponse>('thread/read', {
    threadId,
    includeTurns: false,
  })
  return normalizeThreadSummaryV2(payload)
}

function readLoadedThreadSummary(payload: ThreadReadResponse): UiThread | undefined {
  const thread = payload.thread
  if (!thread || typeof thread.cwd !== 'string' || !Number.isFinite(thread.createdAt) || !Number.isFinite(thread.updatedAt)) return undefined
  return normalizeThreadSummaryV2(payload)
}

async function getThreadDetailV2(threadId: string): Promise<{
  thread?: UiThread
  model: string
  modelProvider: string
  messages: UiMessage[]
  inProgress: boolean
  activeTurnId: string
  hasMoreOlder: boolean
  historyPosition?: ThreadHistoryPosition
  turnIndexByTurnId: ThreadTurnIndexById
}> {
  const payload = await callRpc<ThreadReadResponse>('thread/read', {
    threadId,
    includeTurns: true,
  })
  const startTurnIndex = readThreadTurnStartIndex(payload)
  const normalized = normalizeThreadMessagesV2(payload, startTurnIndex)
  return {
    thread: readLoadedThreadSummary(payload),
    model: normalizeThreadModelFromPayload(payload),
    modelProvider: normalizeThreadModelProviderFromPayload(payload),
    messages: normalized,
    inProgress: readThreadInProgressFromResponse(payload),
    activeTurnId: readActiveTurnIdFromResponse(payload),
    hasMoreOlder: readHasMoreHistory(payload),
    historyPosition: readHistoryPosition(payload),
    turnIndexByTurnId: buildTurnIndexByTurnId(payload, startTurnIndex),
  }
}

async function getOlderThreadMessagesV2(threadId: string, beforeTurnId: string, limit = 10, position?: ThreadHistoryPosition): Promise<ThreadTurnPage> {
  const params = new URLSearchParams({
    threadId,
    beforeTurnId,
    limit: String(limit),
  })
  if (position?.nextCursor) params.set('cursor', position.nextCursor)
  if (position?.source) params.set('source', position.source)
  const response = await fetch(`/codex-api/thread-turn-page?${params.toString()}`)
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(data.error || `Older thread page request failed with ${response.status}`)
  }
  const payload = await response.json() as {
    result?: ThreadReadResponse
    hasMoreOlder?: unknown
    nextCursor?: unknown
    source?: unknown
    startTurnIndex?: unknown
  }
  if (!payload.result) {
    throw new Error('Older thread page response did not include a thread result')
  }
  const startTurnIndex = Math.max(0, Math.floor(typeof payload.startTurnIndex === 'number' ? payload.startTurnIndex : 0))

  return {
    messages: normalizeThreadMessagesV2(payload.result, startTurnIndex),
    inProgress: readThreadInProgressFromResponse(payload.result),
    activeTurnId: readActiveTurnIdFromResponse(payload.result),
    hasMoreOlder: payload.hasMoreOlder === true,
    historyPosition: { nextCursor: typeof payload.nextCursor === 'string' ? payload.nextCursor : null, source: payload.source === 'native' ? 'native' : 'legacy' },
    startTurnIndex,
    turnIndexByTurnId: buildTurnIndexByTurnId(payload.result, startTurnIndex),
  }
}

export async function getThreadGroups(): Promise<UiProjectGroup[]> {
  try {
    return (await getThreadGroupsPageV2(null, INITIAL_THREAD_LIST_LIMIT)).groups
  } catch (error) {
    throw normalizeCodexApiError(error, 'Failed to load thread groups', 'thread/list')
  }
}

export async function getThreadGroupsPage(
  cursor: string | null = null,
  limit = INITIAL_THREAD_LIST_LIMIT,
): Promise<ThreadGroupsPage> {
  try {
    return await getThreadGroupsPageV2(cursor, limit)
  } catch (error) {
    throw normalizeCodexApiError(error, 'Failed to load thread groups', 'thread/list')
  }
}

export function getBackgroundThreadListLimit(): number {
  return BACKGROUND_THREAD_LIST_LIMIT
}

export async function getThreadMessages(threadId: string): Promise<UiMessage[]> {
  try {
    return await getThreadMessagesV2(threadId)
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to load thread ${threadId}`, 'thread/read')
  }
}

export async function getThreadSummary(threadId: string): Promise<UiThread> {
  try {
    return await getThreadSummaryV2(threadId)
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to load thread ${threadId}`, 'thread/read')
  }
}

export async function getThreadDetail(threadId: string): Promise<{
  thread?: UiThread
  model: string
  modelProvider: string
  messages: UiMessage[]
  inProgress: boolean
  activeTurnId: string
  hasMoreOlder: boolean
  historyPosition?: ThreadHistoryPosition
  turnIndexByTurnId: ThreadTurnIndexById
}> {
  try {
    return await getThreadDetailV2(threadId)
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to load thread ${threadId}`, 'thread/read')
  }
}

export async function getOlderThreadMessages(threadId: string, beforeTurnId: string, limit?: number, position?: ThreadHistoryPosition): Promise<ThreadTurnPage> {
  try {
    return await getOlderThreadMessagesV2(threadId, beforeTurnId, limit, position)
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to load earlier messages for thread ${threadId}`, 'thread/read')
  }
}

function normalizeReviewLine(value: unknown): UiReviewLine | null {
  const record = asRecord(value)
  if (!record) return null

  const key = readString(record.key)
  const text = typeof record.text === 'string' ? record.text : ''
  const kind = readString(record.kind)
  if (!key || !kind) return null
  if (kind !== 'meta' && kind !== 'hunk' && kind !== 'add' && kind !== 'remove' && kind !== 'context') {
    return null
  }

  return {
    key,
    kind,
    text,
    oldLine: readNumber(record.oldLine),
    newLine: readNumber(record.newLine),
  }
}

function normalizeReviewHunk(value: unknown): UiReviewHunk | null {
  const record = asRecord(value)
  if (!record) return null

  const id = readString(record.id)
  const header = typeof record.header === 'string' ? record.header : ''
  const patch = typeof record.patch === 'string' ? record.patch : ''
  if (!id) return null

  return {
    id,
    header,
    patch,
    addedLineCount: readNumber(record.addedLineCount) ?? 0,
    removedLineCount: readNumber(record.removedLineCount) ?? 0,
    oldStart: readNumber(record.oldStart),
    oldLineCount: readNumber(record.oldLineCount) ?? 0,
    newStart: readNumber(record.newStart),
    newLineCount: readNumber(record.newLineCount) ?? 0,
    lines: Array.isArray(record.lines)
      ? record.lines
        .map((entry) => normalizeReviewLine(entry))
        .filter((entry): entry is UiReviewLine => entry !== null)
      : [],
  }
}

function normalizeReviewFile(value: unknown): UiReviewFile | null {
  const record = asRecord(value)
  if (!record) return null

  const id = readString(record.id)
  const path = readString(record.path)
  const absolutePath = readString(record.absolutePath)
  const operation = readString(record.operation)
  if (!id || !path || !absolutePath || !operation) return null
  if (operation !== 'add' && operation !== 'delete' && operation !== 'update' && operation !== 'rename') {
    return null
  }

  return {
    id,
    path,
    absolutePath,
    previousPath: readString(record.previousPath),
    previousAbsolutePath: readString(record.previousAbsolutePath),
    operation,
    addedLineCount: readNumber(record.addedLineCount) ?? 0,
    removedLineCount: readNumber(record.removedLineCount) ?? 0,
    diff: typeof record.diff === 'string' ? record.diff : '',
    hunks: Array.isArray(record.hunks)
      ? record.hunks
        .map((entry) => normalizeReviewHunk(entry))
        .filter((entry): entry is UiReviewHunk => entry !== null)
      : [],
  }
}

function normalizeReviewSnapshot(payload: unknown): UiReviewSnapshot {
  const envelope = asRecord(payload)
  const data = asRecord(envelope?.data)
  const summaryRecord = asRecord(data?.summary)
  const rawScope = readString(data?.scope)
  const scope = rawScope === 'baseBranch' || rawScope === 'commit' ? rawScope : 'workspace'
  const workspaceView = readString(data?.workspaceView) === 'staged' ? 'staged' : 'unstaged'

  return {
    cwd: readString(data?.cwd) ?? '',
    gitRoot: readString(data?.gitRoot),
    isGitRepo: readBoolean(data?.isGitRepo) ?? false,
    scope,
    workspaceView,
    baseBranch: readString(data?.baseBranch),
    baseBranchOptions: Array.isArray(data?.baseBranchOptions)
      ? data.baseBranchOptions
        .map((entry) => readString(entry))
        .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      : [],
    commitSha: readString(data?.commitSha),
    headBranch: readString(data?.headBranch),
    mergeBaseSha: readString(data?.mergeBaseSha),
    generatedAtIso: readString(data?.generatedAtIso) ?? '',
    summary: {
      fileCount: readNumber(summaryRecord?.fileCount) ?? 0,
      addedLineCount: readNumber(summaryRecord?.addedLineCount) ?? 0,
      removedLineCount: readNumber(summaryRecord?.removedLineCount) ?? 0,
    },
    files: Array.isArray(data?.files)
      ? data.files
        .map((entry) => normalizeReviewFile(entry))
        .filter((entry): entry is UiReviewFile => entry !== null)
      : [],
  }
}

function normalizeReviewSummary(payload: unknown): UiReviewSummary {
  const envelope = asRecord(payload)
  const data = asRecord(envelope?.data)
  return {
    fileCount: readNumber(data?.fileCount) ?? 0,
    addedLineCount: readNumber(data?.addedLineCount) ?? 0,
    removedLineCount: readNumber(data?.removedLineCount) ?? 0,
  }
}

function parseReviewLocation(value: string): {
  absolutePath: string | null
  startLine: number | null
  endLine: number | null
} {
  const trimmed = value.trim()
  if (!trimmed) {
    return { absolutePath: null, startLine: null, endLine: null }
  }

  const match = trimmed.match(/^(.*?):(\d+)-(\d+)$/u)
  if (!match) {
    return { absolutePath: trimmed || null, startLine: null, endLine: null }
  }

  return {
    absolutePath: match[1]?.trim() || null,
    startLine: Number(match[2]),
    endLine: Number(match[3]),
  }
}

function parseReviewText(reviewText: string): UiReviewResult {
  const normalized = reviewText.replace(/\r\n/g, '\n').trim()
  if (!normalized) {
    return { reviewText: '', summary: '', findings: [] }
  }

  const markerIndex = normalized.search(/\n(?:Full review comments|Review comment):\n/iu)
  const summary = markerIndex >= 0 ? normalized.slice(0, markerIndex).trim() : normalized
  const findingsSection = markerIndex >= 0 ? normalized.slice(markerIndex).trim() : ''
  const findings: UiReviewFinding[] = []

  if (findingsSection) {
    const body = findingsSection
      .replace(/^(?:Full review comments|Review comment):\n*/iu, '')
      .trim()
    const matches = body.matchAll(/^- (.+?) — (.+)\n?((?:  .*(?:\n|$))*)/gmu)
    let index = 0
    for (const match of matches) {
      const title = match[1]?.trim() ?? ''
      const location = parseReviewLocation(match[2] ?? '')
      const block = (match[0] ?? '').trim()
      const findingBody = (match[3] ?? '')
        .split('\n')
        .map((line) => line.replace(/^  /u, ''))
        .join('\n')
        .trim()

      findings.push({
        id: `finding:${index}`,
        title: title || `Finding ${index + 1}`,
        body: findingBody,
        path: location.absolutePath ? location.absolutePath.split('/').filter(Boolean).slice(-1)[0] ?? location.absolutePath : null,
        absolutePath: location.absolutePath,
        startLine: location.startLine,
        endLine: location.endLine,
        rawText: block,
      })
      index += 1
    }
  }

  return {
    reviewText: normalized,
    summary,
    findings,
  }
}

function readLatestReviewItem(payload: ThreadReadResponse, type: 'enteredReviewMode' | 'exitedReviewMode'): string | null {
  const turns = Array.isArray(payload.thread.turns) ? payload.thread.turns : []
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex]
    const items = Array.isArray(turn?.items) ? turn.items : []
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex]
      if (item?.type !== type) continue
      const review = typeof item.review === 'string' ? item.review.trim() : ''
      if (review) return review
    }
  }
  return null
}

export async function getThreadReviewResult(threadId: string): Promise<{
  enteredReviewLabel: string | null
  result: UiReviewResult | null
}> {
  const payload = await callRpc<ThreadReadResponse>('thread/read', {
    threadId,
    includeTurns: true,
  })

  const exitedReview = readLatestReviewItem(payload, 'exitedReviewMode')
  return {
    enteredReviewLabel: readLatestReviewItem(payload, 'enteredReviewMode'),
    result: exitedReview ? parseReviewText(exitedReview) : null,
  }
}

export async function getMethodCatalog(): Promise<string[]> {
  return fetchRpcMethodCatalog()
}

export async function getNotificationCatalog(): Promise<string[]> {
  return fetchRpcNotificationCatalog()
}

function asAutomation(record: unknown): UiThreadAutomation | null {
  const row = asRecord(record)
  if (!row) return null
  const id = readString(row.id)
  const kind = readString(row.kind)
  const name = readString(row.name)
  const prompt = readString(row.prompt)
  const rrule = readString(row.rrule)
  const status = readString(row.status)
  if (!id || !name || !prompt || !rrule) return null
  if (kind !== 'heartbeat' && kind !== 'cron') return null
  if (status !== 'ACTIVE' && status !== 'PAUSED') return null
  return {
    id,
    kind,
    name,
    prompt,
    rrule,
    status,
    targetThreadId: readString(row.targetThreadId),
    cwds: Array.isArray(row.cwds) ? row.cwds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [],
    createdAtMs: readNumber(row.createdAtMs),
    updatedAtMs: readNumber(row.updatedAtMs),
    nextRunAtMs: readNumber(row.nextRunAtMs),
    timezone: readString(row.timezone) ?? undefined,
    model: readString(row.model) ?? undefined,
    reasoningEffort: readString(row.reasoningEffort) as UiThreadAutomation['reasoningEffort'],
    serviceTier: readString(row.serviceTier) || undefined,
    accountStorageId: readString(row.accountStorageId) || null,
    protected: row.protected === true,
  }
}

function asAutomationArray(value: unknown): UiThreadAutomation[] {
  if (Array.isArray(value)) return value.flatMap((item) => {
    const automation = asAutomation(item)
    return automation ? [automation] : []
  })
  const automation = asAutomation(value)
  return automation ? [automation] : []
}

export async function getThreadAutomationMap(): Promise<Record<string, UiThreadAutomation[]>> {
  const response = await fetch('/codex-api/thread-automations')
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, 'Failed to load thread automations'))
  }
  const data = asRecord(asRecord(payload)?.data)
  const next: Record<string, UiThreadAutomation[]> = {}
  if (!data) return next
  for (const [threadId, value] of Object.entries(data)) {
    const automations = asAutomationArray(value)
    if (automations.length > 0) next[threadId] = automations
  }
  return next
}

export async function getProjectAutomationMap(): Promise<Record<string, UiThreadAutomation[]>> {
  const response = await fetch('/codex-api/project-automations')
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, 'Failed to load project automations'))
  }
  const data = asRecord(asRecord(payload)?.data)
  const next: Record<string, UiThreadAutomation[]> = {}
  if (!data) return next
  for (const [projectName, value] of Object.entries(data)) {
    const automations = asAutomationArray(value)
    if (automations.length > 0) next[projectName] = automations
  }
  return next
}

export async function getThreadAutomation(threadId: string, automationId?: string): Promise<UiThreadAutomation | null> {
  const query = new URLSearchParams({ threadId })
  if (automationId) query.set('automationId', automationId)
  const response = await fetch(`/codex-api/thread-automation?${query.toString()}`)
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, 'Failed to load thread automation'))
  }
  const data = asRecord(payload)?.data
  if (automationId) return asAutomation(data)
  return asAutomationArray(data)[0] ?? null
}

export async function upsertThreadAutomation(input: {
  threadId: string
  id?: string
  name: string
  prompt: string
  rrule: string
  status: UiThreadAutomationStatus
  accountStorageId?: string | null
  protected?: boolean
  timezone?: string
  model?: string | null
  serviceTier?: string | null
  reasoningEffort?: string | null
}): Promise<UiThreadAutomation> {
  const response = await fetch('/codex-api/thread-automation', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, 'Failed to save thread automation'))
  }
  const automation = asAutomation(asRecord(payload)?.data)
  if (!automation) throw new Error('Thread automation response was malformed')
  return automation
}

export async function upsertProjectAutomation(input: {
  projectName: string
  id?: string
  name: string
  prompt: string
  rrule: string
  status: UiThreadAutomationStatus
  accountStorageId?: string | null
  protected?: boolean
  timezone?: string
  model?: string | null
  serviceTier?: string | null
  reasoningEffort?: string | null
}): Promise<UiThreadAutomation> {
  const response = await fetch('/codex-api/project-automation', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, 'Failed to save project automation'))
  }
  const automation = asAutomation(asRecord(payload)?.data)
  if (!automation) throw new Error('Project automation response was malformed')
  return automation
}

export async function deleteThreadAutomation(threadId: string, automationId?: string): Promise<void> {
  const query = new URLSearchParams({ threadId })
  if (automationId) query.set('automationId', automationId)
  const response = await fetch(`/codex-api/thread-automation?${query.toString()}`, {
    method: 'DELETE',
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, 'Failed to delete thread automation'))
  }
}

export async function deleteProjectAutomation(projectName: string, automationId?: string): Promise<void> {
  const query = new URLSearchParams({ projectName })
  if (automationId) query.set('automationId', automationId)
  const response = await fetch(`/codex-api/project-automation?${query.toString()}`, {
    method: 'DELETE',
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, 'Failed to delete project automation'))
  }
}

export async function runThreadAutomationNow(threadId: string, automationId: string): Promise<void> {
  const response = await fetch('/codex-api/thread-automation/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId, automationId, requestId: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}` }),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, 'Failed to run thread automation'))
  }
}

export function subscribeCodexNotifications(onNotification: (value: RpcNotification) => void): () => void {
  return subscribeRpcNotifications(onNotification)
}

export type { RpcNotification }

function normalizeThreadTerminalSession(value: unknown): ThreadTerminalSession | null {
  const record = asRecord(value)
  if (!record) return null
  const id = readString(record.id)
  const threadId = readString(record.threadId)
  const cwd = readString(record.cwd)
  const shell = readString(record.shell)
  if (!id || !threadId || !cwd || !shell) return null
  return {
    id,
    threadId,
    cwd,
    shell,
    buffer: typeof record.buffer === 'string' ? record.buffer : '',
    truncated: readBoolean(record.truncated) ?? false,
  }
}

async function fetchTerminalJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init)
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, `Terminal request failed with HTTP ${response.status}`))
  }
  return payload
}

export async function attachThreadTerminal(input: ThreadTerminalAttachInput): Promise<ThreadTerminalSession> {
  const payload = await fetchTerminalJson('/codex-api/thread-terminal/attach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const session = normalizeThreadTerminalSession(asRecord(payload)?.session)
  if (!session) throw new Error('Terminal attach response was malformed')
  return session
}

export async function getThreadTerminalStatus(): Promise<{ available: boolean, reason: string | null }> {
  const payload = await fetchTerminalJson('/codex-api/thread-terminal/status')
  const record = asRecord(payload)
  return {
    available: readBoolean(record?.available) ?? false,
    reason: readString(record?.reason) || null,
  }
}

export async function getThreadTerminalQuickCommands(cwd: string): Promise<ThreadTerminalQuickCommand[]> {
  const payload = await fetchTerminalJson(`/codex-api/thread-terminal/quick-commands?cwd=${encodeURIComponent(cwd)}`)
  const payloadRecord = asRecord(payload)
  const rows: unknown[] = Array.isArray(payloadRecord?.commands) ? payloadRecord.commands : []
  return rows.flatMap((row: unknown) => {
    const record = asRecord(row)
    const label = readString(record?.label)
    const value = readString(record?.value)
    const source = readString(record?.source)
    if (!label || !value || (source !== 'package' && source !== 'script' && source !== 'make')) return []
    return [{ label, value, source }]
  })
}

export async function sendThreadTerminalInput(sessionId: string, data: string): Promise<void> {
  await fetchTerminalJson('/codex-api/thread-terminal/input', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, data }),
  })
}

export async function resizeThreadTerminal(sessionId: string, cols: number, rows: number): Promise<void> {
  await fetchTerminalJson('/codex-api/thread-terminal/resize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, cols, rows }),
  })
}

export async function closeThreadTerminal(sessionId: string): Promise<void> {
  await fetchTerminalJson('/codex-api/thread-terminal/close', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  })
}

export async function getThreadTerminalSnapshot(threadId: string): Promise<ThreadTerminalSession | null> {
  const payload = await fetchTerminalJson(`/codex-api/thread-terminal-snapshot?threadId=${encodeURIComponent(threadId)}`)
  return normalizeThreadTerminalSession(asRecord(payload)?.session)
}

export async function replyToServerRequest(
  id: number,
  payload: { result?: unknown; error?: { code?: number; message: string } },
): Promise<void> {
  await respondServerRequest({
    id,
    ...payload,
  })
}

export async function getPendingServerRequests(onAuthRecovery?: (states: import('../authRecovery').AuthRecoveryState[]) => void): Promise<unknown[]> {
  return fetchPendingServerRequests(onAuthRecovery)
}

export async function getAccountRateLimits(): Promise<UiRateLimitSnapshot | null> {
  try {
    const payload = await callRpc<unknown>('account/rateLimits/read')
    return pickCodexRateLimitSnapshot(payload)
  } catch (error) {
    throw normalizeCodexApiError(error, 'Failed to load account rate limits', 'account/rateLimits/read')
  }
}

function normalizeAccountsListResult(payload: unknown): AccountsListResult {
  const record = asRecord(payload)
  const activeAccountId = readString(record?.activeAccountId)
  const activeStorageId = readString(record?.activeStorageId)
  const data = Array.isArray(record?.accounts) ? record?.accounts : []
  return {
    activeAccountId,
    activeStorageId,
    importedAccountId: readString(record?.importedAccountId) ?? undefined,
    importedStorageId: readString(record?.importedStorageId) ?? undefined,
    operation: asRecord(record?.operation) as AccountsListResult['operation'],
    accounts: data
      .map((entry) => normalizeAccountEntry(entry, activeAccountId, activeStorageId))
      .filter((entry): entry is UiAccountEntry => entry !== null),
  }
}

export async function getAccounts(): Promise<AccountsListResult> {
  const response = await fetch('/codex-api/accounts')
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to load accounts'))
  }
  const envelope = asRecord(payload)
  return normalizeAccountsListResult(envelope?.data)
}

export async function refreshAccountsFromAuth(): Promise<AccountsListResult> {
  const response = await fetch('/codex-api/accounts/refresh', {
    method: 'POST',
  })
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to refresh accounts'))
  }
  const envelope = asRecord(payload)
  return normalizeAccountsListResult(envelope?.data)
}

export async function startCodexLogin(intent: 'add' | 'reauth' = 'add', targetStorageId?: string, method?: 'link' | 'device'): Promise<AccountLoginStartResult> {
  const response = await fetch('/codex-api/accounts/login/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intent, ...(targetStorageId ? { targetStorageId } : {}), ...(method ? { method } : {}) }),
  })
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to start Codex login'))
  }
  const envelope = asRecord(payload)
  const data = asRecord(envelope?.data)
  const loginUrl = readString(data?.loginUrl)
  const loginSessionId = readString(data?.loginSessionId)
  if (!loginUrl || !loginSessionId) {
    throw new Error('Failed to start Codex login')
  }
  return { loginUrl, loginSessionId, ...(data?.method ? { method: data.method as 'link' | 'device', userCode: readString(data.userCode), expiresAt: readString(data.expiresAt) || undefined } : {}) }
}

export async function completeCodexLogin(loginSessionId: string, callbackUrl: string): Promise<AccountLoginCompleteResult> {
  const response = await fetch('/codex-api/accounts/login/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginSessionId, callbackUrl }),
  })
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to complete Codex login'))
  }
  const envelope = asRecord(payload)
  const data = asRecord(envelope?.data)
  const normalized = normalizeAccountsListResult(data)
  const outcome = data?.outcome === 'reauthenticated' ? 'reauthenticated' : data?.outcome === 'added' ? 'added' : null
  const account = normalizeAccountEntry(data?.account, normalized.activeAccountId, normalized.activeStorageId)
  if (!outcome || !account) throw new Error('Failed to complete Codex login')
  return { ...normalized, outcome, account, poolSize: readNumber(data?.poolSize) ?? normalized.accounts.length }
}

export async function cancelCodexLogin(loginSessionId: string): Promise<void> {
  await fetch('/codex-api/accounts/login/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginSessionId }),
  })
}

export async function refreshAccountQuota(storageId: string): Promise<AccountsListResult> {
  const response = await fetch('/codex-api/accounts/quota/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storageId }),
  })
  const payload = await response.json() as unknown
  if (!response.ok) throw new Error(getErrorMessageFromPayload(payload, 'Failed to refresh account quota'))
  return normalizeAccountsListResult(asRecord(payload)?.data)
}

export async function switchAccount(storageId: string, expectedActiveStorageId: string | null, resumeThreadId?: string): Promise<AccountSwitchResult> {
  const response = await fetch('/codex-api/accounts/switch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storageId, expectedActiveStorageId, ...(resumeThreadId ? { resumeThreadId } : {}) }),
  })
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to switch account'))
  }
  const envelope = asRecord(payload)
  const data = asRecord(envelope?.data)
  const account = normalizeAccountEntry(data?.account, readString(data?.activeAccountId), readString(data?.activeStorageId))
  if (!account) {
    throw new Error('Failed to switch account')
  }
  const continuity = asRecord(data?.workspaceContinuity)
  return {
    account,
    activeStorageId: readString(data?.activeStorageId) ?? account.storageId,
    workspaceContinuity: {
      checked: readBoolean(continuity?.checked) ?? false,
      restored: readBoolean(continuity?.restored) ?? false,
      threadId: readString(continuity?.threadId),
    },
  }
}

export async function removeAccount(storageId: string): Promise<AccountsListResult> {
  const response = await fetch('/codex-api/accounts/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storageId }),
  })
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to remove account'))
  }
  const envelope = asRecord(payload)
  return normalizeAccountsListResult(envelope?.data)
}

export type ResumedThread = {
  thread?: UiThread
  model: string
  modelProvider: string
  messages: UiMessage[]
  inProgress: boolean
  activeTurnId: string
  hasMoreOlder: boolean
  historyPosition?: ThreadHistoryPosition
  turnIndexByTurnId: ThreadTurnIndexById
}

const RESUME_THREAD_COALESCE_TTL_MS = 30_000
const recentResumeThreadById = new Map<string, Promise<ResumedThread>>()

export async function resumeThread(threadId: string): Promise<ResumedThread> {
  const existing = recentResumeThreadById.get(threadId)
  if (existing) return existing

  const promise = (async () => {
    const payload = await callRpc<ThreadResumeResponse>('thread/resume', { threadId })
    const startTurnIndex = readThreadTurnStartIndex(payload)
    const messages = normalizeThreadMessagesV2(payload, startTurnIndex)
    return {
      thread: readLoadedThreadSummary(payload),
      model: normalizeThreadModelFromPayload(payload),
      modelProvider: normalizeThreadModelProviderFromPayload(payload),
      messages,
      inProgress: readThreadInProgressFromResponse(payload),
      activeTurnId: readActiveTurnIdFromResponse(payload),
      hasMoreOlder: readHasMoreHistory(payload),
      historyPosition: readHistoryPosition(payload),
      turnIndexByTurnId: buildTurnIndexByTurnId(payload, startTurnIndex),
    }
  })()

  recentResumeThreadById.set(threadId, promise)
  const hardEvictionTimer = globalThis.setTimeout(() => {
    if (recentResumeThreadById.get(threadId) === promise) {
      recentResumeThreadById.delete(threadId)
    }
  }, RESUME_THREAD_COALESCE_TTL_MS)
  void promise.finally(() => {
    globalThis.clearTimeout(hardEvictionTimer)
    globalThis.setTimeout(() => {
      if (recentResumeThreadById.get(threadId) === promise) {
        recentResumeThreadById.delete(threadId)
      }
    }, 2000)
  }).catch(() => undefined)
  return promise
}

export async function archiveThread(threadId: string): Promise<void> {
  await callRpc('thread/archive', { threadId })
}

export async function renameThread(threadId: string, threadName: string): Promise<void> {
  await callRpc('thread/name/set', { threadId, name: threadName })
}

export async function rollbackThread(threadId: string, numTurns: number): Promise<UiMessage[]> {
  const payload = await callRpc<ThreadReadResponse>('thread/rollback', { threadId, numTurns })
  return normalizeThreadMessagesV2(payload, readThreadTurnStartIndex(payload))
}

export async function updateThreadFileChanges(
  threadId: string,
  turnId: string,
  cwd: string,
  action: 'undo' | 'redo',
  patchIds?: string[],
  scope?: 'single_turn' | 'turn_and_later',
): Promise<{ changed: number; errors: string[]; message?: string; revertedPatchIds?: string[]; appliedPatchIds?: string[] }> {
  try {
    const response = await fetch('/codex-api/thread/rollback-files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId, turnId, cwd, action, patchIds, scope }),
    })
    const payload = (await response.json().catch(() => ({}))) as {
      changed?: number
      reverted?: number
      applied?: number
      errors?: string[]
      message?: string
      error?: string
      revertedPatchIds?: string[]
      appliedPatchIds?: string[]
    }
    if (!response.ok) {
      const message = typeof payload.message === 'string' && payload.message.trim()
        ? payload.message.trim()
        : typeof payload.error === 'string' && payload.error.trim()
          ? payload.error.trim()
          : 'Server error'
      return {
        changed: 0,
        errors: Array.isArray(payload.errors) && payload.errors.length > 0 ? payload.errors : [message],
        message: payload.message,
      }
    }
    return {
      changed: payload.changed ?? payload.reverted ?? payload.applied ?? 0,
      errors: Array.isArray(payload.errors) ? payload.errors : [],
      message: payload.message,
      revertedPatchIds: Array.isArray(payload.revertedPatchIds) ? payload.revertedPatchIds : [],
      appliedPatchIds: Array.isArray(payload.appliedPatchIds) ? payload.appliedPatchIds : [],
    }
  } catch (error) {
    return { changed: 0, errors: [error instanceof Error ? error.message : 'Network error'] }
  }
}

export async function revertThreadFileChanges(threadId: string, turnId: string, cwd: string): Promise<{ reverted: number; errors: string[] }> {
  const result = await updateThreadFileChanges(threadId, turnId, cwd, 'undo')
  return { reverted: result.changed, errors: result.errors }
}

function normalizeThreadIdFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const record = payload as Record<string, unknown>

  const thread = record.thread
  if (thread && typeof thread === 'object') {
    const threadId = (thread as Record<string, unknown>).id
    if (typeof threadId === 'string' && threadId.length > 0) {
      return threadId
    }
  }
  return ''
}

function normalizeThreadCwdFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const record = payload as Record<string, unknown>

  const thread = record.thread
  if (thread && typeof thread === 'object') {
    const cwd = (thread as Record<string, unknown>).cwd
    if (typeof cwd === 'string' && cwd.length > 0) {
      return cwd
    }
  }
  return ''
}

function normalizeThreadModelFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const model = (payload as Record<string, unknown>).model
  return typeof model === 'string' ? model.trim() : ''
}

function normalizeThreadModelProviderFromPayload(payload: unknown): string {
  const record = asRecord(payload)
  if (!record) return ''
  const modelProvider = readString(record.modelProvider)?.trim() ?? ''
  if (modelProvider) return modelProvider
  const thread = asRecord(record.thread)
  return readString(thread?.modelProvider)?.trim() ?? ''
}

export type StartedThread = {
  threadId: string
  model: string
  modelProvider: string
}

export type ForkedThread = {
  threadId: string
  cwd: string
  model: string
  messages: UiMessage[]
}

export async function startThread(cwd?: string, model?: string): Promise<StartedThread> {
  try {
    const params: Record<string, unknown> = {}
    if (typeof cwd === 'string' && cwd.trim().length > 0) {
      params.cwd = cwd.trim()
    }
    if (typeof model === 'string' && model.trim().length > 0) {
      params.model = model.trim()
    }
    const payload = await callRpc<ThreadStartResponse>('thread/start', params)
    const threadId = normalizeThreadIdFromPayload(payload)
    if (!threadId) {
      throw new Error('thread/start did not return a thread id')
    }
    return {
      threadId,
      model: normalizeThreadModelFromPayload(payload),
      modelProvider: normalizeThreadModelProviderFromPayload(payload),
    }
  } catch (error) {
    throw normalizeCodexApiError(error, 'Failed to start a new thread', 'thread/start')
  }
}

export async function getThreadTurnMessages(threadId: string, turnId: string): Promise<UiMessage[]> {
  const response = await fetch(`/codex-api/thread-turn-items?${new URLSearchParams({ threadId, turnId })}`)
  const payload = await response.json() as { result?: ThreadReadResponse; error?: string }
  if (!response.ok || !payload.result) throw new Error(payload.error || '无法读取历史回合。')
  return normalizeThreadMessagesV2(payload.result)
}

export async function forkThreadAtTurn(threadId: string, lastTurnId: string): Promise<StartedThread> {
  const response = await fetch('/codex-api/thread-fork-at-turn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId, lastTurnId }),
  })
  const payload = await response.json() as { result?: ThreadForkResponse; error?: string }
  if (!response.ok || !payload.result) throw new Error(payload.error || '无法从该回合创建分支。')
  const forkedId = normalizeThreadIdFromPayload(payload.result)
  if (!forkedId) throw new Error('分支没有返回会话 ID。')
  return { threadId: forkedId, model: normalizeThreadModelFromPayload(payload.result), modelProvider: normalizeThreadModelProviderFromPayload(payload.result) }
}

export async function forkThread(threadId: string): Promise<ForkedThread>
export async function forkThread(threadId: string, cwd: string | undefined, model: string | undefined): Promise<StartedThread>
export async function forkThread(
  threadId: string,
  cwd?: string,
  model?: string,
): Promise<StartedThread | ForkedThread> {
  if (arguments.length <= 1) {
    try {
      const payload = await callRpc<ThreadForkResponse & ThreadReadResponse & { thread?: { id?: string; cwd?: string } }>('thread/fork', {
        threadId,
        persistExtendedHistory: true,
      })
      const forkedThreadId = normalizeThreadIdFromPayload(payload)
      if (!forkedThreadId) {
        throw new Error('thread/fork did not return a thread id')
      }
      return {
        threadId: forkedThreadId,
        cwd: normalizeThreadCwdFromPayload(payload),
        model: normalizeThreadModelFromPayload(payload),
        messages: normalizeThreadMessagesV2(payload, readThreadTurnStartIndex(payload)),
      }
    } catch (error) {
      throw normalizeCodexApiError(error, `Failed to fork thread ${threadId}`, 'thread/fork')
    }
  }

  try {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) {
      throw new Error('thread/fork requires threadId')
    }
    const params: Record<string, unknown> = {
      threadId: normalizedThreadId,
    }
    if (typeof cwd === 'string' && cwd.trim().length > 0) {
      params.cwd = cwd.trim()
    }
    if (typeof model === 'string' && model.trim().length > 0) {
      params.model = model.trim()
    }
    const payload = await callRpc<ThreadForkResponse>('thread/fork', params)
    const nextThreadId = normalizeThreadIdFromPayload(payload)
    if (!nextThreadId) {
      throw new Error('thread/fork did not return a thread id')
    }
    return {
      threadId: nextThreadId,
      model: normalizeThreadModelFromPayload(payload),
      modelProvider: normalizeThreadModelProviderFromPayload(payload),
    }
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to fork thread ${threadId}`, 'thread/fork')
  }
}

export type FileAttachmentParam = { label: string; path: string; fsPath: string }

function extractLocalImagePathFromUrl(value: string): string | null {
  if (!value) return null
  try {
    const parsed = new URL(value, 'http://localhost')
    if (parsed.pathname !== '/codex-local-image') return null
    const path = parsed.searchParams.get('path')?.trim() ?? ''
    return path.length > 0 ? path : null
  } catch {
    return null
  }
}

function buildTextWithAttachments(
  prompt: string,
  files: FileAttachmentParam[],
): string {
  if (files.length === 0) return prompt
  let prefix = '# Files mentioned by the user:\n'
  for (const f of files) {
    prefix += `\n## ${f.label}: ${f.path}\n`
  }
  return `${prefix}\n## My request for Codex:\n\n${prompt}\n`
}

function fileNameFromPath(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, '/')
  const segments = normalized.split('/').filter(Boolean)
  return segments.at(-1) ?? normalized
}

async function resolveCollaborationModeSettings(
  mode: CollaborationModeKind,
  model?: string,
  effort?: ReasoningEffort,
): Promise<ResolvedCollaborationModeSettings> {
  const explicitModel = model?.trim() ?? ''
  if (explicitModel) {
    return {
      model: explicitModel,
      reasoningEffort: mode === 'plan'
        ? normalizePlanModeReasoningEffort(effort)
        : normalizeCollaborationModeReasoningEffort(effort),
    }
  }

  let currentConfig: CurrentModelConfig | null = null
  try {
    currentConfig = await getCurrentModelConfig()
  } catch {
    currentConfig = null
  }

  const configuredModel = currentConfig?.model.trim() ?? ''
  if (configuredModel) {
    return {
      model: configuredModel,
      reasoningEffort: mode === 'plan'
        ? normalizePlanModeReasoningEffort(effort ?? currentConfig?.reasoningEffort)
        : normalizeCollaborationModeReasoningEffort(effort ?? currentConfig?.reasoningEffort),
    }
  }

  let availableModelIds: string[] = []
  try {
    availableModelIds = await getAvailableModelIds()
  } catch {
    availableModelIds = []
  }

  const fallbackModel = availableModelIds.find((candidate) => candidate.trim().length > 0)?.trim() ?? ''
  if (fallbackModel) {
    return {
      model: fallbackModel,
      reasoningEffort: mode === 'plan'
        ? normalizePlanModeReasoningEffort(effort ?? currentConfig?.reasoningEffort)
        : normalizeCollaborationModeReasoningEffort(effort ?? currentConfig?.reasoningEffort),
    }
  }

  throw new Error(`${mode === 'plan' ? 'Plan' : 'Default'} mode requires an available model. Wait for models to load and try again.`)
}

export async function startThreadTurn(
  threadId: string,
  text: string,
  imageUrls: string[] = [],
  model?: string,
  effort?: ReasoningEffort,
  skills?: Array<{ name: string; path: string }>,
  fileAttachments: FileAttachmentParam[] = [],
  collaborationMode?: CollaborationModeKind,
  serviceTier?: string | null,
  deliveryMode: 'immediate' | 'steer' = 'immediate',
  deliveryOptions?: { id: string; requireConfirmed?: boolean },
): Promise<string> {
  try {
    const normalizedModel = model?.trim() ?? ''
    const localImageAttachments: FileAttachmentParam[] = []
    for (const imageUrl of imageUrls) {
      const localImagePath = extractLocalImagePathFromUrl(imageUrl.trim())
      if (!localImagePath) continue
      localImageAttachments.push({
        label: fileNameFromPath(localImagePath),
        path: localImagePath,
        fsPath: localImagePath,
      })
    }
    const allFileAttachments = [...fileAttachments, ...localImageAttachments]
    const dedupedFileAttachments = allFileAttachments.filter((entry, index) =>
      allFileAttachments.findIndex((candidate) => candidate.fsPath === entry.fsPath) === index)
    const finalText = buildTextWithAttachments(text, dedupedFileAttachments)
    const input: Array<Record<string, unknown>> = [{ type: 'text', text: finalText }]
    for (const imageUrl of imageUrls) {
      const normalizedUrl = imageUrl.trim()
      if (!normalizedUrl) continue
      const localImagePath = extractLocalImagePathFromUrl(normalizedUrl)
      if (localImagePath) {
        input.push({
          type: 'localImage',
          path: localImagePath,
        })
        continue
      }
      input.push({
        type: 'image',
        url: normalizedUrl,
        image_url: normalizedUrl,
      })
    }
    if (skills) {
      for (const skill of skills) {
        input.push({ type: 'skill', name: skill.name, path: skill.path })
      }
    }
    const attachments = dedupedFileAttachments.map((f) => ({ label: f.label, path: f.path, fsPath: f.fsPath }))
    const params: Record<string, unknown> = {
      threadId,
      input,
    }
    if (serviceTier !== undefined) params.serviceTier = serviceTier
    if (attachments.length > 0) params.attachments = attachments
    if (normalizedModel) {
      params.model = normalizedModel
    }
    if (typeof effort === 'string' && effort.length > 0) {
      params.effort = effort
    }
    if (collaborationMode) {
      const collaborationModeSettings = await resolveCollaborationModeSettings(collaborationMode, normalizedModel, effort)
      params.collaborationMode = {
        mode: collaborationMode,
        settings: {
          model: collaborationModeSettings.model,
          reasoning_effort: collaborationModeSettings.reasoningEffort,
          developer_instructions: null,
        },
      }
    }
    const pending = await prepareWebDelivery('delivery', {
      protocol: 2, threadId, params, mode: deliveryMode,
      message: {
        id: deliveryOptions?.id || createDeliveryId(), text, imageUrls, skills: skills ?? [], fileAttachments,
        collaborationMode: collaborationMode ?? 'default',
        ...(normalizedModel ? { model: normalizedModel } : {}),
        ...(effort !== undefined ? { effort } : {}),
        ...(serviceTier !== undefined ? { serviceTier } : {}),
      },
    })
    const payload = await submitRememberedDelivery(pending)
    if (payload.data.status === 'cancelled') throw new Error('此提交已停止跟踪，请核对会话后再发送新消息')
    if (deliveryOptions?.requireConfirmed && !payload.data.turnId) throw new Error('回答尚未确认送达，请稍后核对；重试将复用本次投递，不重复发送。')
    return typeof payload.data.turnId === 'string' ? payload.data.turnId : ''
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to start turn for thread ${threadId}`, 'turn/start')
  }
}

export async function interruptThreadTurn(threadId: string, turnId?: string): Promise<void> {
  const normalizedThreadId = threadId.trim()
  const normalizedTurnId = turnId?.trim() || ''
  if (!normalizedThreadId) return

  try {
    if (!normalizedTurnId) {
      throw new Error('turn/interrupt requires turnId')
    }
    await callRpc('turn/interrupt', { threadId: normalizedThreadId, turnId: normalizedTurnId })
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to interrupt turn for thread ${normalizedThreadId}`, 'turn/interrupt')
  }
}

export async function setDefaultModel(model: string): Promise<void> {
  await callRpc('setDefaultModel', { model })
}

export async function setCodexSpeedMode(mode: SpeedMode): Promise<void> {
  const normalizedMode = capabilityValue(mode)
  await callRpc('config/batchWrite', {
    edits: [
      {
        keyPath: 'features.fast_mode',
        value: true,
        mergeStrategy: 'upsert',
      },
      {
        keyPath: 'service_tier',
        value: normalizedMode || null,
        mergeStrategy: normalizedMode ? 'upsert' : 'replace',
      },
    ],
    filePath: null,
    expectedVersion: null,
  })
}

export interface FreeModeStatus {
  enabled: boolean
  hasCodexAuth?: boolean
  keyCount: number
  models: string[]
  currentModel: string | null
  customKey: boolean
  maskedKey: string | null
  provider?: 'openrouter' | 'custom' | 'opencode-zen'
  customBaseUrl?: string
  wireApi?: 'responses' | 'chat' | null
}

export async function getFreeModeStatus(): Promise<FreeModeStatus> {
  const response = await fetch('/codex-api/free-mode/status')
  return await response.json() as FreeModeStatus
}

export async function setFreeMode(enable: boolean): Promise<{ ok: boolean; enabled: boolean; model?: string; models?: string[] }> {
  const response = await fetch('/codex-api/free-mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enable }),
  })
  return await response.json() as { ok: boolean; enabled: boolean; model?: string; models?: string[] }
}

export async function setFreeModeCustomKey(key: string): Promise<{ ok: boolean; customKey: boolean }> {
  const response = await fetch('/codex-api/free-mode/custom-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  })
  return await response.json() as { ok: boolean; customKey: boolean }
}

export async function setCustomProvider(
  baseUrl: string,
  apiKey: string,
  options?: { wireApi?: 'responses' | 'chat'; provider?: 'custom' | 'opencode-zen' | 'openrouter' },
): Promise<{ ok: boolean }> {
  const response = await fetch('/codex-api/free-mode/custom-provider', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl,
      apiKey,
      wireApi: options?.wireApi,
      provider: options?.provider,
    }),
  })
  return await response.json() as { ok: boolean }
}

export function getAvailableModels(options: ModelCatalogOptions = {}) {
  return loadModelCatalog(callRpc, options)
}

export async function getAvailableModelIds(options: ModelCatalogOptions = {}): Promise<string[]> {
  return (await getAvailableModels(options)).map(model => model.id)
}

export async function getCurrentModelConfig(): Promise<CurrentModelConfig> {
  const payload = await callRpc<ConfigReadResponse>('config/read', {})
  const model = payload.config.model ?? ''
  const providerId = typeof payload.config.model_provider === 'string' ? payload.config.model_provider : ''
  const reasoningEffort = normalizeReasoningEffort(payload.config.model_reasoning_effort)
  const speedMode = normalizeSpeedMode(payload.config.service_tier)
  return { model, providerId, reasoningEffort, speedMode }
}

function normalizeDirectoryPluginApp(value: unknown): DirectoryPluginAppSummary | null {
  const record = asRecord(value)
  if (!record) return null
  const id = readString(record.id)
  const name = readString(record.name)
  if (!id || !name) return null
  return {
    id,
    name,
    description: readString(record.description) ?? '',
    installUrl: readString(record.installUrl ?? record.install_url) ?? '',
    needsAuth: readBoolean(record.needsAuth ?? record.needs_auth) ?? false,
  }
}

function normalizeDirectoryPluginSkill(value: unknown): DirectoryPluginSkillSummary | null {
  const record = asRecord(value)
  if (!record) return null
  const name = readString(record.name)
  const path = readString(record.path)
  if (!name || !path) return null
  const iface = asRecord(record.interface)
  return {
    name,
    path,
    description: readString(record.description) ?? '',
    enabled: readBoolean(record.enabled) ?? true,
    displayName: readString(iface?.displayName ?? iface?.display_name) ?? name,
    shortDescription: readString(record.shortDescription ?? record.short_description) ?? '',
  }
}

function normalizeDirectoryPluginSummary(
  value: unknown,
  marketplace: { name?: string; displayName?: string; path?: string | null } = {},
): DirectoryPluginSummary | null {
  const record = asRecord(value)
  if (!record) return null
  const id = readString(record.id)
  const name = readString(record.name)
  if (!id || !name) return null
  const iface = asRecord(record.interface)
  const source = asRecord(record.source)
  const sourceType = readString(source?.type) ?? ''
  const sourcePath = readString(source?.path)
  const sourceUrl = readString(source?.url) ?? ''
  const remoteMarketplaceName = sourceType === 'remote' ? marketplace.name ?? null : null
  const marketplacePath = marketplace.path ?? (sourceType === 'local' ? sourcePath : null)
  const displayName = readString(iface?.displayName ?? iface?.display_name) ?? name
  const shortDescription = readString(iface?.shortDescription ?? iface?.short_description)
  const longDescription = readString(iface?.longDescription ?? iface?.long_description) ?? ''

  return {
    id,
    name,
    displayName,
    description: shortDescription ?? longDescription,
    longDescription,
    developerName: readString(iface?.developerName ?? iface?.developer_name) ?? '',
    category: readString(iface?.category) ?? '',
    marketplaceName: marketplace.name ?? '',
    marketplaceDisplayName: marketplace.displayName ?? marketplace.name ?? '',
    marketplacePath,
    remoteMarketplaceName,
    sourceType,
    sourceUrl,
    installed: readBoolean(record.installed) ?? false,
    enabled: readBoolean(record.enabled) ?? false,
    availability: readString(record.availability) ?? '',
    disabledReason: readString(record.disabledReason) ?? '',
    installPolicy: readString(record.installPolicy ?? record.install_policy) ?? '',
    authPolicy: readString(record.authPolicy ?? record.auth_policy) ?? '',
    logoUrl: readString(iface?.logoUrl ?? iface?.logo_url) ?? '',
    logoPath: readString(iface?.logo) ?? '',
    composerIconUrl: readString(iface?.composerIconUrl ?? iface?.composer_icon_url) ?? '',
    composerIconPath: readString(iface?.composerIcon ?? iface?.composer_icon) ?? '',
    brandColor: readString(iface?.brandColor ?? iface?.brand_color) ?? '',
    capabilities: readStringArray(iface?.capabilities),
    defaultPrompt: readStringArray(iface?.defaultPrompt ?? iface?.default_prompt),
    screenshotUrls: readStringArray(iface?.screenshotUrls ?? iface?.screenshot_urls),
    screenshots: readStringArray(iface?.screenshots),
    websiteUrl: readString(iface?.websiteUrl ?? iface?.website_url) ?? '',
    privacyPolicyUrl: readString(iface?.privacyPolicyUrl ?? iface?.privacy_policy_url) ?? '',
    termsOfServiceUrl: readString(iface?.termsOfServiceUrl ?? iface?.terms_of_service_url) ?? '',
  }
}

function normalizeDirectoryApp(value: unknown, catalogRank = 0): DirectoryAppInfo | null {
  const record = asRecord(value)
  if (!record) return null
  const id = readString(record.id)
  const name = readString(record.name)
  if (!id || !name) return null
  const branding = asRecord(record.branding)
  const metadata = asRecord(record.appMetadata ?? record.app_metadata)
  return {
    id,
    name,
    description: readString(record.description) ?? readString(metadata?.seoDescription ?? metadata?.seo_description) ?? '',
    logoUrl: readString(record.logoUrl ?? record.logo_url) ?? '',
    logoUrlDark: readString(record.logoUrlDark ?? record.logo_url_dark) ?? '',
    distributionChannel: readString(record.distributionChannel ?? record.distribution_channel) ?? '',
    installUrl: readString(record.installUrl ?? record.install_url) ?? '',
    isAccessible: readBoolean(record.isAccessible ?? record.is_accessible) ?? false,
    isEnabled: readBoolean(record.isEnabled ?? record.is_enabled) ?? true,
    pluginDisplayNames: readStringArray(record.pluginDisplayNames ?? record.plugin_display_names),
    category: readString(branding?.category) ?? '',
    developer: readString(branding?.developer) ?? readString(metadata?.developer) ?? '',
    website: readString(branding?.website) ?? '',
    privacyPolicy: readString(branding?.privacyPolicy ?? branding?.privacy_policy) ?? '',
    termsOfService: readString(branding?.termsOfService ?? branding?.terms_of_service) ?? '',
    catalogRank,
  }
}

type PluginPageCache = { rows: DirectoryPluginSummary[]; warnings: string[]; expiresAt: number }
const pluginPageCache = new Map<string, PluginPageCache>()
const pluginPageFlights = new Map<string, Promise<PluginPageCache>>()
export async function listDirectoryPlugins(cwds?: string[], forceRefetch = false, onWarnings?: (messages: string[]) => void): Promise<DirectoryPluginSummary[]> {
  const key = JSON.stringify([...(cwds || [])].sort())
  const cached = pluginPageCache.get(key)
  if (cached && !forceRefetch && Date.now() < cached.expiresAt) {
    onWarnings?.(cached.warnings)
    return cached.rows
  }
  let work = pluginPageFlights.get(key)
  if (!work) {
    work = (async () => {
      let warnings: string[] = []
      const rows = await fetchDirectoryPlugins(cwds, forceRefetch, value => { warnings = value })
      const next = new Date()
      next.setHours(2, 0, 0, 0)
      if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1)
      const result = { rows, warnings, expiresAt: next.getTime() }
      if (pluginPageCache.size >= 12) pluginPageCache.delete(pluginPageCache.keys().next().value!)
      pluginPageCache.set(key, result)
      return result
    })().finally(() => pluginPageFlights.delete(key))
    pluginPageFlights.set(key, work)
  }
  const result = await work
  onWarnings?.(result.warnings)
  return result.rows
}

async function fetchDirectoryPlugins(cwds?: string[], forceRefetch = false, onWarnings?: (messages: string[]) => void): Promise<DirectoryPluginSummary[]> {
  const params: Record<string, unknown> = {}
  if (cwds && cwds.length > 0) params.cwds = cwds
  if (forceRefetch) params.forceRefetch = true
  const payload = await callRpc<{ marketplaces?: unknown[]; marketplaceLoadErrors?: Array<{ message?: string }> }>('plugin/list', params)
  const warnings = (payload.marketplaceLoadErrors || []).map(error => error.message || '插件市场加载失败')
  const plugins: DirectoryPluginSummary[] = []
  for (const marketplaceValue of payload.marketplaces ?? []) {
    const marketplace = asRecord(marketplaceValue)
    if (!marketplace) continue
    const iface = asRecord(marketplace.interface)
    const meta = {
      name: readString(marketplace.name) ?? '',
      displayName: readString(iface?.displayName ?? iface?.display_name) ?? '',
      path: readString(marketplace.path),
    }
    const rows = Array.isArray(marketplace.plugins) ? marketplace.plugins : []
    for (const row of rows) {
      const plugin = normalizeDirectoryPluginSummary(row, meta)
      if (plugin) plugins.push(plugin)
    }
  }
  if (warnings.length && !plugins.length) throw new Error(warnings.join('；'))
  onWarnings?.(warnings)
  return plugins
}

export async function readDirectoryPlugin(plugin: DirectoryPluginSummary): Promise<DirectoryPluginDetail> {
  const params: Record<string, unknown> = { pluginName: plugin.name }
  if (plugin.marketplacePath) params.marketplacePath = plugin.marketplacePath
  if (plugin.remoteMarketplaceName) params.remoteMarketplaceName = plugin.remoteMarketplaceName
  const payload = await callRpc<{ plugin?: unknown }>('plugin/read', params)
  const detailRecord = asRecord(payload.plugin)
  if (!detailRecord) throw new Error('Plugin detail response is empty')
  const summary = normalizeDirectoryPluginSummary(detailRecord.summary, {
    name: readString(detailRecord.marketplaceName) ?? plugin.marketplaceName,
    displayName: plugin.marketplaceDisplayName,
    path: readString(detailRecord.marketplacePath) ?? plugin.marketplacePath,
  }) ?? plugin
  return {
    summary,
    description: readString(detailRecord.description) ?? summary.longDescription,
    apps: Array.isArray(detailRecord.apps)
      ? detailRecord.apps.map(normalizeDirectoryPluginApp).filter((row): row is DirectoryPluginAppSummary => row !== null)
      : [],
    skills: Array.isArray(detailRecord.skills)
      ? detailRecord.skills.map(normalizeDirectoryPluginSkill).filter((row): row is DirectoryPluginSkillSummary => row !== null)
      : [],
    mcpServers: readStringArray(detailRecord.mcpServers ?? detailRecord.mcp_servers),
  }
}

export async function installDirectoryPlugin(plugin: DirectoryPluginSummary): Promise<DirectoryPluginInstallResult> {
  const params: Record<string, unknown> = { pluginName: plugin.name }
  if (plugin.marketplacePath) params.marketplacePath = plugin.marketplacePath
  if (plugin.remoteMarketplaceName) params.remoteMarketplaceName = plugin.remoteMarketplaceName
  const payload = await callRpc<{ authPolicy?: string; auth_policy?: string; appsNeedingAuth?: unknown[]; apps_needing_auth?: unknown[] }>('plugin/install', params)
  const apps = payload.appsNeedingAuth ?? payload.apps_needing_auth ?? []
  return {
    authPolicy: readString(payload.authPolicy ?? payload.auth_policy) ?? '',
    appsNeedingAuth: apps.map(normalizeDirectoryPluginApp).filter((row): row is DirectoryPluginAppSummary => row !== null),
  }
}

export async function uninstallDirectoryPlugin(pluginId: string): Promise<void> {
  await callRpc('plugin/uninstall', { pluginId })
}

export async function setDirectoryPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
  await callRpc('config/batchWrite', {
    edits: [{ keyPath: `plugins.${pluginId}.enabled`, value: enabled, mergeStrategy: 'upsert' }],
    filePath: null,
    expectedVersion: null,
    reloadUserConfig: true,
  })
}

export async function listDirectoryApps(threadId?: string, forceRefetch = false): Promise<DirectoryAppInfo[]> {
  const rows = await readDirectoryPages(async cursor => {
    const params = { limit: 100, ...(cursor ? { cursor } : {}), ...(threadId ? { threadId } : {}), ...(forceRefetch && !cursor ? { forceRefetch: true } : {}) }
    const payload = await callRpc<{ data: unknown[]; nextCursor?: string | null }>('app/list', params)
    if (payload.data?.length > 100) throw new Error('App 分页响应超过上限')
    return payload
  })
  return [...new Map(rows.map((item, index) => normalizeDirectoryApp(item, index)).filter((app): app is DirectoryAppInfo => app !== null).map(app => [app.id, app])).values()]
}

export async function listInstalledDirectoryApps(threadId?: string, forceRefresh = false): Promise<InstalledDirectoryApp[]> {
  return normalizeInstalledApps(await callRpc('app/installed', { ...(threadId ? { threadId } : {}), ...(forceRefresh ? { forceRefresh: true } : {}) }))
}

export function directoryAppsFromRuntime(apps: InstalledDirectoryApp[]): DirectoryAppInfo[] {
  return apps.map((app, index) => ({
    ...normalizeDirectoryApp({ id: app.id, name: app.name || app.id, isEnabled: app.enabled, isAccessible: false }, index)!,
    runtimeOnly: true,
  }))
}

export async function setDirectoryAppEnabled(appId: string, enabled: boolean): Promise<void> {
  await callRpc('config/batchWrite', {
    edits: [{ keyPath: `apps.${appId}.enabled`, value: enabled, mergeStrategy: 'upsert' }],
    filePath: null,
    expectedVersion: null,
    reloadUserConfig: true,
  })
}

export async function listDirectoryMcpServers(threadId?: string, full = false): Promise<DirectoryMcpServerStatus[]> {
  const query = new URLSearchParams({ full: String(full) })
  if (threadId) query.set('threadId', threadId)
  const response = await fetch(`/codex-api/directory/mcps?${query}`)
  const payload = await response.json() as { data?: DirectoryMcpServerStatus[]; error?: string }
  if (!response.ok || !Array.isArray(payload.data)) throw new Error(payload.error || 'MCP 状态读取失败')
  return payload.data
}

export async function reloadDirectoryMcpServers(): Promise<void> {
  await callRpc('config/mcpServer/reload', {})
}

export async function startDirectoryMcpLogin(name: string): Promise<DirectoryMcpLoginResult> {
  const payload = await callRpc<{ authorizationUrl?: string; authorization_url?: string }>('mcpServer/oauth/login', { name })
  return {
    authorizationUrl: readString(payload.authorizationUrl ?? payload.authorization_url) ?? '',
  }
}


export async function getAccountRateLimitsResponse(): Promise<GetAccountRateLimitsResponse> {
  return await callRpc<GetAccountRateLimitsResponse>('account/rateLimits/read')
}

function normalizeCollaborationModeLabel(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (segment) => segment.toUpperCase())
}

export async function getAvailableCollaborationModes(): Promise<CollaborationModeOption[]> {
  try {
    const payload = await callRpc<CollaborationModeListResponse>('collaborationMode/list', {})
    const seen = new Set<CollaborationModeKind>()
    const normalized: CollaborationModeOption[] = []

    for (const row of payload.data) {
      const mode = row.mode
      if (mode !== 'default' && mode !== 'plan') continue
      if (seen.has(mode)) continue
      seen.add(mode)
      normalized.push({
        value: mode,
        label: normalizeCollaborationModeLabel(row.name || mode) || (mode === 'plan' ? 'Plan' : 'Default'),
      })
    }

    if (normalized.length > 0) {
      for (const fallback of DEFAULT_COLLABORATION_MODE_OPTIONS) {
        if (!seen.has(fallback.value)) {
          normalized.push(fallback)
        }
      }
      return normalized.sort((first, second) => (
        first.value === second.value ? 0 : first.value === 'default' ? -1 : 1
      ))
    }
  } catch {
    // Fall back to static options when the app-server does not expose presets.
  }

  return DEFAULT_COLLABORATION_MODE_OPTIONS
}

function normalizeWorkspaceRootsState(payload: unknown): WorkspaceRootsState {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}

  const normalizeArray = (value: unknown): string[] => {
    if (!Array.isArray(value)) return []
    const next: string[] = []
    for (const item of value) {
      if (typeof item === 'string' && item.length > 0 && !next.includes(item)) {
        next.push(item)
      }
    }
    return next
  }

  const labelsRaw = record.labels
  const labels: Record<string, string> = {}
  if (labelsRaw && typeof labelsRaw === 'object' && !Array.isArray(labelsRaw)) {
    for (const [key, value] of Object.entries(labelsRaw as Record<string, unknown>)) {
      const normalizedKey = typeof key === 'string' ? normalizePathForUi(key) : ''
      if (normalizedKey.length > 0 && typeof value === 'string') {
        labels[normalizedKey] = value
      }
    }
  }

  return {
    order: normalizeArray(record.order).map((value) => normalizePathForUi(value)),
    labels,
    active: normalizeArray(record.active).map((value) => normalizePathForUi(value)),
    projectOrder: normalizeArray(record.projectOrder).map((value) => normalizePathForUi(value)),
    remoteProjects: Array.isArray(record.remoteProjects)
      ? record.remoteProjects.flatMap((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return []
        const remote = item as Record<string, unknown>
        const id = typeof remote.id === 'string' ? remote.id.trim() : ''
        if (!id) return []
        return [{
          id,
          hostId: typeof remote.hostId === 'string' ? remote.hostId.trim() : '',
          remotePath: typeof remote.remotePath === 'string' ? normalizePathForUi(remote.remotePath) : '',
          label: typeof remote.label === 'string' ? remote.label.trim() : '',
        }]
      })
      : [],
  }
}

export async function getWorkspaceRootsState(): Promise<WorkspaceRootsState> {
  if (cachedWorkspaceRootsState) {
    return cloneWorkspaceRootsState(cachedWorkspaceRootsState)
  }
  if (!workspaceRootsStatePromise) {
    workspaceRootsStatePromise = fetchWorkspaceRootsState()
      .then((state) => {
        cachedWorkspaceRootsState = state
        return state
      })
      .finally(() => {
        workspaceRootsStatePromise = null
      })
  }
  return cloneWorkspaceRootsState(await workspaceRootsStatePromise)
}

async function fetchWorkspaceRootsState(): Promise<WorkspaceRootsState> {
  const response = await fetch('/codex-api/workspace-roots-state')
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error('Failed to load workspace roots state')
  }
  const envelope =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}
  return normalizeWorkspaceRootsState(envelope.data)
}

function cloneWorkspaceRootsState(state: WorkspaceRootsState): WorkspaceRootsState {
  return {
    order: [...state.order],
    labels: { ...state.labels },
    active: [...state.active],
    projectOrder: [...state.projectOrder],
    remoteProjects: state.remoteProjects?.map((item) => ({ ...item })) ?? [],
  }
}

function invalidateWorkspaceRootsStateCache(): void {
  cachedWorkspaceRootsState = null
}

export async function getThreadQueueState(): Promise<ThreadQueueState> {
  const response = await fetch('/codex-api/thread-queue-state')
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error((payload as { error?: string })?.error || '无法读取发送队列，请稍后重试')
  }
  const envelope =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}
  return normalizeThreadQueueState(envelope.data)
}

export async function mutateThreadQueueState(operation: ThreadQueueOperation): Promise<ThreadQueueResult> {
  let payload
  if (operation.type === 'add') {
    const pending = await prepareWebDelivery('thread-queue-state', { ...operation, protocol: 2 })
    payload = await submitRememberedDelivery(pending)
  } else {
    const response = await fetch('/codex-api/thread-queue-state', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...operation, protocol: 2 }),
    })
    payload = await response.json()
    if (!response.ok) throw new Error(payload.error || '队列保存失败，请重试')
  }
  return { state: normalizeThreadQueueState(payload.data?.state), removed: payload.data?.removed, delivered: payload.data?.delivered }
}

export async function createWorktree(sourceCwd: string, baseBranch?: string): Promise<WorktreeCreateResult> {
  const normalizedBaseBranch = (baseBranch ?? '').trim()
  const response = await fetch('/codex-api/worktree/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceCwd,
      baseBranch: normalizedBaseBranch || undefined,
    }),
  })
  const payload = (await response.json()) as { data?: WorktreeCreateResult; error?: string }
  if (!response.ok || !payload.data) {
    throw new Error(payload.error || 'Failed to create worktree')
  }
  return {
    ...payload.data,
    cwd: normalizePathForUi(payload.data.cwd),
    gitRoot: normalizePathForUi(payload.data.gitRoot),
  }
}

export async function createPermanentWorktree(sourceCwd: string, worktreeName: string): Promise<WorktreeCreateResult> {
  const response = await fetch('/codex-api/worktree/create-permanent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceCwd,
      worktreeName,
    }),
  })
  const payload = (await response.json()) as { data?: WorktreeCreateResult; error?: string }
  if (!response.ok || !payload.data) {
    throw new Error(payload.error || 'Failed to create worktree')
  }
  return {
    ...payload.data,
    cwd: normalizePathForUi(payload.data.cwd),
    gitRoot: normalizePathForUi(payload.data.gitRoot),
  }
}

export async function getWorktreeBranchOptions(sourceCwd: string): Promise<WorktreeBranchOption[]> {
  const normalizedSourceCwd = sourceCwd.trim()
  if (!normalizedSourceCwd) return []
  const query = new URLSearchParams({ sourceCwd: normalizedSourceCwd })
  const response = await fetch(`/codex-api/worktree/branches?${query.toString()}`)
  const payload = (await response.json()) as { data?: unknown; error?: string }
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load branches')
  }
  const rawList = Array.isArray(payload.data) ? payload.data : []
  const options: WorktreeBranchOption[] = []
  const seen = new Set<string>()
  for (const item of rawList) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const value = typeof record.value === 'string' ? record.value.trim() : ''
    const label = typeof record.label === 'string' ? record.label.trim() : ''
    if (!value || seen.has(value)) continue
    seen.add(value)
    options.push({
      value,
      label: label || value,
    })
  }
  return options
}

export async function getGitBranchState(cwd: string): Promise<GitBranchState> {
  const normalizedCwd = cwd.trim()
  if (!normalizedCwd) {
    return { currentBranch: null, headSha: null, headSubject: null, headDate: null, detached: false, dirty: false, gitRoot: '', options: [] }
  }
  const query = new URLSearchParams({ cwd: normalizedCwd })
  const response = await fetch(`/codex-api/git/branches?${query.toString()}`)
  const payload = (await response.json()) as { data?: unknown; error?: string }
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load Git branch state')
  }
  const record = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? (payload.data as Record<string, unknown>)
    : {}
  const currentBranchRaw = record.currentBranch
  const currentBranch = typeof currentBranchRaw === 'string' && currentBranchRaw.trim()
    ? currentBranchRaw.trim()
    : null
  const rawList = Array.isArray(record.options) ? record.options : []
  const options: WorktreeBranchOption[] = []
  const seen = new Set<string>()
  for (const item of rawList) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const option = item as Record<string, unknown>
    const value = typeof option.value === 'string' ? option.value.trim() : ''
    const label = typeof option.label === 'string' ? option.label.trim() : ''
    if (!value || seen.has(value)) continue
    seen.add(value)
    options.push({
      value,
      label: label || value,
      isCurrent: option.isCurrent === true,
      isRemote: option.isRemote === true,
    })
  }
  if (currentBranch && !seen.has(currentBranch)) {
    options.unshift({ value: currentBranch, label: currentBranch, isCurrent: true })
  }
  const headShaRaw = record.headSha
  const headSubjectRaw = record.headSubject
  const headDateRaw = record.headDate
  const gitRootRaw = record.gitRoot
  return {
    currentBranch,
    headSha: typeof headShaRaw === 'string' && headShaRaw.trim() ? headShaRaw.trim() : null,
    headSubject: typeof headSubjectRaw === 'string' && headSubjectRaw.trim() ? headSubjectRaw.trim() : null,
    headDate: typeof headDateRaw === 'string' && headDateRaw.trim() ? headDateRaw.trim() : null,
    detached: record.detached === true,
    dirty: record.dirty === true,
    gitRoot: typeof gitRootRaw === 'string' ? normalizePathForUi(gitRootRaw) : '',
    options,
  }
}

export async function getGitRepositoryStatus(cwd: string): Promise<GitRepositoryStatus> {
  const normalizedCwd = cwd.trim()
  if (!normalizedCwd) {
    return { isGitRepo: false, gitRoot: '' }
  }
  const query = new URLSearchParams({ cwd: normalizedCwd })
  const response = await fetch(`/codex-api/git/repository-status?${query.toString()}`)
  const payload = (await response.json()) as { data?: unknown; error?: string }
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to read Git repository status')
  }
  const record = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? (payload.data as Record<string, unknown>)
    : {}
  return {
    isGitRepo: record.isGitRepo === true,
    gitRoot: typeof record.gitRoot === 'string' ? normalizePathForUi(record.gitRoot) : '',
  }
}

export async function checkoutGitBranch(cwd: string, branch: string): Promise<string | null> {
  const response = await fetch('/codex-api/git/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cwd: cwd.trim(),
      branch: branch.trim(),
    }),
  })
  const payload = (await response.json()) as { data?: { currentBranch?: string | null }; error?: string }
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to switch branch')
  }
  const branchName = payload.data?.currentBranch
  return typeof branchName === 'string' && branchName.trim() ? branchName.trim() : null
}

export async function getGitBranchCommits(cwd: string, branch: string, options: { includeResetHistory?: boolean } = {}): Promise<GitCommitOption[]> {
  const normalizedCwd = cwd.trim()
  const normalizedBranch = branch.trim()
  if (!normalizedCwd || !normalizedBranch) return []
  const query = new URLSearchParams({
    cwd: normalizedCwd,
    branch: normalizedBranch,
    includeResetHistory: options.includeResetHistory === false ? 'false' : 'true',
  })
  const response = await fetch(`/codex-api/git/branch-commits?${query.toString()}`)
  const payload = (await response.json()) as { data?: unknown; error?: string }
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load branch commits')
  }
  const rawList = Array.isArray(payload.data) ? payload.data : []
  return rawList.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const record = item as Record<string, unknown>
    const sha = typeof record.sha === 'string' ? record.sha.trim() : ''
    const shortSha = typeof record.shortSha === 'string' ? record.shortSha.trim() : ''
    const subject = typeof record.subject === 'string' ? record.subject.trim() : ''
    const date = typeof record.date === 'string' ? record.date.trim() : ''
    if (!sha || !shortSha) return []
    return [{ sha, shortSha, subject: subject || shortSha, date }]
  })
}

export async function getGitCommitFiles(cwd: string, sha: string): Promise<GitCommitFileChange[]> {
  const normalizedCwd = cwd.trim()
  const normalizedSha = sha.trim()
  if (!normalizedCwd || !normalizedSha) return []
  const query = new URLSearchParams({
    cwd: normalizedCwd,
    sha: normalizedSha,
  })
  const response = await fetch(`/codex-api/git/commit-files?${query.toString()}`)
  const payload = (await response.json()) as { data?: unknown; error?: string }
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load commit files')
  }
  const rawList = Array.isArray(payload.data) ? payload.data : []
  return rawList.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const record = item as Record<string, unknown>
    const path = typeof record.path === 'string' ? record.path : ''
    const previousPath = typeof record.previousPath === 'string' && record.previousPath.length > 0 ? record.previousPath : null
    const status = typeof record.status === 'string' ? record.status.trim() : ''
    const label = typeof record.label === 'string' ? record.label.trim() : ''
    const addedLineCount = typeof record.addedLineCount === 'number' && Number.isFinite(record.addedLineCount) ? record.addedLineCount : null
    const removedLineCount = typeof record.removedLineCount === 'number' && Number.isFinite(record.removedLineCount) ? record.removedLineCount : null
    if (!path || !status) return []
    return [{ path, previousPath, status, label: label || status, addedLineCount, removedLineCount }]
  })
}

export async function resetGitBranchToCommit(cwd: string, branch: string, sha: string): Promise<GitBranchState> {
  const response = await fetch('/codex-api/git/reset-to-commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cwd: cwd.trim(),
      branch: branch.trim(),
      sha: sha.trim(),
    }),
  })
  const payload = (await response.json()) as { data?: unknown; error?: string }
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to reset branch to commit')
  }
  const record = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? (payload.data as Record<string, unknown>)
    : {}
  return {
    currentBranch: typeof record.currentBranch === 'string' && record.currentBranch.trim() ? record.currentBranch.trim() : null,
    headSha: typeof record.headSha === 'string' && record.headSha.trim() ? record.headSha.trim() : null,
    headSubject: typeof record.headSubject === 'string' && record.headSubject.trim() ? record.headSubject.trim() : null,
    headDate: typeof record.headDate === 'string' && record.headDate.trim() ? record.headDate.trim() : null,
    detached: record.detached === true,
    dirty: record.dirty === true,
    gitRoot: typeof record.gitRoot === 'string' ? normalizePathForUi(record.gitRoot) : '',
    options: [],
  }
}

export async function getReviewSnapshot(
  cwd: string,
  scope: UiReviewScope,
  workspaceView: UiReviewWorkspaceView,
  baseBranch?: string | null,
  commitSha?: string | null,
): Promise<UiReviewSnapshot> {
  const query = new URLSearchParams({ cwd, scope, workspaceView })
  if (baseBranch && baseBranch.trim()) {
    query.set('baseBranch', baseBranch.trim())
  }
  if (commitSha && commitSha.trim()) {
    query.set('commitSha', commitSha.trim())
  }
  const response = await fetch(`/codex-api/review/snapshot?${query.toString()}`)
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to load review snapshot'))
  }
  return normalizeReviewSnapshot(payload)
}

export async function getReviewSummary(
  cwd: string,
  workspaceView: UiReviewWorkspaceView,
): Promise<UiReviewSummary> {
  const query = new URLSearchParams({ cwd, workspaceView })
  const response = await fetch(`/codex-api/review/summary?${query.toString()}`)
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to load review summary'))
  }
  return normalizeReviewSummary(payload)
}

export async function applyReviewAction(payload: {
  cwd: string
  scope: UiReviewScope
  workspaceView: UiReviewWorkspaceView
  action: UiReviewAction
  level: UiReviewActionLevel
  path?: string
  previousPath?: string | null
  patch?: string
}): Promise<UiReviewSnapshot> {
  const response = await fetch('/codex-api/review/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(data, 'Failed to apply review action'))
  }
  return normalizeReviewSnapshot(data)
}

export async function initializeReviewGit(cwd: string): Promise<void> {
  const response = await fetch('/codex-api/review/git/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd }),
  })
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to initialize Git'))
  }
}

export async function startThreadReview(
  threadId: string,
  scope: UiReviewScope,
  workspaceView: UiReviewWorkspaceView,
  baseBranch?: string | null,
): Promise<void> {
  const target = scope === 'baseBranch'
    ? { type: 'baseBranch' as const, branch: (baseBranch ?? '').trim() }
    : { type: 'uncommittedChanges' as const }
  if (target.type === 'baseBranch' && !target.branch) {
    throw new Error('Base branch is unavailable')
  }
  await callRpc('review/start', {
    threadId,
    target,
    delivery: 'inline',
  })
}

export async function getHomeDirectory(): Promise<string> {
  const response = await fetch('/codex-api/home-directory')
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error('Failed to load home directory')
  }
  const record =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}
  const data =
    record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {}
  return typeof data.path === 'string' ? data.path.trim() : ''
}

export async function listLocalDirectories(path: string, options?: { showHidden?: boolean }): Promise<LocalDirectoryListing> {
  const query = new URLSearchParams({ path })
  if (options?.showHidden === true) {
    query.set('showHidden', '1')
  }
  const response = await fetch(`/codex-local-directories?${query.toString()}`)
  const payload = await readJsonResponse(response)
  if (!response.ok) {
    const message = getErrorMessageFromPayload(payload, 'Failed to load local directories')
    throw new Error(message)
  }

  const record =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}
  const data =
    record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {}
  const entriesRaw = Array.isArray(data.entries) ? data.entries : []

  return {
    path: typeof data.path === 'string' ? normalizePathForUi(data.path) : '',
    parentPath: typeof data.parentPath === 'string' ? normalizePathForUi(data.parentPath) : '',
    entries: entriesRaw.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      const record = item as Record<string, unknown>
      const name = typeof record.name === 'string' ? record.name.trim() : ''
      const entryPath = typeof record.path === 'string' ? normalizePathForUi(record.path) : ''
      return name && entryPath ? [{ name, path: entryPath }] : []
    }),
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const raw = await response.text()
  if (!raw) return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new Error(`Expected JSON response from ${response.url || 'request'}`)
  }
}

export async function setWorkspaceRootsState(nextState: WorkspaceRootsState): Promise<void> {
  const response = await fetch('/codex-api/workspace-roots-state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(nextState),
  })
  if (!response.ok) {
    throw new Error('Failed to save workspace roots state')
  }
  cachedWorkspaceRootsState = cloneWorkspaceRootsState(nextState)
}

export async function openProjectRoot(path: string, options?: { createIfMissing?: boolean; label?: string; directories?: string[] }): Promise<string> {
  const response = await fetch('/codex-api/project-root', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path,
      createIfMissing: options?.createIfMissing === true,
      label: options?.label ?? '',
      directories: options?.directories,
    }),
  })
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    const message = getErrorMessageFromPayload(payload, 'Failed to open project root')
    throw new Error(message)
  }
  const record =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}
  const data =
    record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {}
  const normalizedPath = typeof data.path === 'string' ? normalizePathForUi(data.path) : ''
  invalidateWorkspaceRootsStateCache()
  return normalizedPath
}

export function getProjectZipDownloadUrl(cwd: string): string {
  const query = new URLSearchParams({ cwd })
  return `/codex-api/project-zip?${query.toString()}`
}

function readDownloadFileName(response: Response, fallback: string): string {
  const disposition = response.headers.get('content-disposition') ?? ''
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/iu)
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1])
    } catch {
      return utf8Match[1]
    }
  }
  const plainMatch = disposition.match(/filename="?([^";]+)"?/iu)
  return plainMatch?.[1]?.trim() || fallback
}

export async function downloadProjectZip(
  cwd: string,
  onProgress?: (progress: { loaded: number; total: number | null }) => void,
): Promise<{ blob: Blob; fileName: string }> {
  const response = await fetch(getProjectZipDownloadUrl(cwd))
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    const fallback = 'Failed to export project'
    const payloadMessage = getErrorMessageFromPayload(payload, fallback)
    const statusLabel = [response.status ? String(response.status) : '', response.statusText].filter(Boolean).join(' ')
    const message = payloadMessage !== fallback
      ? payloadMessage
      : statusLabel ? `Failed to export project: ${statusLabel}` : fallback
    throw new Error(message)
  }

  const totalHeader = Number(response.headers.get('content-length') ?? '')
  const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : null
  const fileName = readDownloadFileName(response, 'project.zip')
  const reader = response.body?.getReader()
  if (!reader) {
    const blob = await response.blob()
    onProgress?.({ loaded: blob.size, total: blob.size || total })
    return { blob, fileName }
  }

  const chunks: Uint8Array[] = []
  let loaded = 0
  onProgress?.({ loaded, total })
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(new Uint8Array(value))
    loaded += value.byteLength
    onProgress?.({ loaded, total })
  }

  const blobParts = chunks.map((chunk) => {
    const copy = new Uint8Array(chunk.byteLength)
    copy.set(chunk)
    return copy.buffer
  })
  return { blob: new Blob(blobParts, { type: response.headers.get('content-type') ?? 'application/zip' }), fileName }
}

export async function importProjectZip(file: Blob, parent: string): Promise<{ path: string; importedSessions: number }> {
  const query = new URLSearchParams({ parent })
  const response = await fetch(`/codex-api/project-import?${query.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: file,
  })
  const payload = await readJsonResponse(response)
  if (!response.ok) {
    const message = getErrorMessageFromPayload(payload, 'Failed to import project')
    throw new Error(message)
  }
  const record =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}
  const data =
    record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {}
  const normalizedPath = typeof data.path === 'string' ? normalizePathForUi(data.path) : ''
  if (normalizedPath) {
    invalidateWorkspaceRootsStateCache()
  }
  return {
    path: normalizedPath,
    importedSessions: typeof data.importedSessions === 'number' ? data.importedSessions : 0,
  }
}

export async function createLocalDirectory(path: string): Promise<string> {
  const response = await fetch('/codex-api/local-directory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
  const payload = await readJsonResponse(response)
  if (!response.ok) {
    const message = getErrorMessageFromPayload(payload, 'Failed to create local directory')
    throw new Error(message)
  }
  const record =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}
  const data =
    record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {}
  const normalizedPath = typeof data.path === 'string' ? normalizePathForUi(data.path) : ''
  if (normalizedPath) {
    invalidateWorkspaceRootsStateCache()
  }
  return normalizedPath
}

export async function cloneGithubRepository(url: string, basePath: string): Promise<string> {
  const response = await fetch('/codex-api/github-clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, basePath }),
  })
  const payload = await readJsonResponse(response)
  if (!response.ok) {
    const message = getErrorMessageFromPayload(payload, 'Failed to clone GitHub repository')
    throw new Error(message)
  }
  const record =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}
  const data =
    record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {}
  return typeof data.path === 'string' ? normalizePathForUi(data.path) : ''
}

export async function createProjectlessThreadDirectory(prompt?: string): Promise<{ cwd: string; outputDirectory: string; workspaceRoot: string }> {
  const response = await fetch('/codex-api/projectless-thread-cwd', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: prompt ?? null }),
  })
  const payload = await readJsonResponse(response)
  if (!response.ok) {
    const message = getErrorMessageFromPayload(payload, 'Failed to create new chat folder')
    throw new Error(message)
  }
  const record =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}
  const data =
    record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {}
  const cwd = typeof data.cwd === 'string' ? normalizePathForUi(data.cwd) : ''
  if (!cwd) {
    throw new Error('Failed to create new chat folder')
  }
  return {
    cwd,
    outputDirectory: typeof data.outputDirectory === 'string' ? normalizePathForUi(data.outputDirectory) : cwd,
    workspaceRoot: typeof data.workspaceRoot === 'string' ? normalizePathForUi(data.workspaceRoot) : '',
  }
}

export async function getProjectRootSuggestion(basePath: string): Promise<{ name: string; path: string }> {
  const query = new URLSearchParams({ basePath })
  const response = await fetch(`/codex-api/project-root-suggestion?${query.toString()}`)
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    const message = getErrorMessageFromPayload(payload, 'Failed to suggest project name')
    throw new Error(message)
  }
  const record =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}
  const data =
    record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {}
  return {
    name: typeof data.name === 'string' ? data.name.trim() : '',
    path: typeof data.path === 'string' ? normalizePathForUi(data.path) : '',
  }
}

export async function searchComposerFiles(cwd: string, query: string, limit = 20): Promise<ComposerFileSuggestion[]> {
  const trimmedCwd = cwd.trim()
  if (!trimmedCwd) return []
  const response = await fetch('/codex-api/composer-file-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cwd: trimmedCwd,
      query: query.trim(),
      limit,
    }),
  })
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    const message = getErrorMessageFromPayload(payload, 'Failed to search files')
    throw new Error(message)
  }
  const record =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}
  const data = Array.isArray(record.data) ? record.data : []
  const suggestions: ComposerFileSuggestion[] = []
  for (const item of data) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const row = item as Record<string, unknown>
    const rawPath = row.path
    const value = typeof rawPath === 'string' ? rawPath.trim() : ''
    if (!value) continue
    suggestions.push({ path: value })
  }
  return suggestions
}

export async function searchThreads(
  query: string,
  limit = 200,
  signal?: AbortSignal,
  mode: ThreadSearchMode = 'title',
): Promise<ThreadSearchResult> {
  const response = await fetch('/codex-api/thread-search', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit, mode }),
  })
  const payload = (await response.json()) as { data?: ThreadSearchResult & { threads?: ThreadListResponse['data'] }; error?: string }
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to search threads')
  }
  const result = payload.data ?? { threadIds: [], indexedThreadCount: 0 }
  return {
    ...result,
    groups: payload.data?.threads ? normalizeThreadGroupsV2({ data: payload.data.threads, nextCursor: null }) : undefined,
  }
}

export async function configureTelegramBot(
  botToken: string,
  allowedUserIds: Array<number | '*'>,
  notificationsEnabled?: boolean,
  quietHours?: { quietEnabled: boolean; quietStart: string; quietEnd: string; timezone: string },
): Promise<void> {
  const response = await fetch('/codex-api/telegram/configure-bot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      botToken,
      allowedUserIds,
      notificationsEnabled,
      ...quietHours,
    }),
  })
  const payload = await response.json()
  if (!response.ok) {
    const message = getErrorMessageFromPayload(payload, 'Failed to connect Telegram bot')
    throw new Error(message)
  }
}

export async function getTelegramConfig(): Promise<TelegramConfig> {
  const response = await fetch('/codex-api/telegram/config')
  const payload = await response.json()
  if (!response.ok) {
    const message = getErrorMessageFromPayload(payload, 'Failed to load Telegram configuration')
    throw new Error(message)
  }
  const record =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}
  const data =
    record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {}
  const rawAllowedUserIds = Array.isArray(data.allowedUserIds) ? data.allowedUserIds : []
  const allowedUserIds: Array<number | '*'> = []
  for (const value of rawAllowedUserIds) {
    if (value === '*') {
      allowedUserIds.push('*')
      continue
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      allowedUserIds.push(Math.trunc(value))
    }
  }
  return {
    botToken: typeof data.botToken === 'string' ? data.botToken : '',
    notificationsEnabled: typeof data.notificationsEnabled === 'boolean' ? data.notificationsEnabled : !!data.botToken,
    quietEnabled: data.quietEnabled === true,
    quietStart: typeof data.quietStart === 'string' ? data.quietStart : '22:00',
    quietEnd: typeof data.quietEnd === 'string' ? data.quietEnd : '08:00',
    timezone: typeof data.timezone === 'string' ? data.timezone : 'Asia/Shanghai',
    allowedUserIds,
  }
}

export async function getTelegramStatus(): Promise<TelegramStatus> {
  const response = await fetch('/codex-api/telegram/status')
  const payload = await response.json()
  if (!response.ok) {
    const message = getErrorMessageFromPayload(payload, 'Failed to load Telegram status')
    throw new Error(message)
  }
  const record =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}
  const data =
    record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {}
  return {
    configured: data.configured === true,
    active: data.active === true,
    mappedChats: typeof data.mappedChats === 'number' ? data.mappedChats : 0,
    mappedThreads: typeof data.mappedThreads === 'number' ? data.mappedThreads : 0,
    allowedUsers: typeof data.allowedUsers === 'number' ? data.allowedUsers : 0,
    allowAllUsers: data.allowAllUsers === true,
    lastError: typeof data.lastError === 'string' ? data.lastError : '',
  }
}

function getErrorMessageFromPayload(payload: unknown, fallback: string): string {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
  const message = record.message
  if (typeof message === 'string' && message.trim().length > 0) {
    return message
  }
  const error = record.error
  return typeof error === 'string' && error.trim().length > 0 ? error : fallback
}

export type ThreadTitleCache = { titles: Record<string, string>; order: string[] }
export type ThreadPinnedState = { threadIds: string[] }
export type FirstLaunchPluginsCardPreference = { dismissed: boolean }

export async function getThreadTitleCache(): Promise<ThreadTitleCache> {
  try {
    const response = await fetch('/codex-api/thread-titles')
    if (!response.ok) return { titles: {}, order: [] }
    const envelope = (await response.json()) as { data?: ThreadTitleCache }
    return envelope.data ?? { titles: {}, order: [] }
  } catch {
    return { titles: {}, order: [] }
  }
}

export async function persistThreadTitle(id: string, title: string): Promise<void> {
  try {
    await fetch('/codex-api/thread-titles', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, title }),
    })
  } catch {
    // Best-effort persist
  }
}

export async function getPinnedThreadState(): Promise<ThreadPinnedState> {
  try {
    const response = await fetch('/codex-api/thread-pins')
    if (!response.ok) return { threadIds: [] }
    const envelope = (await response.json()) as { data?: ThreadPinnedState }
    return envelope.data ?? { threadIds: [] }
  } catch {
    return { threadIds: [] }
  }
}

export async function persistPinnedThreadIds(threadIds: string[]): Promise<void> {
  try {
    await fetch('/codex-api/thread-pins', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadIds }),
    })
  } catch {
    // Best-effort persist
  }
}

export async function getFirstLaunchPluginsCardPreference(): Promise<FirstLaunchPluginsCardPreference> {
  try {
    const response = await fetch('/codex-api/preferences/first-launch-plugins-card')
    if (!response.ok) return { dismissed: false }
    const envelope = (await response.json()) as { data?: FirstLaunchPluginsCardPreference }
    return { dismissed: envelope.data?.dismissed === true }
  } catch {
    return { dismissed: false }
  }
}

export async function persistFirstLaunchPluginsCardPreference(dismissed: boolean): Promise<void> {
  try {
    await fetch('/codex-api/preferences/first-launch-plugins-card', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dismissed }),
    })
  } catch {
    // Best-effort persist
  }
}

export async function generateThreadTitle(prompt: string, cwd: string | null): Promise<string> {
  try {
    const result = await callRpc<{ title?: string }>('generate-thread-title', { prompt, cwd })
    return result.title?.trim() ?? ''
  } catch {
    return ''
  }
}

export type SkillInfo = {
  name: string
  displayName?: string
  description: string
  path: string
  scope: string
  enabled: boolean
}

function normalizeSkillMarkdownPath(skillPath: string): string {
  if (!skillPath) return ''
  return skillPath.endsWith('/SKILL.md') ? skillPath : `${skillPath}/SKILL.md`
}

function deriveGroupedSkillRoot(
  skillPath: string,
  knownPaths: Set<string>,
): { rootPath: string; rootName: string; isNested: boolean } | null {
  const normalizedPath = normalizeSkillMarkdownPath(skillPath)
  const parts = normalizedPath.split('/').filter(Boolean)
  if (parts.length < 2) return null

  const pluginSkillsIndex = parts.lastIndexOf('skills')
  if (pluginSkillsIndex >= 2) {
    const pluginName = parts[pluginSkillsIndex - 2] ?? ''
    if (pluginName) {
      const pluginRootPath = `/${[...parts.slice(0, pluginSkillsIndex + 1), pluginName, 'SKILL.md'].join('/')}`
      if (knownPaths.has(pluginRootPath)) {
        return { rootPath: pluginRootPath, rootName: pluginName, isNested: pluginRootPath !== normalizedPath }
      }
    }
  }

  const firstSkillsIndex = parts.indexOf('skills')
  if (firstSkillsIndex < 0 || firstSkillsIndex + 1 >= parts.length - 1) return null
  const rootName = parts[firstSkillsIndex + 1] ?? ''
  if (!rootName) return null
  const rootPath = `/${[...parts.slice(0, firstSkillsIndex + 2), 'SKILL.md'].join('/')}`
  if (!knownPaths.has(rootPath)) return { rootPath, rootName, isNested: rootPath !== normalizedPath }
  return { rootPath, rootName, isNested: rootPath !== normalizedPath }
}

type SkillsListResponseEntry = {
  cwd: string
  skills: Array<{
    name: string
    description: string
    shortDescription?: string
    path: string
    scope: string
    enabled: boolean
  }>
  errors: unknown[]
}

export async function getSkillsList(cwds?: string[]): Promise<SkillInfo[]> {
  try {
    const params: Record<string, unknown> = {}
    if (cwds && cwds.length > 0) params.cwds = cwds
    const payload = await callRpc<{ data: SkillsListResponseEntry[] }>('skills/list', params)
    const allSkills = payload.data.flatMap((entry) => entry.skills)
    const pathSet = new Set(allSkills.map((skill) => normalizeSkillMarkdownPath(skill.path)).filter(Boolean))
    const grouped = new Map<string, SkillInfo & { __hasRoot: boolean }>()
    for (const entry of payload.data) {
      for (const skill of entry.skills) {
        if (!skill.name) continue
        const groupInfo = deriveGroupedSkillRoot(skill.path, pathSet)
        const normalizedPath = normalizeSkillMarkdownPath(skill.path)
        const shouldCollapseIntoRoot = Boolean(groupInfo?.isNested && pathSet.has(groupInfo.rootPath))
        const key = shouldCollapseIntoRoot ? groupInfo!.rootPath : normalizedPath
        const isRoot = normalizedPath === key
        const existing = grouped.get(key)
        const candidate: SkillInfo & { __hasRoot: boolean } = {
          name: skill.name,
          displayName: groupInfo && key === groupInfo.rootPath ? groupInfo.rootName : undefined,
          description: skill.shortDescription || skill.description || '',
          path: key,
          scope: skill.scope,
          enabled: skill.enabled,
          __hasRoot: isRoot,
        }
        if (!existing) {
          grouped.set(key, candidate)
          continue
        }
        existing.enabled = existing.enabled || skill.enabled
        if (!existing.__hasRoot && isRoot) {
          grouped.set(key, candidate)
          continue
        }
        if (!existing.displayName && candidate.displayName) {
          existing.displayName = candidate.displayName
        }
        if (!existing.description && candidate.description) {
          existing.description = candidate.description
        }
      }
    }
    return Array.from(grouped.values()).map(({ __hasRoot: _ignored, ...skill }) => skill)
  } catch {
    return []
  }
}

let composerPromptsRead: Promise<ComposerPromptInfo[]> | null = null

export function getComposerPrompts(): Promise<ComposerPromptInfo[]> {
  if (composerPromptsRead) return composerPromptsRead
  const task = readComposerPrompts().finally(() => {
    if (composerPromptsRead === task) composerPromptsRead = null
  })
  composerPromptsRead = task
  return task
}

async function readComposerPrompts(): Promise<ComposerPromptInfo[]> {
  try {
    const response = await fetch('/codex-api/prompts')
    if (!response.ok) return []
    const payload = (await response.json()) as { data?: ComposerPromptInfo[] }
    return Array.isArray(payload.data) ? payload.data : []
  } catch {
    return []
  }
}

export async function createComposerPrompt(name: string, content: string): Promise<ComposerPromptInfo | null> {
  try {
    const response = await fetch('/codex-api/prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, content }),
    })
    if (!response.ok) return null
    const payload = (await response.json()) as { data?: ComposerPromptInfo }
    composerPromptsRead = null
    return payload.data ?? null
  } catch {
    return null
  }
}

export async function removeComposerPrompt(path: string): Promise<boolean> {
  try {
    const params = new URLSearchParams({ path })
    const response = await fetch(`/codex-api/prompts?${params.toString()}`, {
      method: 'DELETE',
    })
    if (response.ok) composerPromptsRead = null
    return response.ok
  } catch {
    return false
  }
}

const FILE_UPLOAD_TIMEOUT_MS = 60_000

export async function uploadFile(file: File): Promise<string | null> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), FILE_UPLOAD_TIMEOUT_MS)
  try {
    const form = new FormData()
    form.append('file', file)
    const resp = await fetch('/codex-api/upload-file', {
      method: 'POST',
      body: form,
      signal: controller.signal,
    })
    if (!resp.ok) return null
    const data = (await resp.json()) as { path?: string }
    return data.path ?? null
  } catch {
    return null
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function getProjectDirectories(path: string): Promise<string[]> {
  const response = await fetch(`/codex-api/project-directories?path=${encodeURIComponent(path)}`)
  const payload = await response.json()
  if (!response.ok) throw new Error(getErrorMessageFromPayload(payload, '读取项目工作目录失败'))
  return payload.data
}
