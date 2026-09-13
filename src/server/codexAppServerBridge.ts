import { readProjectArchiveMembers } from './projectOrganizationArchive.js'
import { VirtualProjectStore } from './virtualProjects.js'
import { createDirectoryListingHtml } from './localBrowseUi.js'
import { isVirtualProjectId, type VirtualProject } from '../projectOrganization.js'
import { IgnoredQuotaErrors } from './ignoredQuotaErrors.js'
import { ThreadInterruptionList } from './threadInterruptionList.js'
import { SidebarThreadStatusReader } from './sidebarThreadStatusReader.js'
import { getCustomConnectionStore, customRuntimeConfig } from './customConnectionStore.js'
import { getWebUiBrandingStore } from './webUiBrandingStore.js'
import { customConnectionModels } from '../customConnections.js'
import { readProjectDirectories, saveProjectDirectories } from './projectDirectories.js'
import { ThreadCompletionList } from './threadCompletionList.js'
import { AccountResourcePool } from './accountResourcePool.js'
import { resolveAccountSelection, type AccountExecutionLease } from './accountExecution.js'
import { DirectoryPluginCache } from './directoryPluginCache.js'
import { DirectoryMcpReader } from './directoryMcpReader.js'
import { BackgroundTerminalReader, threadsWithBackgroundTerminals } from './backgroundTerminalReader.js'
import { ProcessActivityStore } from './processActivityStore.js'
import { readCommandToolOutput } from './commandToolOutput.js'
import { hookRunKey, readCommandOutput, readHookConfiguration } from '../processActivity.js'
import { extractTaskExcerpt } from '../taskExcerpt'
import { maySupplementImportedThreads } from './threadListCompatibility'
import { changesThreadSearch } from '../threadSearchEvents.js'
import { deliveryView } from '../delivery.js'
import { DeliveryStore } from './deliveryStore.js'
import { DeliveryService } from './deliveryService.js'
import type { AutomationPreparation } from './automationPreparation.js'
import { inspectDelivery } from './deliveryHistory.js'
import { ThreadSearch, SEARCH_BODY_TURN_LIMIT, extractThreadSearchText } from './threadSearch.js'
import { ThreadHistory } from './threadHistory.js'
import { AuthRecoveryRegistry } from '../authRecovery'
import { MethodCatalog } from './runtimeCapabilities.js'
import { version as appVersion } from '../../package.json'
import { capabilityValue } from '../modelCapabilities.js'
import { normalizeStoredQueuedMessage, normalizeThreadQueueState, type StoredQueuedMessage, type ThreadQueueState } from '../threadQueue.js'
import { ThreadGoalReader } from './threadGoalReader.js'
import { ThreadCompactionGate } from './threadCompactionGate.js'
import { normalizeAutomationModelSettings } from '../automationOptions.js'
import { AutomationEngine } from './automationEngine.js'
import { ThreadQuotaResume } from './threadQuotaResume.js'
import { boundedQuotaRead } from '../quotaRefresh.js'
import { createAutomationRuntime } from './automationRuntime.js'
import { createAutomationSchedule, validateAutomationTimezone } from './automationSchedule.js'
import { parseAutomationToml, serializeAutomationToml, toAutomationApiRecord, writeAutomationFileAtomic, type ThreadAutomationRecord, type ThreadAutomationStatus } from './automationDefinition.js'
export { parseAutomationToml, toAutomationApiRecord } from './automationDefinition.js'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, open, readFile, readdir, rename, rm, mkdir, stat, lstat, realpath, utimes } from 'node:fs/promises'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { handleAccountRoutes } from './accountRoutes.js'
import { getAccountAuthCoordinator, type RuntimeQuiescenceSnapshot } from './accountAuthCoordinator.js'
import type { ChatgptAuthTokensRefreshParams, ChatgptAuthTokensRefreshResponse } from './accountTokenRefresh.js'
import { buildAppServerArgs } from './appServerRuntimeConfig.js'
import { callRpcWithRateLimitDecodeRecovery } from './rateLimitDecodeRecovery.js'
import { handleReviewRoutes } from './reviewGit.js'
import { handleSkillsRoutes } from './skillsRoutes.js'
import { TelegramThreadBridge } from './telegramThreadBridge.js'
import { defaultQuietHours, validateQuietHours, type QuietHoursSettings } from '../accountNotifications.js'
import {
  getRandomFreeKey,
  getFreeKeyCount,
  FREE_MODE_DEFAULT_MODEL,
  getCachedFreeModels,
  getFreeModels,
  refreshFreeModelsInBackground,
  FREE_MODE_STATE_FILE,
  OPENCODE_ZEN_DEFAULT_MODEL,
  OPENCODE_ZEN_PROVIDER_ID,
  createDefaultOpenCodeZenFreeModeState,
  filterOpenCodeZenModelsForAuthState,
  getFreeModeConfigArgs,
  getFreeModeEnvVars,
  getProviderCompatibilityConfigArgs,
  shouldMarkOpenRouterKeyAsCustom,
  shouldCreateDefaultFreeModeStateForMissingAuth,
  shouldSuppressCommunityFreeModeForCodexAuth,
  type FreeModeState,
} from './freeMode.js'
import { handleOpenRouterProxyRequest } from './openRouterProxy.js'
import { handleZenProxyRequest } from './zenProxy.js'
import { handleCustomEndpointProxyRequest } from './customEndpointProxy.js'
import { ThreadTerminalManager } from './terminalManager.js'
import { getSpawnInvocation } from '../utils/commandInvocation.js'
import {
  resolveCodexCommand,
  resolveRipgrepCommand,
} from '../commandResolution.js'
import type { CollaborationModeKind, ReasoningEffort } from '../types/codex.js'
import { isAbsoluteLikePath } from '../pathUtils.js'

type JsonRpcCall = {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

type JsonRpcResponse = {
  id?: number
  result?: unknown
  error?: {
    code: number
    message: string
  }
  method?: string
  params?: unknown
}

type RpcProxyRequest = {
  method: string
  params?: unknown
}

type RpcExecutor = {
  rpc: (method: string, params: unknown) => Promise<unknown>
}

type ServerRequestReply = {
  result?: unknown
  error?: {
    code: number
    message: string
  }
}

export type WorkspaceRootsState = {
  virtualProjects?: VirtualProject[]
  order: string[]
  labels: Record<string, string>
  active: string[]
  projectOrder: string[]
  remoteProjects: Array<{
    id: string
    hostId: string
    remotePath: string
    label: string
  }>
}

type PendingServerRequest = {
  id: number
  method: string
  params: unknown
  receivedAtIso: string
}

type ProviderModelsResponse = {
  data: string[]
  providerId: string
  source: 'provider'
}

const PROVIDER_MODELS_FETCH_TIMEOUT_MS = 5_000

const THREAD_RESPONSE_TURN_LIMIT = 10
const THREAD_METHODS_WITH_TURNS = new Set(['thread/read', 'thread/resume', 'thread/fork', 'thread/rollback'])
const THREAD_METHODS_WITH_THREAD_SNAPSHOT = new Set([...THREAD_METHODS_WITH_TURNS, 'thread/start'])
const PROJECTLESS_THREAD_DIRECTORY_MAX_ATTEMPTS = 100
const PROJECTLESS_THREAD_READABLE_DIRECTORY_ATTEMPTS = 20
const PROJECTLESS_THREAD_SLUG_MAX_LENGTH = 80
const API_PERF_LOGGING_ENV_KEY = 'CODEXUI_API_PERF_LOGGING'
const API_PERF_MS_THRESHOLD_ENV_KEY = 'CODEXUI_API_PERF_MS_THRESHOLD'
const API_PERF_BODY_MB_THRESHOLD_ENV_KEY = 'CODEXUI_API_PERF_BODY_MB_THRESHOLD'
const DEFAULT_API_PERF_MS_THRESHOLD = 300
const DEFAULT_API_PERF_BODY_MB_THRESHOLD = 1
const MB_DIVISOR = 1024 * 1024

type SessionRecoveredFileChange = {
  path: string
  operation: 'add' | 'delete' | 'update'
  movedToPath: string | null
  diff: string
  addedLineCount: number
  removedLineCount: number
}

type SessionRecoveredTurnFileChanges = {
  turnId: string
  turnIndex: number
  fileChanges: SessionRecoveredFileChange[]
}

type SessionRecoveredSkillInput = {
  name: string
  path: string
}

type SessionSkillInputCacheEntry = {
  size: number
  boundary: string
  mtimeNs: bigint
  ctimeNs: bigint
  inode: bigint
  offset: number
  currentTurnId: string
  skillsByTurnId: Map<string, SessionRecoveredSkillInput[]>
}

const SESSION_SKILL_INPUT_CACHE_LIMIT = 64
const sessionSkillInputCache = new Map<string, SessionSkillInputCacheEntry>()

function parseSessionSkillText(value: string): SessionRecoveredSkillInput | null {
  const trimmed = value.trim()
  if (!trimmed.startsWith('<skill>')) return null
  const name = trimmed.match(/<name>\s*([\s\S]*?)\s*<\/name>/u)?.[1]?.trim() ?? ''
  const path = trimmed.match(/<path>\s*([\s\S]*?)\s*<\/path>/u)?.[1]?.trim() ?? ''
  if (!name || !path) return null
  return { name, path }
}

function buildSessionSkillInputsByTurn(sessionLogRaw: string, state = { currentTurnId: '', skillsByTurnId: new Map<string, SessionRecoveredSkillInput[]>() }): Map<string, SessionRecoveredSkillInput[]> {
  const skillsByTurnId = state.skillsByTurnId

  for (const line of sessionLogRaw.split('\n')) {
    if (!line.includes('<skill>') && !line.includes('turn_context') && !line.includes('task_started')) continue
    let row: Record<string, unknown> | null = null
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }

    if (row.type === 'turn_context') {
      const payloadRecord = asRecord(row.payload)
      state.currentTurnId = readNonEmptyString(payloadRecord?.turn_id) || state.currentTurnId
      continue
    }
    if (row.type === 'event_msg') {
      const payloadRecord = asRecord(row.payload)
      if (payloadRecord?.type === 'task_started') {
        state.currentTurnId = readNonEmptyString(payloadRecord.turn_id) || state.currentTurnId
      }
      continue
    }

    if (row.type !== 'response_item' || !state.currentTurnId) continue
    const payloadRecord = asRecord(row.payload)
    if (payloadRecord?.type !== 'message' || payloadRecord.role !== 'user') continue
    const content = Array.isArray(payloadRecord.content) ? payloadRecord.content : []

    for (const contentItem of content) {
      const contentRecord = asRecord(contentItem)
      if (contentRecord?.type !== 'input_text' || typeof contentRecord.text !== 'string') continue
      const skill = parseSessionSkillText(contentRecord.text)
      if (!skill) continue
      const existing = skillsByTurnId.get(state.currentTurnId) ?? []
      if (!existing.some((item) => item.path === skill.path)) {
        existing.push(skill)
        skillsByTurnId.set(state.currentTurnId, existing)
      }
    }
  }

  return skillsByTurnId
}

async function readSessionBoundary(sessionPath: string, size: number): Promise<string> {
  const file = await open(sessionPath, 'r')
  try {
    const length = Math.min(4096, size)
    const head = Buffer.alloc(length)
    const tail = Buffer.alloc(length)
    await file.read(head, 0, length, 0)
    await file.read(tail, 0, length, Math.max(0, size - length))
    return createHash('sha256').update(head).update(tail).digest('hex')
  } finally {
    await file.close()
  }
}

export async function readCachedSessionSkillInputsByTurn(sessionPath: string): Promise<Map<string, SessionRecoveredSkillInput[]>> {
  const rawInfo = await stat(sessionPath, { bigint: true })
  const info = { ...rawInfo, size: Number(rawInfo.size) }
  const cached = sessionSkillInputCache.get(sessionPath)
  // Rapid rewrites can share filesystem timestamps. Check a bounded prefix and the old EOF too.
  const unchangedBoundary = cached && info.size >= cached.size && cached.inode === info.ino
    && await readSessionBoundary(sessionPath, cached.size) === cached.boundary
  if (cached && unchangedBoundary && cached.size === info.size && cached.mtimeNs === info.mtimeNs && cached.ctimeNs === info.ctimeNs) return cached.skillsByTurnId
  const canAppend = cached && unchangedBoundary && info.size > cached.size
  const state: SessionSkillInputCacheEntry = {
    size: info.size,
    boundary: await readSessionBoundary(sessionPath, info.size),
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
    inode: info.ino,
    offset: canAppend ? cached.offset : 0,
    currentTurnId: canAppend ? cached.currentTurnId : '',
    skillsByTurnId: canAppend ? new Map([...cached.skillsByTurnId].map(([id, skills]) => [id, [...skills]])) : new Map(),
  }
  let pending = Buffer.alloc(0)
  let skippedBytes = 0
  if (state.offset < info.size) {
    for await (const chunk of createReadStream(sessionPath, { start: state.offset, end: info.size - 1 })) {
      pending = Buffer.concat([pending, chunk as Buffer])
      let newline: number
      while ((newline = pending.indexOf(10)) >= 0) {
        if (!skippedBytes) buildSessionSkillInputsByTurn(pending.subarray(0, newline).toString('utf8'), state)
        state.offset += skippedBytes + newline + 1
        skippedBytes = 0
        pending = pending.subarray(newline + 1)
      }
      // Embedded media/tool lines cannot be skill declarations. Bound the partial-line buffer.
      if (pending.length > 1024 * 1024) {
        skippedBytes += pending.length
        pending = Buffer.alloc(0)
      }
    }
  }
  // Do not advance beyond an incomplete last line; the next append rereads it.
  sessionSkillInputCache.set(sessionPath, state)
  while (sessionSkillInputCache.size > SESSION_SKILL_INPUT_CACHE_LIMIT) {
    const oldestKey = sessionSkillInputCache.keys().next().value
    if (!oldestKey) break
    sessionSkillInputCache.delete(oldestKey)
  }
  return state.skillsByTurnId
}

function mergeSessionSkillInputsIntoTurnsFromMap(
  turns: unknown[],
  skillsByTurnId: Map<string, SessionRecoveredSkillInput[]>,
): unknown[] {
  const turnIds = new Set<string>()
  for (const turn of turns) {
    const turnRecord = asRecord(turn)
    const turnId = readNonEmptyString(turnRecord?.id)
    if (turnId) turnIds.add(turnId)
  }
  if (turnIds.size === 0) return turns

  if (skillsByTurnId.size === 0) return turns

  let changed = false
  const nextTurns = turns.map((turn) => {
    const turnRecord = asRecord(turn)
    const turnId = readNonEmptyString(turnRecord?.id)
    const skills = turnId ? skillsByTurnId.get(turnId) : undefined
    const items = Array.isArray(turnRecord?.items) ? turnRecord.items : null
    if (!turnRecord || !skills || skills.length === 0 || !items) return turn

    let targetUserMessageIndex = -1
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const itemRecord = asRecord(items[index])
      if (itemRecord?.type === 'userMessage' && Array.isArray(itemRecord.content)) {
        targetUserMessageIndex = index
        break
      }
    }
    if (targetUserMessageIndex < 0) return turn

    let addedToMessage = false
    const nextItems = items.map((item, index) => {
      const itemRecord = asRecord(item)
      const content = Array.isArray(itemRecord?.content) ? itemRecord.content : null
      if (index !== targetUserMessageIndex || itemRecord?.type !== 'userMessage' || !content) return item

      const existingSkillPaths = new Set(
        content.flatMap((contentItem) => {
          const contentRecord = asRecord(contentItem)
          const path = typeof contentRecord?.path === 'string' ? contentRecord.path.trim() : ''
          return contentRecord?.type === 'skill' && path ? [path] : []
        }),
      )
      const missingSkills = skills.filter((skill) => !existingSkillPaths.has(skill.path))
      if (missingSkills.length === 0) return item

      addedToMessage = true
      changed = true
      return {
        ...itemRecord,
        content: [
          ...content,
          ...missingSkills.map((skill) => ({ type: 'skill', name: skill.name, path: skill.path })),
        ],
      }
    })

    return addedToMessage ? { ...turnRecord, items: nextItems } : turn
  })

  return changed ? nextTurns : turns
}

export function mergeSessionSkillInputsIntoTurns(turns: unknown[], sessionLogRaw: string): unknown[] {
  return mergeSessionSkillInputsIntoTurnsFromMap(turns, buildSessionSkillInputsByTurn(sessionLogRaw))
}

async function mergeSessionSkillInputsIntoThreadResult(result: unknown): Promise<unknown> {
  const record = asRecord(result)
  const thread = asRecord(record?.thread)
  const turns = Array.isArray(thread?.turns) ? thread.turns : null
  const sessionPath = readNonEmptyString(thread?.path)
  if (!record || !thread || !turns || turns.length === 0 || !sessionPath || !isAbsolute(sessionPath)) {
    return result
  }

  try {
    const skillsByTurnId = await readCachedSessionSkillInputsByTurn(sessionPath)
    const mergedTurns = mergeSessionSkillInputsIntoTurnsFromMap(turns, skillsByTurnId)
    if (mergedTurns === turns) return result
    return {
      ...record,
      thread: {
        ...thread,
        turns: mergedTurns,
      },
    }
  } catch {
    return result
  }
}

function readEnvValueFromFile(filePath: string, key: string): string | null {
  try {
    const content = readFileSync(filePath, 'utf8')
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = content.match(new RegExp(`^\\s*${escapedKey}\\s*=\\s*(.+)\\s*$`, 'm'))
    if (!match) return null
    const rawValue = match[1]?.trim() ?? ''
    if (!rawValue) return null
    if ((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith('\'') && rawValue.endsWith('\''))) {
      return rawValue.slice(1, -1).trim()
    }
    return rawValue
  } catch {
    return null
  }
}

function parseBooleanEnvFlag(value: string | null | undefined): boolean | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return null
}

function resolveApiPerfLoggingEnabled(): boolean {
  const explicitValue = parseBooleanEnvFlag(process.env[API_PERF_LOGGING_ENV_KEY])
  if (explicitValue !== null) return explicitValue

  const fromEnvLocal = parseBooleanEnvFlag(readEnvValueFromFile('.env.local', API_PERF_LOGGING_ENV_KEY))
  if (fromEnvLocal !== null) return fromEnvLocal

  const fromEnv = parseBooleanEnvFlag(readEnvValueFromFile('.env', API_PERF_LOGGING_ENV_KEY))
  if (fromEnv !== null) return fromEnv

  return false
}

const API_PERF_LOGGING_ENABLED = resolveApiPerfLoggingEnabled()

function parseNumberEnvFlag(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Number.parseFloat(value.trim())
  if (!Number.isFinite(parsed)) return null
  return parsed
}

function resolveNumericEnvConfig(envKey: string, fallback: number): number {
  const fromProcess = parseNumberEnvFlag(process.env[envKey])
  if (fromProcess !== null) return fromProcess

  const fromEnvLocal = parseNumberEnvFlag(readEnvValueFromFile('.env.local', envKey))
  if (fromEnvLocal !== null) return fromEnvLocal

  const fromEnv = parseNumberEnvFlag(readEnvValueFromFile('.env', envKey))
  if (fromEnv !== null) return fromEnv

  return fallback
}

const API_PERF_MS_THRESHOLD = resolveNumericEnvConfig(API_PERF_MS_THRESHOLD_ENV_KEY, DEFAULT_API_PERF_MS_THRESHOLD)
const API_PERF_BODY_MB_THRESHOLD = resolveNumericEnvConfig(API_PERF_BODY_MB_THRESHOLD_ENV_KEY, DEFAULT_API_PERF_BODY_MB_THRESHOLD)

function getChunkByteLength(chunk: unknown, encoding?: BufferEncoding): number {
  if (typeof chunk === 'string') {
    return Buffer.byteLength(chunk, encoding)
  }
  if (chunk instanceof Uint8Array) {
    return chunk.byteLength
  }
  if (ArrayBuffer.isView(chunk)) {
    return chunk.byteLength
  }
  if (chunk instanceof ArrayBuffer) {
    return chunk.byteLength
  }
  return 0
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function isInlineDataUrl(value: string): boolean {
  return /^data:/iu.test(value.trim())
}

function inferImageMimeTypeFromBytes(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif'
  }
  return null
}

function inferImageMimeTypeFromBase64(value: string): string | null {
  const compact = value.trim().replace(/\s+/gu, '')
  if (compact.length < 32 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(compact)) return null
  try {
    return inferImageMimeTypeFromBytes(Buffer.from(compact.slice(0, 64), 'base64'))
  } catch {
    return null
  }
}

function normalizeBase64ImageDataUrl(value: string, mimeType: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (isInlineDataUrl(trimmed)) {
    return /^data:image\//iu.test(trimmed) ? trimmed : null
  }
  const compact = trimmed.replace(/\s+/gu, '')
  const inferredMimeType = inferImageMimeTypeFromBase64(compact)
  if (!inferredMimeType) return null
  const normalizedMimeType = mimeType.trim().toLowerCase()
  const finalMimeType = normalizedMimeType.startsWith('image/') && normalizedMimeType !== 'image/*'
    ? normalizedMimeType
    : inferredMimeType
  return `data:${finalMimeType};base64,${compact}`
}

function extensionFromMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase()
  if (normalized === 'image/png') return '.png'
  if (normalized === 'image/jpeg') return '.jpg'
  if (normalized === 'image/webp') return '.webp'
  if (normalized === 'image/gif') return '.gif'
  if (normalized === 'image/svg+xml') return '.svg'
  if (normalized === 'application/pdf') return '.pdf'
  return ''
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function toAttachmentLinkTarget(block: Record<string, unknown>, fallback: string): string {
  const candidate = asNonEmptyString(block.path)
    ?? asNonEmptyString(block.file_path)
    ?? asNonEmptyString(block.filename)
    ?? asNonEmptyString(block.file_id)
    ?? fallback
  if (candidate.startsWith('file://')) return candidate
  if (candidate.startsWith('/')) return `file://${candidate}`
  return `attachment://${candidate}`
}

async function persistInlineDataUrlToLocalFile(dataUrl: string, baseName: string): Promise<string | null> {
  const trimmed = dataUrl.trim()
  const match = /^data:([^;,]*)(;base64)?,(.*)$/isu.exec(trimmed)
  if (!match) return null
  const mimeType = (match[1] ?? '').trim().toLowerCase()
  const encodedPayload = match[3] ?? ''
  let bytes: Buffer
  try {
    bytes = match[2]
      ? Buffer.from(encodedPayload, 'base64')
      : Buffer.from(decodeURIComponent(encodedPayload), 'utf8')
  } catch {
    return null
  }
  if (bytes.length === 0) return null

  const hash = createHash('sha1').update(bytes).digest('hex')
  const ext = extensionFromMimeType(mimeType)
  const mediaDir = join(tmpdir(), 'codex-web-inline-media')
  await mkdir(mediaDir, { recursive: true })
  const fileName = `${baseName}-${hash}${ext}`
  const filePath = join(mediaDir, fileName)
  try {
    await stat(filePath)
  } catch {
    await writeFile(filePath, bytes)
  }
  return filePath
}

function toLocalImageProxyUrl(path: string): string {
  return `/codex-local-image?path=${encodeURIComponent(path)}`
}

const INLINE_IMAGE_FIELD_NAMES = new Set([
  'b64_json',
  'image',
  'image_url',
  'images',
  'result',
  'url',
])

type InlinePayloadSanitizeContext = {
  turnId: string
  itemId: string
  blockIndex: number
  fieldName?: string
}

function isPotentialInlineImageField(fieldName: string | undefined): boolean {
  return typeof fieldName === 'string' && INLINE_IMAGE_FIELD_NAMES.has(fieldName)
}

async function sanitizeInlineImageString(
  value: string,
  context: InlinePayloadSanitizeContext,
): Promise<{ value: string; changed: boolean }> {
  if (!isPotentialInlineImageField(context.fieldName)) {
    return { value, changed: false }
  }

  const dataUrl = normalizeBase64ImageDataUrl(value, 'image/*')
  if (!dataUrl) return { value, changed: false }

  const localUrl = await persistInlineDataUrlToLocalFile(
    dataUrl,
    `inline-image-${context.turnId}-${context.itemId}-${context.fieldName}-${String(context.blockIndex)}`,
  )
  if (!localUrl) return { value, changed: false }

  return { value: toLocalImageProxyUrl(localUrl), changed: true }
}

async function sanitizeInlineUserContentBlock(
  block: unknown,
  context: InlinePayloadSanitizeContext,
): Promise<unknown> {
  const record = asRecord(block)
  if (!record) return block

  const type = asNonEmptyString(record.type) ?? ''
  const imageUrl = asNonEmptyString(record.url) ?? asNonEmptyString(record.image_url)
  if (imageUrl && isInlineDataUrl(imageUrl)) {
    const localUrl = await persistInlineDataUrlToLocalFile(imageUrl, `inline-image-${context.turnId}-${context.itemId}-${String(context.blockIndex)}`)
    if (localUrl) {
      const nextRecord = { ...record }
      if (typeof record.url === 'string') {
        nextRecord.url = toLocalImageProxyUrl(localUrl)
      }
      if (typeof record.image_url === 'string') {
        nextRecord.image_url = toLocalImageProxyUrl(localUrl)
      }
      return {
        ...nextRecord,
        type: 'image',
      }
    }
    const target = toAttachmentLinkTarget(record, `inline-image/${context.turnId}/${context.itemId}/${String(context.blockIndex)}`)
    return {
      type: 'text',
      text: `Image attachment: ${target}`,
    }
  }

  if (type === 'imageGeneration' || type === 'image_generation') {
    const rawResult = asNonEmptyString(record.result)
      ?? asNonEmptyString(record.b64_json)
      ?? asNonEmptyString(record.image)
    const mimeType = asNonEmptyString(record.mime_type)
      ?? asNonEmptyString(record.mimeType)
      ?? 'image/png'
    const dataUrl = rawResult ? normalizeBase64ImageDataUrl(rawResult, mimeType) : null
    if (dataUrl) {
      const localUrl = await persistInlineDataUrlToLocalFile(dataUrl, `generated-image-${context.turnId}-${context.itemId}`)
      if (localUrl) {
        return {
          ...record,
          type: 'imageView',
          path: localUrl,
        }
      }
    }
  }

  const inlineFileData = asNonEmptyString(record.file_data)
    ?? asNonEmptyString(record.data)
    ?? asNonEmptyString(record.base64)
  if ((type.includes('file') || type === 'input_file' || type === 'file') && inlineFileData) {
    const mimeType = asNonEmptyString(record.mime_type) ?? 'application/octet-stream'
    const fileDataUrl = `data:${mimeType};base64,${inlineFileData}`
    const localUrl = await persistInlineDataUrlToLocalFile(fileDataUrl, `inline-file-${context.turnId}-${context.itemId}-${String(context.blockIndex)}`)
    if (localUrl) {
      return {
        type: 'text',
        text: `File attachment: ${localUrl}`,
      }
    }
    const target = toAttachmentLinkTarget(record, `inline-file/${context.turnId}/${context.itemId}/${String(context.blockIndex)}`)
    return {
      type: 'text',
      text: `File attachment: ${target}`,
    }
  }

  return block
}

async function sanitizeInlinePayloadDeep(
  value: unknown,
  context: InlinePayloadSanitizeContext,
): Promise<{ value: unknown; changed: boolean }> {
  const maybeBlock = await sanitizeInlineUserContentBlock(value, context)
  if (maybeBlock !== value) {
    return { value: maybeBlock, changed: true }
  }

  if (typeof value === 'string') {
    return sanitizeInlineImageString(value, context)
  }

  if (Array.isArray(value)) {
    let changed = false
    const nextArray: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      const nested = await sanitizeInlinePayloadDeep(value[index], {
        turnId: context.turnId,
        itemId: context.itemId,
        blockIndex: index,
        fieldName: context.fieldName,
      })
      if (nested.changed) changed = true
      nextArray.push(nested.value)
    }
    return changed ? { value: nextArray, changed: true } : { value, changed: false }
  }

  const record = asRecord(value)
  if (!record) return { value, changed: false }

  let changed = false
  const nextRecord: Record<string, unknown> = {}
  for (const [key, nestedValue] of Object.entries(record)) {
    const nested = await sanitizeInlinePayloadDeep(nestedValue, {
      turnId: context.turnId,
      itemId: context.itemId,
      blockIndex: context.blockIndex,
      fieldName: key,
    })
    if (nested.changed) changed = true
    nextRecord[key] = nested.value
  }

  return changed ? { value: nextRecord, changed: true } : { value, changed: false }
}

export async function sanitizeThreadTurnsInlinePayloads(method: string, result: unknown): Promise<unknown> {
  if (!THREAD_METHODS_WITH_TURNS.has(method)) return result

  const record = asRecord(result)
  const thread = asRecord(record?.thread)
  const turns = Array.isArray(thread?.turns) ? thread.turns : null
  if (!record || !thread || !turns || turns.length === 0) return result

  let changed = false
  const nextTurns: unknown[] = []
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turn = turns[turnIndex]
    const turnRecord = asRecord(turn)
    const turnId = asNonEmptyString(turnRecord?.id) ?? 'turn'
    const items = Array.isArray(turnRecord?.items) ? turnRecord.items : null
    if (!turnRecord || !items) {
      nextTurns.push(turn)
      continue
    }

    let itemChanged = false
    const nextItems: unknown[] = []
    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
      const item = items[itemIndex]
      const itemRecord = asRecord(item)
      const itemId = asNonEmptyString(itemRecord?.id) ?? 'item'
      if (!itemRecord) {
        nextItems.push(item)
        continue
      }
      const sanitizedItem = await sanitizeInlinePayloadDeep(item, {
        turnId,
        itemId,
        blockIndex: itemIndex + turnIndex,
      })
      if (!sanitizedItem.changed) {
        nextItems.push(item)
        continue
      }
      itemChanged = true
      nextItems.push(sanitizedItem.value)
    }

    if (!itemChanged) {
      nextTurns.push(turn)
      continue
    }
    changed = true
    nextTurns.push({
      ...turnRecord,
      items: nextItems,
    })
  }

  if (!changed) return result
  return {
    ...record,
    thread: {
      ...thread,
      turns: nextTurns,
    },
  }
}

function trimThreadTurnsInRpcResult(method: string, result: unknown): unknown {
  if (!THREAD_METHODS_WITH_TURNS.has(method)) return result

  const record = asRecord(result)
  const thread = asRecord(record?.thread)
  const turns = Array.isArray(thread?.turns) ? thread.turns : null
  if (!record || !thread || !turns || turns.length <= THREAD_RESPONSE_TURN_LIMIT) return result
  const startTurnIndex = Math.max(0, turns.length - THREAD_RESPONSE_TURN_LIMIT)

  return {
    ...record,
    threadTurnStartIndex: startTurnIndex,
    thread: {
      ...thread,
      turns: turns.slice(startTurnIndex),
    },
  }
}

function getErrorMessage(payload: unknown, fallback: string): string {
  if (payload instanceof Error && payload.message.trim().length > 0) {
    return payload.message
  }

  const record = asRecord(payload)
  if (!record) return fallback

  if (typeof record.message === 'string' && record.message.length > 0) return record.message

  const error = record.error
  if (typeof error === 'string' && error.length > 0) return error

  const nestedError = asRecord(error)
  if (nestedError && typeof nestedError.message === 'string' && nestedError.message.length > 0) {
    return nestedError.message
  }

  return fallback
}

export function isUnauthenticatedRateLimitError(error: unknown): boolean {
  const message = getErrorMessage(error, '').toLowerCase()
  return message.includes('authentication required') && message.includes('rate limits')
}

export function isEmptyThreadReadError(error: unknown): boolean {
  const message = getErrorMessage(error, '').toLowerCase()
  return message.includes('failed to read thread') && message.includes('rollout') && message.includes('is empty')
}

export function isThreadMaterializationPendingError(error: unknown): boolean {
  const message = getErrorMessage(error, '').toLowerCase()
  return message.includes('not materialized yet') && message.includes('includeturns is unavailable before first user message')
}

export function isThreadNotFoundError(error: unknown): boolean {
  const message = getErrorMessage(error, '').toLowerCase()
  return message.includes('thread not found') || message.includes('no rollout found for thread id')
}

function readStreamTurnId(params: Record<string, unknown>): string {
  const directTurnId = readNonEmptyString(params.turnId) || readNonEmptyString(params.turn_id)
  if (directTurnId) return directTurnId
  const turn = asRecord(params.turn)
  return readNonEmptyString(turn?.id)
}

function readStreamTurnErrorMessage(frame: StreamEventFrame): { turnId: string; message: string } | null {
  const params = asRecord(frame.params)
  if (!params) return null
  const turnId = readStreamTurnId(params)
  if (!turnId) return null

  if (frame.method === 'turn/completed') {
    const turn = asRecord(params.turn)
    if (turn?.status !== 'failed') return null
    const message = getErrorMessage(turn.error, '')
    return message ? { turnId, message } : null
  }

  if (frame.method === 'error' && params.willRetry !== true) {
    const message = getErrorMessage(params.error, '') || readNonEmptyString(params.message)
    return message ? { turnId, message } : null
  }

  return null
}

function mergeStreamTurnErrorsIntoThreadResult(appServer: AppServerProcess, result: unknown): unknown {
  const record = asRecord(result)
  const thread = asRecord(record?.thread)
  const threadId = readNonEmptyString(thread?.id)
  const turns = Array.isArray(thread?.turns) ? thread.turns : null
  if (!record || !thread || !threadId || !turns || turns.length === 0) return result

  const errorsByTurnId = new Map<string, string>()
  for (const frame of appServer.getStreamEvents(threadId, STREAM_EVENT_BUFFER_LIMIT)) {
    const error = readStreamTurnErrorMessage(frame)
    if (error) errorsByTurnId.set(error.turnId, error.message)
  }
  if (errorsByTurnId.size === 0) return result

  let changed = false
  const mergedTurns = turns.map((turn) => {
    const turnRecord = asRecord(turn)
    const turnId = readNonEmptyString(turnRecord?.id)
    const message = turnId ? errorsByTurnId.get(turnId) : ''
    if (!turnRecord || !turnId || !message) return turn
    const existingErrorMessage = getErrorMessage(turnRecord.error, '')
    if (turnRecord.status === 'failed' && existingErrorMessage) return turn
    changed = true
    return {
      ...turnRecord,
      status: 'failed',
      error: {
        message,
        codexErrorInfo: null,
        additionalDetails: null,
      },
    }
  })

  if (!changed) return result
  return {
    ...record,
    thread: {
      ...thread,
      turns: mergedTurns,
    },
  }
}

const warnedCodexAuthReadFailures = new Set<string>()

function getErrorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : null
}

function getCodexAuthReadErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : String(error)
}

function warnCodexAuthReadFailure(authPath: string, error: unknown): void {
  const message = getCodexAuthReadErrorMessage(error)
  const warningKey = `${authPath}:${message}`
  if (warnedCodexAuthReadFailures.has(warningKey)) return
  warnedCodexAuthReadFailures.add(warningKey)
  console.warn('[codex-auth] Unable to read Codex auth state', { path: authPath, error: message })
}

export async function hasUsableCodexAuth(): Promise<boolean> {
  const authPath = getCodexAuthPath()
  try {
    const raw = await readFile(authPath, 'utf8')
    const auth = JSON.parse(raw) as CodexAuth
    return Boolean(auth.tokens?.access_token?.trim() || auth.tokens?.refresh_token?.trim())
  } catch (error) {
    if (getErrorCode(error) !== 'ENOENT') {
      warnCodexAuthReadFailure(authPath, error)
    }
    return false
  }
}

function setJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

const PROJECT_ZIP_SKIPPED_NAMES = new Set([
  '.build',
  '.cache',
  '.coverage',
  '.DS_Store',
  '.eggs',
  '.eslintcache',
  '.gradle',
  '.git',
  '.ipynb_checkpoints',
  '.mypy_cache',
  '.next',
  '.nox',
  '.nuxt',
  '.nyc_output',
  '.parcel-cache',
  '.pytest_cache',
  '.ruff_cache',
  '.svelte-kit',
  '.turbo',
  '.tox',
  '.venv',
  '.vite',
  '__pycache__',
  'bin',
  'build',
  'coverage',
  'DerivedData',
  'dist',
  'htmlcov',
  'node_modules',
  'obj',
  'target',
  'venv',
])

type ZipCentralDirectoryEntry = {
  path: string
  crc32: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
  dosTime: number
  dosDate: number
  externalAttributes: number
  isDirectory: boolean
}

type ProjectZipVirtualEntry = {
  path: string
  data?: Buffer
  filePath?: string
  mtime: Date
}

type ParsedProjectZipEntry = {
  path: string
  data: Buffer
  isDirectory: boolean
}

type ImportedSessionRecord = {
  id: string
  path: string
  cwd: string
  title: string
  createdAtMs: number
  updatedAtMs: number
  model: string
  modelProvider: string
  cliVersion: string
  firstUserMessage: string
}

type ExportedThreadMetadata = {
  title: string
  updatedAtMs: number
}

const ZIP_CRC_TABLE = new Uint32Array(256)
for (let index = 0; index < ZIP_CRC_TABLE.length; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
  }
  ZIP_CRC_TABLE[index] = value >>> 0
}

function updateZipCrc32(crc: number, chunk: Buffer): number {
  let value = crc
  for (let index = 0; index < chunk.length; index += 1) {
    value = (value >>> 8) ^ ZIP_CRC_TABLE[(value ^ chunk[index]) & 0xff]
  }
  return value >>> 0
}

function toDosDateTime(date: Date): { dosDate: number; dosTime: number } {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()))
  const month = date.getMonth() + 1
  const day = date.getDate()
  const hours = date.getHours()
  const minutes = date.getMinutes()
  const seconds = Math.floor(date.getSeconds() / 2)
  return {
    dosDate: ((year - 1980) << 9) | (month << 5) | day,
    dosTime: (hours << 11) | (minutes << 5) | seconds,
  }
}

function assertZipUInt32(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`${label} is too large for ZIP export`)
  }
}

function assertZipEntryCount(value: number): void {
  if (value > 0xffff) {
    throw new Error('Project has too many files for ZIP export')
  }
}

function addZipOffset(offset: number, size: number): number {
  const next = offset + size
  assertZipUInt32(next, 'ZIP archive')
  return next
}

function writeZipUInt32(buffer: Buffer, value: number, offset: number): void {
  buffer.writeUInt32LE(value >>> 0, offset)
}

function buildZipLocalHeader(path: string, timestamp: Date): Buffer {
  const name = Buffer.from(path, 'utf8')
  const { dosDate, dosTime } = toDosDateTime(timestamp)
  const header = Buffer.alloc(30 + name.length)
  writeZipUInt32(header, 0x04034b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(0x0808, 6)
  header.writeUInt16LE(0, 8)
  header.writeUInt16LE(dosTime, 10)
  header.writeUInt16LE(dosDate, 12)
  header.writeUInt16LE(name.length, 26)
  name.copy(header, 30)
  return header
}

function buildZipDataDescriptor(crc32: number, size: number): Buffer {
  assertZipUInt32(size, 'Project file')
  const descriptor = Buffer.alloc(16)
  writeZipUInt32(descriptor, 0x08074b50, 0)
  writeZipUInt32(descriptor, crc32, 4)
  writeZipUInt32(descriptor, size, 8)
  writeZipUInt32(descriptor, size, 12)
  return descriptor
}

function buildZipCentralHeader(entry: ZipCentralDirectoryEntry): Buffer {
  assertZipUInt32(entry.localHeaderOffset, 'ZIP local header offset')
  const name = Buffer.from(entry.path, 'utf8')
  const header = Buffer.alloc(46 + name.length)
  writeZipUInt32(header, 0x02014b50, 0)
  header.writeUInt16LE(0x0314, 4)
  header.writeUInt16LE(20, 6)
  header.writeUInt16LE(0x0808, 8)
  header.writeUInt16LE(0, 10)
  header.writeUInt16LE(entry.dosTime, 12)
  header.writeUInt16LE(entry.dosDate, 14)
  writeZipUInt32(header, entry.crc32, 16)
  writeZipUInt32(header, entry.compressedSize, 20)
  writeZipUInt32(header, entry.uncompressedSize, 24)
  header.writeUInt16LE(name.length, 28)
  writeZipUInt32(header, entry.externalAttributes, 38)
  writeZipUInt32(header, entry.localHeaderOffset, 42)
  name.copy(header, 46)
  return header
}

function buildZipEndOfCentralDirectory(entryCount: number, centralSize: number, centralOffset: number): Buffer {
  assertZipUInt32(centralSize, 'ZIP central directory')
  assertZipUInt32(centralOffset, 'ZIP central directory offset')
  assertZipEntryCount(entryCount)
  const footer = Buffer.alloc(22)
  writeZipUInt32(footer, 0x06054b50, 0)
  footer.writeUInt16LE(entryCount, 8)
  footer.writeUInt16LE(entryCount, 10)
  writeZipUInt32(footer, centralSize, 12)
  writeZipUInt32(footer, centralOffset, 16)
  return footer
}

function toZipEntryPath(root: string, absolutePath: string, isDirectory: boolean): string {
  const path = relative(root, absolutePath).split(sep).join('/')
  return isDirectory && !path.endsWith('/') ? `${path}/` : path
}

async function writeZipChunk(res: ServerResponse, chunk: Buffer): Promise<void> {
  if (res.destroyed || res.writableEnded) {
    throw new Error('Response closed during ZIP export')
  }
  if (!res.write(chunk)) {
    await Promise.race([
      once(res, 'drain'),
      once(res, 'close').then(() => {
        throw new Error('Response closed during ZIP export')
      }),
      once(res, 'error').then(([error]) => {
        throw error instanceof Error ? error : new Error('Response failed during ZIP export')
      }),
    ])
  }
}

type ProjectZipIgnoreMatcher = {
  isIgnored: (path: string) => boolean
}

async function createProjectZipIgnoreMatcher(root: string): Promise<ProjectZipIgnoreMatcher> {
  try {
    const gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd: root })
    const rawIgnored = await runCommandCaptureRaw(
      'git',
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      { cwd: gitRoot },
    )
    const ignoredPaths = rawIgnored
      .split('\0')
      .filter(Boolean)
      .map((entry) => resolve(gitRoot, entry))
    return {
      isIgnored(path) {
        return ignoredPaths.some((ignoredPath) => isSameOrDescendantPath(path, ignoredPath))
      },
    }
  } catch {
    return { isIgnored: () => false }
  }
}

async function* walkProjectZipEntries(
  root: string,
  ignoreMatcher: ProjectZipIgnoreMatcher,
  current = root,
): AsyncGenerator<{ path: string; isDirectory: boolean; mtime: Date }> {
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    if (PROJECT_ZIP_SKIPPED_NAMES.has(entry.name)) continue
    const absolutePath = join(current, entry.name)
    if (ignoreMatcher.isIgnored(absolutePath)) continue
    const info = await lstat(absolutePath)
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) {
      yield { path: absolutePath, isDirectory: true, mtime: info.mtime }
      yield* walkProjectZipEntries(root, ignoreMatcher, absolutePath)
    } else if (info.isFile()) {
      yield { path: absolutePath, isDirectory: false, mtime: info.mtime }
    }
  }
}

async function writeProjectZipEntry(
  res: ServerResponse,
  centralEntries: ZipCentralDirectoryEntry[],
  offset: number,
  entry: { zipPath: string; mtime: Date; isDirectory: boolean; chunks: AsyncIterable<Buffer> },
): Promise<number> {
  if (!entry.zipPath) return offset
  const localHeaderOffset = offset
  const localHeader = buildZipLocalHeader(entry.zipPath, entry.mtime)
  await writeZipChunk(res, localHeader)
  offset = addZipOffset(offset, localHeader.length)

  let crc = 0xffffffff
  let size = 0
  if (!entry.isDirectory) {
    for await (const buffer of entry.chunks) {
      crc = updateZipCrc32(crc, buffer)
      size += buffer.length
      assertZipUInt32(size, 'Project file')
      await writeZipChunk(res, buffer)
      offset = addZipOffset(offset, buffer.length)
    }
  }

  const crc32 = (crc ^ 0xffffffff) >>> 0
  const descriptor = buildZipDataDescriptor(crc32, size)
  await writeZipChunk(res, descriptor)
  offset = addZipOffset(offset, descriptor.length)

  assertZipEntryCount(centralEntries.length + 1)
  const { dosDate, dosTime } = toDosDateTime(entry.mtime)
  centralEntries.push({
    path: entry.zipPath,
    crc32,
    compressedSize: size,
    uncompressedSize: size,
    localHeaderOffset,
    dosDate,
    dosTime,
    externalAttributes: entry.isDirectory ? 0x10 : 0,
    isDirectory: entry.isDirectory,
  })
  return offset
}

async function* singleZipBufferChunk(data: Buffer): AsyncGenerator<Buffer> {
  yield data
}

async function streamProjectZip(root: string, res: ServerResponse, virtualEntries: ProjectZipVirtualEntry[] = [], sourceRoots = [{ root, prefix: '' }]): Promise<void> {
  const centralEntries: ZipCentralDirectoryEntry[] = []
  let offset = 0
  for (const source of sourceRoots) {
    const ignoreMatcher = await createProjectZipIgnoreMatcher(source.root)
    for await (const entry of walkProjectZipEntries(source.root, ignoreMatcher)) {
      const zipPath = source.prefix + toZipEntryPath(source.root, entry.path, entry.isDirectory)
      if (zipPath === '.codex-project/manifest.json') continue
      offset = await writeProjectZipEntry(res, centralEntries, offset, {
        zipPath,
        mtime: entry.mtime,
        isDirectory: entry.isDirectory,
        chunks: entry.isDirectory ? singleZipBufferChunk(Buffer.alloc(0)) : createReadStream(entry.path) as AsyncIterable<Buffer>,
      })
    }
  }

  for (const entry of virtualEntries) {
    offset = await writeProjectZipEntry(res, centralEntries, offset, {
      zipPath: entry.path,
      mtime: entry.mtime,
      isDirectory: false,
      chunks: entry.filePath ? createReadStream(entry.filePath) as AsyncIterable<Buffer> : singleZipBufferChunk(entry.data ?? Buffer.alloc(0)),
    })
  }

  const centralOffset = offset
  let centralSize = 0
  for (const entry of centralEntries) {
    const header = buildZipCentralHeader(entry)
    await writeZipChunk(res, header)
    centralSize = addZipOffset(centralSize, header.length)
    offset = addZipOffset(offset, header.length)
  }
  const footer = buildZipEndOfCentralDirectory(centralEntries.length, centralSize, centralOffset)
  await writeZipChunk(res, footer)
}

function toProjectZipFileName(cwd: string): string {
  const rawName = basename(cwd) || 'project'
  const safeName = rawName.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
  return `${safeName}.zip`
}

function setProjectZipHeaders(res: ServerResponse, fileName: string): void {
  const encodedName = encodeURIComponent(fileName)
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/"/g, '')}"; filename*=UTF-8''${encodedName}`)
  res.setHeader('Cache-Control', 'private, no-store')
}

function isSameOrDescendantPath(candidate: string, root: string): boolean {
  if (candidate === root) return true
  const rootWithSeparator = root.endsWith(sep) ? root : `${root}${sep}`
  return candidate.startsWith(rootWithSeparator)
}

async function resolveAllowedProjectZipCwd(rawCwd: string): Promise<string> {
  const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd)
  const cwdInfo = await stat(cwd)
  if (!cwdInfo.isDirectory()) {
    throw new Error('cwd is not a directory')
  }
  return await realpath(cwd)
}

async function* walkFiles(root: string, current = root): AsyncGenerator<string> {
  let entries
  try {
    entries = await readdir(current, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const absolutePath = join(current, entry.name)
    if (entry.isDirectory()) {
      yield* walkFiles(root, absolutePath)
    } else if (entry.isFile()) {
      yield absolutePath
    }
  }
}

function readSessionMetaCwd(raw: string): string {
  const firstLine = raw.split(/\r?\n/u, 1)[0]?.trim()
  if (!firstLine) return ''
  try {
    const parsed = JSON.parse(firstLine) as unknown
    const record = asRecord(parsed)
    const payload = asRecord(record?.payload)
    return readNonEmptyString(payload?.cwd)
  } catch {
    return ''
  }
}

function readSessionMetaId(raw: string): string {
  const firstLine = raw.split(/\r?\n/u, 1)[0]?.trim()
  if (!firstLine) return ''
  try {
    const parsed = JSON.parse(firstLine) as unknown
    const record = asRecord(parsed)
    const payload = asRecord(record?.payload)
    return readNonEmptyString(payload?.id)
  } catch {
    return ''
  }
}

function getCurrentImportedSessionModelDefaults(): { model: string; modelProvider: string } | null {
  const fmState = ensureDefaultFreeModeStateForMissingAuthSync(join(getCodexHomeDir(), FREE_MODE_STATE_FILE))
  if (!fmState?.enabled) return null
  if (fmState.provider === 'opencode-zen') {
    return {
      model: fmState.model?.trim() || OPENCODE_ZEN_DEFAULT_MODEL,
      modelProvider: 'opencode_zen',
    }
  }
  if (fmState.provider === 'custom' && fmState.customBaseUrl?.trim()) {
    return {
      model: fmState.model?.trim() || '',
      modelProvider: 'custom_endpoint',
    }
  }
  if (fmState.apiKey?.trim()) {
    return {
      model: fmState.model?.trim() || FREE_MODE_DEFAULT_MODEL,
      modelProvider: 'openrouter_free',
    }
  }
  return null
}

function rewriteImportedSession(raw: string, importedCwd: string, importedThreadId: string): string {
  const lines: string[] = []
  let hasUserMessageEvent = false
  const modelDefaults = getCurrentImportedSessionModelDefaults()
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as unknown
      const record = asRecord(parsed)
      const payload = asRecord(record?.payload)
      if (record?.type === 'event_msg' && readNonEmptyString(payload?.type) === 'user_message') {
        hasUserMessageEvent = true
      }
      if (payload && typeof payload.cwd === 'string') {
        payload.cwd = importedCwd
      }
      if (record?.type === 'session_meta' && payload) {
        payload.id = importedThreadId
        payload.source = 'cli'
        payload.imported = true
        if (!readNonEmptyString(payload.originator)) {
          payload.originator = 'codex_cli_rs'
        }
        if (modelDefaults) {
          payload.model = modelDefaults.model
          payload.model_provider = modelDefaults.modelProvider
        }
      }
      lines.push(JSON.stringify(parsed))
      if (!hasUserMessageEvent && payload && record?.type === 'response_item' && readNonEmptyString(payload.role) === 'user') {
        const content = Array.isArray(payload.content) ? payload.content : []
        const text = content
          .map((item) => readNonEmptyString(asRecord(item)?.text))
          .find((value) => value.length > 0)
        if (text) {
          lines.push(JSON.stringify({
            timestamp: readNonEmptyString(record.timestamp) || new Date().toISOString(),
            type: 'event_msg',
            payload: { type: 'user_message', message: text, images: [] },
          }))
          hasUserMessageEvent = true
        }
      }
    } catch {
      lines.push(line)
    }
  }
  return `${lines.join('\n')}\n`
}

function readImportedSessionRecord(raw: string, path: string, cwd: string, fallbackId: string, importedTitle = ''): ImportedSessionRecord {
  let id = fallbackId
  let createdAtMs = Date.now()
  let updatedAtMs = 0
  let model = ''
  let modelProvider = 'openai'
  let cliVersion = ''
  let firstUserMessage = ''
  const title = importedTitle.trim()

  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as unknown
      const record = asRecord(parsed)
      const payload = asRecord(record?.payload)
      const timestamp = readNonEmptyString(record?.timestamp) || readNonEmptyString(payload?.timestamp)
      const timeMs = timestamp ? Date.parse(timestamp) : NaN
      if (Number.isFinite(timeMs)) {
        updatedAtMs = Math.max(updatedAtMs, timeMs)
      }
      if (record?.type === 'session_meta' && payload) {
        id = readNonEmptyString(payload.id) || id
        const metaTime = readNonEmptyString(payload.timestamp)
        const metaMs = metaTime ? Date.parse(metaTime) : NaN
        if (Number.isFinite(metaMs)) createdAtMs = metaMs
        model = readNonEmptyString(payload.model) || model
        modelProvider = readNonEmptyString(payload.model_provider) || modelProvider
        cliVersion = readNonEmptyString(payload.cli_version) || cliVersion
      }
      if (!firstUserMessage && record?.type === 'event_msg' && readNonEmptyString(payload?.type) === 'user_message') {
        firstUserMessage = readNonEmptyString(payload?.message)
      }
      if (!firstUserMessage && record?.type === 'response_item') {
        const role = readNonEmptyString(payload?.role)
        if (role === 'user') {
          const content = Array.isArray(payload?.content) ? payload.content : []
          for (const item of content) {
            const itemRecord = asRecord(item)
            const text = readNonEmptyString(itemRecord?.text)
            if (text) {
              firstUserMessage = text
              break
            }
          }
        }
      }
    } catch {
      continue
    }
  }

  const now = Date.now()
  createdAtMs = Math.min(createdAtMs, now)
  if (updatedAtMs <= 0) updatedAtMs = createdAtMs
  updatedAtMs = Math.min(Math.max(updatedAtMs, createdAtMs), now)
  return { id, path, cwd, title, createdAtMs, updatedAtMs, model, modelProvider, cliVersion, firstUserMessage }
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function ensureImportedThreadsStateDbTable(stateDbPath: string): boolean {
  const sql = `
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  rollout_path TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  source TEXT,
  model TEXT,
  model_provider TEXT,
  cwd TEXT,
  title TEXT,
  sandbox_policy TEXT,
  approval_mode TEXT,
  tokens_used INTEGER,
  has_user_event INTEGER,
  archived INTEGER,
  archived_at INTEGER,
  git_sha TEXT,
  git_branch TEXT,
  git_origin_url TEXT,
  cli_version TEXT,
  first_user_message TEXT,
  created_at_ms INTEGER,
  updated_at_ms INTEGER,
  thread_source TEXT,
  preview TEXT
);`
  const result = spawnSync('sqlite3', [stateDbPath, sql], { encoding: 'utf8' })
  if (result.status !== 0) {
    console.warn('[project-import] failed to initialize state database', result.stderr || result.stdout)
    return false
  }
  return true
}

function buildImportedSessionStateDbValues(session: ImportedSessionRecord): Record<string, string> {
  const title = session.title || session.firstUserMessage || 'Imported chat'
  const createdAt = Math.floor(session.createdAtMs / 1000)
  const updatedAt = Math.floor(session.updatedAtMs / 1000)
  const sandboxPolicy = JSON.stringify({ type: 'workspace-write', network_access: true })
  return {
    id: sqlString(session.id),
    rollout_path: sqlString(session.path),
    created_at: String(createdAt),
    updated_at: String(updatedAt),
    source: "'cli'",
    model: sqlString(session.model),
    model_provider: sqlString(session.modelProvider),
    cwd: sqlString(session.cwd),
    title: sqlString(title),
    sandbox_policy: sqlString(sandboxPolicy),
    approval_mode: "'on-request'",
    tokens_used: '0',
    has_user_event: '1',
    archived: '0',
    archived_at: 'NULL',
    git_sha: 'NULL',
    git_branch: 'NULL',
    git_origin_url: 'NULL',
    cli_version: sqlString(session.cliVersion),
    first_user_message: sqlString(session.firstUserMessage),
    created_at_ms: String(Math.trunc(session.createdAtMs)),
    updated_at_ms: String(Math.trunc(session.updatedAtMs)),
    thread_source: "'user'",
    preview: sqlString(title),
  }
}

function registerImportedSessionsInStateDb(sessions: ImportedSessionRecord[]): void {
  if (sessions.length === 0) return
  const stateDbPath = join(getCodexHomeDir(), 'state_5.sqlite')
  if (!ensureImportedThreadsStateDbTable(stateDbPath)) return
  const columnsResult = spawnSync('sqlite3', [stateDbPath, 'PRAGMA table_info(threads);'], { encoding: 'utf8' })
  if (columnsResult.status !== 0) {
    console.warn('[project-import] failed to inspect state database', columnsResult.stderr || columnsResult.stdout)
    return
  }
  const availableColumns = new Set(columnsResult.stdout
    .split(/\r?\n/u)
    .map((line) => line.split('|')[1])
    .filter((value): value is string => Boolean(value)))
  const values = buildImportedSessionStateDbValues(sessions[0])
  const columns = Object.keys(values).filter((column) => availableColumns.has(column))
  const inserts = sessions.map((session) => {
    const sessionValues = buildImportedSessionStateDbValues(session)
    return `INSERT OR REPLACE INTO threads (${columns.join(', ')}) VALUES (${columns.map((column) => sessionValues[column]).join(', ')});`
  })
  const sql = ['BEGIN;', ...inserts, 'COMMIT;'].join('\n')
  const result = spawnSync('sqlite3', [stateDbPath, sql], { encoding: 'utf8' })
  if (result.status !== 0) {
    console.warn('[project-import] failed to register imported sessions in state database', result.stderr || result.stdout)
  }
}

function listImportedThreadsFromStateDb(): Array<Record<string, unknown>> {
  const stateDbPath = join(getCodexHomeDir(), 'state_5.sqlite')
  if (!existsSync(stateDbPath)) return []
  const sql = `
SELECT id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
       cli_version, first_user_message, archived
FROM threads
WHERE archived = 0 AND replace(rollout_path, '\\', '/') LIKE '%/sessions/%' AND id IN (
  SELECT id FROM threads WHERE first_user_message != '' OR title != ''
)
ORDER BY updated_at DESC
LIMIT 200;
`
  const result = spawnSync('sqlite3', ['-json', stateDbPath, sql], { encoding: 'utf8' })
  if (result.status !== 0 || !result.stdout.trim()) return []
  try {
    const rows = JSON.parse(result.stdout) as unknown
    if (!Array.isArray(rows)) return []
    return rows.flatMap((row) => {
      const record = asRecord(row)
      const id = readNonEmptyString(record?.id)
      const path = readNonEmptyString(record?.rollout_path)
      const cwd = readNonEmptyString(record?.cwd)
      if (!id || !path || !cwd) return []
      const title = readNonEmptyString(record?.title) || readNonEmptyString(record?.first_user_message) || 'Imported chat'
      const createdAt = typeof record?.created_at === 'number' ? record.created_at : Math.floor(Date.now() / 1000)
      const updatedAt = typeof record?.updated_at === 'number' ? record.updated_at : createdAt
      return [{
        id,
        preview: title,
        modelProvider: readNonEmptyString(record?.model_provider) || 'openai',
        createdAt,
        updatedAt,
        path,
        cwd,
        cliVersion: readNonEmptyString(record?.cli_version),
        source: 'cli',
        gitInfo: null,
        turns: [],
      }]
    })
  } catch {
    return []
  }
}

function readStateDbThreadExportMetadata(): Map<string, ExportedThreadMetadata> {
  const stateDbPath = join(getCodexHomeDir(), 'state_5.sqlite')
  if (!existsSync(stateDbPath)) return new Map()
  const columnsResult = spawnSync('sqlite3', [stateDbPath, 'PRAGMA table_info(threads);'], { encoding: 'utf8' })
  if (columnsResult.status !== 0) return new Map()
  const availableColumns = new Set(columnsResult.stdout
    .split(/\r?\n/u)
    .map((line) => line.split('|')[1])
    .filter((value): value is string => Boolean(value)))
  if (!availableColumns.has('id')) return new Map()
  const selectColumns = [
    'id',
    availableColumns.has('title') ? 'title' : "'' AS title",
    availableColumns.has('preview') ? 'preview' : "'' AS preview",
    availableColumns.has('updated_at') ? 'updated_at' : '0 AS updated_at',
    availableColumns.has('updated_at_ms') ? 'updated_at_ms' : '0 AS updated_at_ms',
  ]
  const archivedPredicate = availableColumns.has('archived') ? 'WHERE archived = 0' : ''
  const sql = `
SELECT ${selectColumns.join(', ')}
FROM threads
${archivedPredicate};
`
  const result = spawnSync('sqlite3', ['-json', stateDbPath, sql], { encoding: 'utf8' })
  if (result.status !== 0 || !result.stdout.trim()) return new Map()
  try {
    const rows = JSON.parse(result.stdout) as unknown
    if (!Array.isArray(rows)) return new Map()
    const metadata = new Map<string, ExportedThreadMetadata>()
    for (const row of rows) {
      const record = asRecord(row)
      const id = readNonEmptyString(record?.id)
      if (!id) continue
      const title = readNonEmptyString(record?.title) || readNonEmptyString(record?.preview)
      const updatedAtMs =
        typeof record?.updated_at_ms === 'number' && Number.isFinite(record.updated_at_ms)
          ? Math.trunc(record.updated_at_ms)
          : typeof record?.updated_at === 'number' && Number.isFinite(record.updated_at)
            ? Math.trunc(record.updated_at * 1000)
            : 0
      if (!title && updatedAtMs <= 0) continue
      metadata.set(id, { title, updatedAtMs })
    }
    return metadata
  } catch {
    return new Map()
  }
}

function mergeImportedThreadsIntoThreadListResult(result: unknown, params: unknown): unknown {
  if (!maySupplementImportedThreads(params)) return result
  const record = asRecord(result)
  const data = Array.isArray(record?.data) ? record.data : null
  if (!record || !data) return result
  const importedById = new Map<string, Record<string, unknown>>()
  for (const thread of listImportedThreadsFromStateDb()) {
    const id = readNonEmptyString(thread.id)
    if (id) importedById.set(id, thread)
  }
  if (importedById.size === 0) return result
  const mergedData: unknown[] = []
  for (const item of data) {
    const id = readNonEmptyString(asRecord(item)?.id)
    const imported = id ? importedById.get(id) : undefined
    if (imported) {
      mergedData.push({ ...asRecord(item), ...imported })
      importedById.delete(id)
    } else {
      mergedData.push(item)
    }
  }
  mergedData.push(...importedById.values())
  return {
    ...record,
    data: mergedData.sort((a, b) => {
      const aUpdated = typeof asRecord(a)?.updatedAt === 'number' ? asRecord(a)?.updatedAt as number : 0
      const bUpdated = typeof asRecord(b)?.updatedAt === 'number' ? asRecord(b)?.updatedAt as number : 0
      return bUpdated - aUpdated
    }),
  }
}

async function collectProjectChatZipEntries(projectRoot: string | VirtualProject): Promise<ProjectZipVirtualEntry[]> {
  const organization = typeof projectRoot === 'string' ? null : projectRoot
  const canonicalProjectRoots = await Promise.all((typeof projectRoot === 'string' ? [projectRoot] : projectRoot.cwds).map(path => realpath(path).catch(() => resolve(path))))
  const codexHome = getCodexHomeDir()
  const threadTitles = await readMergedThreadTitleCache()
  const stateDbThreadMetadata = readStateDbThreadExportMetadata()
  const exportedTitles: Record<string, string> = {}
  const exportedConversationCwds: Record<string, string> = {}
  const exportedThreads: Record<string, ExportedThreadMetadata> = {}
  const roots = [
    { disk: join(codexHome, 'sessions'), zip: '.codex-project/chats/sessions' },
    { disk: join(codexHome, 'archived_sessions'), zip: '.codex-project/chats/archived_sessions' },
  ]
  const entries: ProjectZipVirtualEntry[] = [{
    path: '.codex-project/manifest.json',
    data: Buffer.from(JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      projectName: organization?.label || basename(canonicalProjectRoots[0] || '') || 'project',
      ...(organization ? { organization: { version: 1, members: organization.cwds.map((cwd, index) => ({ cwd, prefix: `files/${String(index + 1).padStart(6, '0')}/` })) } } : {}),
    }, null, 2)),
    mtime: new Date(),
  }]
  if (!canonicalProjectRoots.length) return entries

  for (const root of roots) {
    for await (const sessionPath of walkFiles(root.disk)) {
      if (extname(sessionPath) !== '.jsonl') continue
      let raw = ''
      try {
        raw = await readFile(sessionPath, 'utf8')
      } catch {
        continue
      }
      const sessionCwd = readSessionMetaCwd(raw)
      if (!sessionCwd) continue
      let canonicalSessionCwd = ''
      try {
        canonicalSessionCwd = await realpath(sessionCwd)
      } catch {
        canonicalSessionCwd = isAbsolute(sessionCwd) ? resolve(sessionCwd) : resolve(sessionCwd)
      }
      const memberIndex = canonicalProjectRoots.findIndex(root => organization ? root === canonicalSessionCwd : isSameOrDescendantPath(canonicalSessionCwd, root))
      if (memberIndex < 0) continue
      const rel = relative(root.disk, sessionPath).split(sep).join('/')
      const zipPath = `${root.zip}/${rel}`
      if (organization && sessionCwd !== organization.cwds[memberIndex]) exportedConversationCwds[zipPath] = organization.cwds[memberIndex]
      const sessionId = readSessionMetaId(raw)
      const stateMetadata = sessionId ? stateDbThreadMetadata.get(sessionId) : undefined
      const title = readNonEmptyString(stateMetadata?.title) || (sessionId ? readNonEmptyString(threadTitles.titles[sessionId]) : '')
      if (title) exportedTitles[zipPath] = title
      if (title || (stateMetadata?.updatedAtMs ?? 0) > 0) {
        exportedThreads[zipPath] = {
          title,
          updatedAtMs: stateMetadata?.updatedAtMs ?? 0,
        }
      }
      entries.push({
        path: zipPath,
        filePath: sessionPath,
        mtime: new Date(),
      })
    }
  }
  if (organization && Object.keys(exportedConversationCwds).length) {
    const manifest = JSON.parse(entries[0].data!.toString('utf8'))
    manifest.organization.conversationCwds = exportedConversationCwds
    entries[0].data = Buffer.from(JSON.stringify(manifest, null, 2))
  }
  if (Object.keys(exportedTitles).length > 0 || Object.keys(exportedThreads).length > 0) {
    entries.push({
      path: '.codex-project/chats/thread-titles.json',
      data: Buffer.from(JSON.stringify({ version: 2, titles: exportedTitles, threads: exportedThreads }, null, 2)),
      mtime: new Date(),
    })
  }
  return entries
}

function readZipUInt16(buffer: Buffer, offset: number): number {
  if (offset + 2 > buffer.length) throw new Error('Invalid project ZIP')
  return buffer.readUInt16LE(offset)
}

function readZipUInt32(buffer: Buffer, offset: number): number {
  if (offset + 4 > buffer.length) throw new Error('Invalid project ZIP')
  return buffer.readUInt32LE(offset)
}

function normalizeImportedZipPath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/u, '')
  const segments = normalized.endsWith('/') ? normalized.slice(0, -1).split('/') : normalized.split('/')
  if (!normalized || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Project ZIP contains an unsafe path')
  }
  return normalized
}

function parseStoredProjectZip(buffer: Buffer): ParsedProjectZipEntry[] {
  const eocdSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06])
  const eocdOffset = buffer.lastIndexOf(eocdSignature)
  if (eocdOffset < 0) throw new Error('Project ZIP is missing a central directory')
  const entryCount = readZipUInt16(buffer, eocdOffset + 10)
  const centralOffset = readZipUInt32(buffer, eocdOffset + 16)
  const entries: ParsedProjectZipEntry[] = []
  let cursor = centralOffset

  for (let index = 0; index < entryCount; index += 1) {
    if (readZipUInt32(buffer, cursor) !== 0x02014b50) throw new Error('Project ZIP central directory is invalid')
    const method = readZipUInt16(buffer, cursor + 10)
    if (method !== 0) throw new Error('Project ZIP import only supports stored entries')
    const compressedSize = readZipUInt32(buffer, cursor + 20)
    const fileNameLength = readZipUInt16(buffer, cursor + 28)
    const extraLength = readZipUInt16(buffer, cursor + 30)
    const commentLength = readZipUInt16(buffer, cursor + 32)
    const externalAttributes = readZipUInt32(buffer, cursor + 38)
    const localHeaderOffset = readZipUInt32(buffer, cursor + 42)
    const rawPath = buffer.subarray(cursor + 46, cursor + 46 + fileNameLength).toString('utf8')
    const path = normalizeImportedZipPath(rawPath)
    const isDirectory = path.endsWith('/') || ((externalAttributes >>> 4) & 0x10) === 0x10

    if (readZipUInt32(buffer, localHeaderOffset) !== 0x04034b50) throw new Error('Project ZIP local header is invalid')
    const localNameLength = readZipUInt16(buffer, localHeaderOffset + 26)
    const localExtraLength = readZipUInt16(buffer, localHeaderOffset + 28)
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength
    entries.push({
      path,
      data: isDirectory ? Buffer.alloc(0) : buffer.subarray(dataOffset, dataOffset + compressedSize),
      isDirectory,
    })
    cursor += 46 + fileNameLength + extraLength + commentLength
  }
  return entries
}

async function importProjectZip(buffer: Buffer, destinationParent: string): Promise<{ projectPath: string; importedSessions: number }> {
  const entries = parseStoredProjectZip(buffer)
  const manifestEntry = entries.find((entry) => entry.path === '.codex-project/manifest.json' && !entry.isDirectory)
  let projectName = 'imported-project'
  let organizationManifest: unknown
  if (manifestEntry) {
    try {
      const manifest = asRecord(JSON.parse(manifestEntry.data.toString('utf8')) as unknown)
      projectName = readNonEmptyString(manifest?.projectName) || projectName
      organizationManifest = manifest?.organization
    } catch {
      projectName = 'imported-project'
    }
  }
  if (organizationManifest === undefined) projectName = projectName.replace(/[\\/]+/g, '-').replace(/[\u0000-\u001f]+/g, '').trim() || 'imported-project'
  const organizationMembers = readProjectArchiveMembers(organizationManifest)
  const conversationCwds = normalizeStringRecord(asRecord(organizationManifest)?.conversationCwds)
  const memberCwdForEntry = (entry: { path: string; data: Buffer }) => Object.hasOwn(conversationCwds, entry.path) ? conversationCwds[entry.path] : readSessionMetaCwd(entry.data.toString('utf8'))
  if (organizationMembers) {
    for (const entry of entries) {
      if (entry.path.startsWith('.codex-project/chats/')) {
        if (entry.path.endsWith('.jsonl') && !organizationMembers.some(member => member.cwd === memberCwdForEntry(entry))) throw new Error('Invalid project conversation membership')
      } else if (entry.path !== '.codex-project/manifest.json' && !organizationMembers.some(member => entry.path.startsWith(member.prefix))) {
        throw new Error('Invalid project file membership')
      }
    }
  }
  const titleEntry = entries.find((entry) => entry.path === '.codex-project/chats/thread-titles.json' && !entry.isDirectory)
  const importedThreadMetadata = new Map<string, ExportedThreadMetadata>()
  if (titleEntry) {
    try {
      const payload = asRecord(JSON.parse(titleEntry.data.toString('utf8')) as unknown)
      const titles = asRecord(payload?.titles)
      if (titles) {
        for (const [key, value] of Object.entries(titles)) {
          const title = readNonEmptyString(value)
          if (key && title) importedThreadMetadata.set(key, { title, updatedAtMs: 0 })
        }
      }
      const threads = asRecord(payload?.threads)
      if (threads) {
        for (const [key, value] of Object.entries(threads)) {
          const record = asRecord(value)
          const title = readNonEmptyString(record?.title) || importedThreadMetadata.get(key)?.title || ''
          const updatedAtMs = typeof record?.updatedAtMs === 'number' && Number.isFinite(record.updatedAtMs)
            ? Math.trunc(record.updatedAtMs)
            : 0
          if (key && (title || updatedAtMs > 0)) importedThreadMetadata.set(key, { title, updatedAtMs })
        }
      }
    } catch {
      // Ignore malformed optional title metadata; imported chats still fall back to first user messages.
    }
  }

  const parent = await realpath(destinationParent)
  let projectPath: string
  const memberTargets = new Map<string, string>()
  if (organizationMembers) {
    const project = await getVirtualProjectStore().save(undefined, projectName)
    projectPath = project.id
    for (const member of organizationMembers) {
      const directory = await createProjectConversationDirectory(basename(member.cwd), project.id)
      memberTargets.set(member.cwd, directory.cwd)
    }
  } else {
    projectPath = join(parent, projectName)
    for (let index = 2; existsSync(projectPath); index += 1) projectPath = join(parent, `${projectName}-${index}`)
    await mkdir(projectPath, { recursive: true })
  }

  let importedSessions = 0
  const importedSessionRecords: ImportedSessionRecord[] = []
  const importedSessionsRoot = join(getCodexHomeDir(), 'sessions')
  const chatEntries = entries
    .filter((entry) => entry.path.startsWith('.codex-project/chats/') && !entry.isDirectory && extname(entry.path) === '.jsonl')
    .map((entry) => {
      const importedMetadata = importedThreadMetadata.get(entry.path)
      const sourceSessionRaw = entry.data.toString('utf8')
      const targetCwd = organizationMembers ? memberTargets.get(memberCwdForEntry(entry))! : projectPath
      const sourceRecord = readImportedSessionRecord(sourceSessionRaw, entry.path, targetCwd, readSessionMetaId(sourceSessionRaw) || randomUUID(), importedMetadata?.title ?? '')
      const updatedAtMs = (importedMetadata?.updatedAtMs ?? 0) > 0 ? importedMetadata?.updatedAtMs ?? 0 : sourceRecord.updatedAtMs
      return { entry, importedMetadata, sourceSessionRaw, sourceRecord, updatedAtMs, targetCwd }
    })
    .sort((first, second) => second.updatedAtMs - first.updatedAtMs)

  for (const [index, chatEntry] of chatEntries.entries()) {
    const importedThreadId = randomUUID()
    const target = join(importedSessionsRoot, 'imported', `${String(index + 1).padStart(6, '0')}-${importedThreadId}.jsonl`)
    await mkdir(dirname(target), { recursive: true })
    const importedSessionRaw = rewriteImportedSession(chatEntry.sourceSessionRaw, chatEntry.targetCwd, importedThreadId)
    await writeFile(target, importedSessionRaw, 'utf8')
    const importedRecord = readImportedSessionRecord(importedSessionRaw, target, chatEntry.targetCwd, importedThreadId, chatEntry.importedMetadata?.title ?? '')
    if (chatEntry.updatedAtMs > 0) {
      importedRecord.updatedAtMs = chatEntry.updatedAtMs
      importedRecord.createdAtMs = Math.min(chatEntry.sourceRecord.createdAtMs, importedRecord.updatedAtMs)
      const updatedAtDate = new Date(chatEntry.updatedAtMs)
      await utimes(target, updatedAtDate, updatedAtDate).catch(() => {})
    }
    importedSessionRecords.push(importedRecord)
    if (importedRecord.title) {
      const cache = await readThreadTitleCache()
      await writeThreadTitleCache(updateThreadTitleCache(cache, importedThreadId, importedRecord.title))
    }
    importedSessions += 1
  }
  registerImportedSessionsInStateDb(importedSessionRecords)

  for (const entry of entries) {
    if (entry.path.startsWith('.codex-project/chats/')) {
      continue
    }
    if (organizationMembers && entry.path === '.codex-project/manifest.json') continue
    const member = organizationMembers?.find(member => entry.path.startsWith(member.prefix))
    const targetRoot = member ? memberTargets.get(member.cwd)! : projectPath
    const target = join(targetRoot, member ? entry.path.slice(member.prefix.length) : entry.path)
    if (!isSameOrDescendantPath(target, targetRoot)) throw new Error('Project ZIP contains an unsafe path')
    if (entry.isDirectory) {
      await mkdir(target, { recursive: true })
    } else {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, entry.data)
    }
  }

  if (organizationMembers) await updateWorkspaceRootsState(state => ({ ...state, projectOrder: prependUniqueString(projectPath, state.projectOrder) }))
  else await persistWorkspaceRoot(projectPath, projectName)
  return { projectPath, importedSessions }
}

function logProviderModelDiscoveryWarning(message: string, details: Record<string, unknown>): void {
  console.warn('[codex-provider-models]', message, details)
}

function isTimeoutError(payload: unknown): boolean {
  return payload instanceof Error && (payload.name === 'AbortError' || payload.name === 'TimeoutError')
}

function formatProjectlessDateSegment(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function buildProjectlessPromptSlug(prompt: string | null): string {
  const slug = prompt
    ?.toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.slice(0, 6)
    .join('-')
    .slice(0, PROJECTLESS_THREAD_SLUG_MAX_LENGTH)
  return slug && slug.length > 0 ? slug : 'new-chat'
}

function buildProjectlessUniqueSuffix(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

export function buildProjectlessFolderName(slug: string, index: number, uniqueSuffix = buildProjectlessUniqueSuffix()): string {
  if (index === 0) return slug
  if (index < PROJECTLESS_THREAD_READABLE_DIRECTORY_ATTEMPTS) return `${slug}-${index + 1}`

  const suffix = `-${uniqueSuffix}`
  const maxSlugLength = Math.max(1, PROJECTLESS_THREAD_SLUG_MAX_LENGTH - suffix.length)
  return `${slug.slice(0, maxSlugLength)}${suffix}`
}

async function ensureRealDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} must be a real directory`)
  }
}

async function createProjectlessThreadDirectory(prompt: string | null): Promise<{ cwd: string; outputDirectory: string; workspaceRoot: string }> {
  const workspaceRoot = join(homedir(), 'Documents', 'Codex')
  await mkdir(workspaceRoot, { recursive: true })
  await ensureRealDirectory(workspaceRoot, 'Projectless workspace root')

  const dateDir = join(workspaceRoot, formatProjectlessDateSegment())
  await mkdir(dateDir, { recursive: true })
  await ensureRealDirectory(dateDir, 'Projectless thread date directory')

  const slug = buildProjectlessPromptSlug(prompt)
  for (let index = 0; index < PROJECTLESS_THREAD_DIRECTORY_MAX_ATTEMPTS; index += 1) {
    const folderName = buildProjectlessFolderName(slug, index)
    const cwd = join(dateDir, folderName)
    try {
      await mkdir(cwd, { recursive: false })
      return { cwd, outputDirectory: cwd, workspaceRoot }
    } catch {
      try {
        await stat(cwd)
      } catch {
        throw new Error('Failed to create new chat folder')
      }
    }
  }

  throw new Error('Unable to create a unique new chat folder')
}

function normalizeGithubCloneUrl(rawUrl: string): { url: string; repoName: string } {
  const trimmedUrl = rawUrl.trim()
  if (!trimmedUrl) throw new Error('Missing GitHub repository URL')

  const sshMatch = trimmedUrl.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u)
  if (sshMatch) {
    const repoName = sshMatch[2]
    return { url: `git@github.com:${sshMatch[1]}/${repoName}.git`, repoName }
  }

  let parsed: URL
  try {
    parsed = new URL(trimmedUrl)
  } catch {
    throw new Error('Enter a valid GitHub repository URL')
  }
  if (parsed.hostname.toLowerCase() !== 'github.com') {
    throw new Error('Only github.com repository URLs are supported')
  }
  const segments = parsed.pathname.split('/').filter(Boolean)
  if (segments.length < 2) {
    throw new Error('Enter a GitHub repository URL with owner and repository name')
  }
  const owner = segments[0]
  const repoName = segments[1].replace(/\.git$/iu, '')
  if (!/^[A-Za-z0-9_.-]+$/u.test(owner) || !/^[A-Za-z0-9_.-]+$/u.test(repoName)) {
    throw new Error('GitHub repository owner or name contains unsupported characters')
  }
  return { url: `https://github.com/${owner}/${repoName}.git`, repoName }
}

async function cloneGithubRepositoryIntoBase(rawUrl: string, rawBasePath: string): Promise<string> {
  const basePath = rawBasePath.trim()
  if (!basePath) throw new Error('Missing clone destination folder')
  const normalizedBasePath = isAbsolute(basePath) ? basePath : resolve(basePath)
  await ensureRealDirectory(normalizedBasePath, 'Clone destination folder')

  const { url, repoName } = normalizeGithubCloneUrl(rawUrl)
  const targetPath = join(normalizedBasePath, repoName)
  try {
    await stat(targetPath)
    throw new Error(`Destination already exists: ${targetPath}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
  }

  try {
    await runCommand('git', ['clone', url, targetPath], { cwd: normalizedBasePath, timeoutMs: 5 * 60_000 })
  } catch (error) {
    await rm(targetPath, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  await persistWorkspaceRoot(targetPath, '')
  return targetPath
}

function normalizeHeaderValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return null
}

function normalizeQueryParams(value: unknown): URLSearchParams {
  const params = new URLSearchParams()
  const record = asRecord(value)
  if (!record) return params

  for (const [key, rawValue] of Object.entries(record)) {
    const normalized = normalizeHeaderValue(rawValue)
    if (!normalized) continue
    params.set(key, normalized)
  }

  return params
}

function buildProviderModelsUrl(baseUrl: string, queryParams: unknown): URL {
  const url = new URL(baseUrl)
  url.pathname = url.pathname.endsWith('/') ? `${url.pathname}models` : `${url.pathname}/models`
  const extraParams = normalizeQueryParams(queryParams)
  for (const [key, value] of extraParams.entries()) {
    url.searchParams.set(key, value)
  }
  return url
}

export function normalizeProviderModelsData(payload: unknown): string[] {
  const record = asRecord(payload)
  const dataRows = Array.isArray(record?.data) ? record.data : null
  const modelRows = Array.isArray(record?.models) ? record.models : null
  const rows = dataRows?.length ? dataRows : modelRows?.length ? modelRows : dataRows ?? modelRows
  if (!rows) {
    throw new Error('provider /models payload is missing a data/models array')
  }

  const ids: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const candidateFromString = readNonEmptyString(row)
    const entry = asRecord(row)
    const candidate = candidateFromString
      || readNonEmptyString(entry?.id)
      || readNonEmptyString(entry?.model)
      || readNonEmptyString(entry?.slug)
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    ids.push(candidate)
  }
  return ids
}

async function fetchCustomEndpointDefaultModel(baseUrl: string, apiKey: string): Promise<string> {
  const normalizedBaseUrl = baseUrl.trim()
  if (!normalizedBaseUrl) return ''

  try {
    const modelsUrl = buildProviderModelsUrl(normalizedBaseUrl, null)
    const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
    const response = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(PROVIDER_MODELS_FETCH_TIMEOUT_MS) })
    if (!response.ok) return ''
    const payload = await response.json() as unknown
    const modelIds = normalizeProviderModelsData(payload)
    return modelIds[0] ?? ''
  } catch {
    return ''
  }
}

async function fetchOpenCodeZenModelIds(apiKey: string | null | undefined): Promise<string[]> {
  const headers: Record<string, string> = {}
  if (apiKey && apiKey !== 'dummy') {
    headers.Authorization = `Bearer ${apiKey}`
  }
  const response = await fetch('https://opencode.ai/zen/v1/models', {
    headers,
    signal: AbortSignal.timeout(PROVIDER_MODELS_FETCH_TIMEOUT_MS),
  })
  if (!response.ok) return []
  return normalizeProviderModelsData(await response.json() as unknown)
}

function sortOpenCodeZenModelIds(modelIds: string[]): string[] {
  const freeIds = modelIds.filter((id) => id.endsWith('-free') || id === OPENCODE_ZEN_DEFAULT_MODEL)
  const paidIds = modelIds.filter((id) => !id.endsWith('-free') && id !== OPENCODE_ZEN_DEFAULT_MODEL)
  return [...freeIds, ...paidIds]
}

async function readProviderBackedModelIds(appServer: AppServerProcess): Promise<ProviderModelsResponse> {
  const configPayload = asRecord(await appServer.rpc('config/read', {}))
  const config = asRecord(configPayload?.config)
  const providerId = readNonEmptyString(config?.model_provider)
  if (!providerId) {
    return { data: [], providerId: '', source: 'provider' }
  }

  const providers = asRecord(config?.model_providers)
  const provider = asRecord(providers?.[providerId])
  if (!provider) {
    logProviderModelDiscoveryWarning('configured provider is missing from model_providers', { providerId })
    return { data: [], providerId, source: 'provider' }
  }

  const wireApi = readNonEmptyString(provider.wire_api)
  if (wireApi !== 'responses') {
    return { data: [], providerId, source: 'provider' }
  }

  const baseUrl = readNonEmptyString(provider.base_url)
  if (!baseUrl) {
    logProviderModelDiscoveryWarning('responses provider is missing base_url', { providerId })
    return { data: [], providerId, source: 'provider' }
  }

  const headers = new Headers()
  const configuredHeaders = asRecord(provider.http_headers)
  if (configuredHeaders) {
    for (const [key, rawValue] of Object.entries(configuredHeaders)) {
      const normalized = normalizeHeaderValue(rawValue)
      if (!normalized) continue
      headers.set(key, normalized)
    }
  }

  const bearerToken = readNonEmptyString(provider.experimental_bearer_token)
  if (bearerToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${bearerToken}`)
  }

  const envKey = readNonEmptyString(provider.env_key)
  const envHttpHeaders = asRecord(provider.env_http_headers)
  if (envKey || envHttpHeaders) {
    logProviderModelDiscoveryWarning('provider discovery skipped env-backed auth/header expansion', {
      providerId,
      hasEnvKey: Boolean(envKey),
      hasEnvHttpHeaders: Boolean(envHttpHeaders),
    })
  }

  let requestUrl: URL
  try {
    requestUrl = buildProviderModelsUrl(baseUrl, provider.query_params)
  } catch (error) {
    logProviderModelDiscoveryWarning('provider /models URL was invalid', {
      providerId,
      error: getErrorMessage(error, 'invalid url'),
    })
    return { data: [], providerId, source: 'provider' }
  }

  let response: Response
  try {
    response = await fetch(requestUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(PROVIDER_MODELS_FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    logProviderModelDiscoveryWarning('provider /models request failed', {
      providerId,
      error: isTimeoutError(error) ? `request timed out after ${PROVIDER_MODELS_FETCH_TIMEOUT_MS}ms` : getErrorMessage(error, 'network error'),
    })
    return { data: [], providerId, source: 'provider' }
  }

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch (error) {
    logProviderModelDiscoveryWarning('provider /models response was not valid JSON', {
      providerId,
      status: response.status,
      error: getErrorMessage(error, 'invalid json'),
    })
    return { data: [], providerId, source: 'provider' }
  }

  if (!response.ok) {
    logProviderModelDiscoveryWarning('provider /models request returned non-2xx', {
      providerId,
      status: response.status,
      statusText: response.statusText,
    })
    return { data: [], providerId, source: 'provider' }
  }

  try {
    return {
      data: normalizeProviderModelsData(payload),
      providerId,
      source: 'provider',
    }
  } catch (error) {
    logProviderModelDiscoveryWarning('provider /models payload was invalid', {
      providerId,
      error: getErrorMessage(error, 'invalid payload'),
    })
    return { data: [], providerId, source: 'provider' }
  }
}

async function readProviderModelIdsForProvider(
  appServer: AppServerProcess,
  providerId: string,
): Promise<ProviderModelsResponse> {
  const normalizedProviderId = providerId.trim().toLowerCase().replace(/_/g, '-')
  if (!normalizedProviderId || normalizedProviderId === 'codex' || normalizedProviderId === 'openai') {
    return { data: [], providerId: '', source: 'provider' }
  }

  const fmState = ensureDefaultFreeModeStateForMissingAuthSync(join(getCodexHomeDir(), FREE_MODE_STATE_FILE))
  if (normalizedProviderId === 'opencode-zen') {
    try {
      const modelIds = filterOpenCodeZenModelsForAuthState(
        sortOpenCodeZenModelIds(await fetchOpenCodeZenModelIds(fmState?.provider === 'opencode-zen' ? fmState.apiKey : null)),
        fmState?.provider === 'opencode-zen' ? fmState.apiKey : null,
      )
      if (modelIds.length > 0) {
        return { data: modelIds, providerId: 'opencode-zen', source: 'provider' }
      }
    } catch {
      // Fall through to the offline Zen defaults.
    }
    return {
      data: ['big-pickle', 'minimax-m2.5-free', 'nemotron-3-super-free', 'trinity-large-preview-free'],
      providerId: 'opencode-zen',
      source: 'provider',
    }
  }

  if (normalizedProviderId === 'openrouter-free' || normalizedProviderId === 'openrouter') {
    return {
      data: await getFreeModels(),
      providerId: 'openrouter-free',
      source: 'provider',
    }
  }

  return readProviderBackedModelIds(appServer)
}


function readNonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : ''
}

function readThreadArchiveFallbackName(threadReadResult: unknown): string {
  const record = asRecord(threadReadResult)
  const thread = asRecord(record?.thread)
  return (
    readNonEmptyString(thread?.name)
    || readNonEmptyString(thread?.title)
    || readNonEmptyString(thread?.preview)
    || 'Untitled thread'
  )
}

function isArchivedThreadReadResult(threadReadResult: unknown): boolean {
  const record = asRecord(threadReadResult)
  const thread = asRecord(record?.thread)
  const sessionPath = readNonEmptyString(thread?.path)
  return sessionPath.split(/[\\/]+/u).includes('archived_sessions')
}

export async function callRpcWithArchiveRecovery(
  appServer: RpcExecutor,
  method: string,
  params: unknown,
): Promise<unknown> {
  try {
    const result = await callRpcWithRateLimitDecodeRecovery(appServer, method, params)
    return method === 'thread/list'
      ? await canonicalizeThreadListResponseForRead(result)
      : result
  } catch (error) {
    const paramsRecord = asRecord(params)
    const threadId = readNonEmptyString(paramsRecord?.threadId)

    if (method === 'turn/start' && threadId && isThreadNotFoundError(error)) {
      await appServer.rpc('thread/resume', { threadId })
      return appServer.rpc(method, params ?? null)
    }

    if (method !== 'thread/archive') {
      throw error
    }

    const errorMessage = getErrorMessage(error, '')
    if (!threadId || !errorMessage.includes('no rollout found')) {
      throw error
    }

    let threadReadResult: unknown = null
    try {
      threadReadResult = await appServer.rpc('thread/read', {
        threadId,
        includeTurns: false,
      })
      if (isArchivedThreadReadResult(threadReadResult)) {
        return null
      }
    } catch {
      // If metadata cannot be read, still try materializing a title before retrying archive.
    }

    await appServer.rpc('thread/name/set', {
      threadId,
      name: readThreadArchiveFallbackName(threadReadResult),
    })
    return appServer.rpc(method, params ?? null)
  }
}

type TerminalQuickCommand = {
  label: string
  value: string
  source: 'package' | 'script' | 'make'
}

async function listTerminalQuickCommands(cwd: string): Promise<TerminalQuickCommand[]> {
  const normalizedCwd = isAbsolute(cwd) ? cwd : resolve(cwd)
  const info = await stat(normalizedCwd)
  if (!info.isDirectory()) {
    throw new Error('Terminal cwd is not a directory')
  }

  const commands: TerminalQuickCommand[] = []
  const seen = new Set<string>()
  const addCommand = (command: TerminalQuickCommand) => {
    if (!command.value || seen.has(command.value)) return
    seen.add(command.value)
    commands.push(command)
  }

  await addPackageJsonCommands(normalizedCwd, addCommand)
  await addMakefileCommands(normalizedCwd, addCommand)
  await addRootScriptCommands(normalizedCwd, addCommand)
  await addScriptsDirectoryCommands(normalizedCwd, addCommand)
  return commands
}

async function addPackageJsonCommands(
  cwd: string,
  addCommand: (command: TerminalQuickCommand) => void,
): Promise<void> {
  try {
    const raw = await readFile(join(cwd, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    const record = asRecord(parsed)
    const scripts = asRecord(record?.scripts)
    if (!scripts) return
    const packageManager = resolvePackageManager(cwd)
    for (const scriptName of Object.keys(scripts)) {
      if (typeof scripts[scriptName] !== 'string') continue
      const value = formatPackageScriptCommand(packageManager, scriptName)
      addCommand({
        label: value,
        value,
        source: 'package',
      })
    }
  } catch {
    // A project without package.json simply has no package quick commands.
  }
}

async function addMakefileCommands(
  cwd: string,
  addCommand: (command: TerminalQuickCommand) => void,
): Promise<void> {
  const makefilePath = existsSync(join(cwd, 'Makefile'))
    ? join(cwd, 'Makefile')
    : existsSync(join(cwd, 'makefile'))
      ? join(cwd, 'makefile')
      : ''
  if (!makefilePath) return

  try {
    const raw = await readFile(makefilePath, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const match = /^([A-Za-z0-9_.@%/+~-][A-Za-z0-9_.@%/+~-]*)\s*:(?![=])/.exec(line)
      if (!match) continue
      const target = match[1]
      if (!target || target.startsWith('.')) continue
      const value = `make ${quoteShellTokenIfNeeded(target)}`
      addCommand({
        label: value,
        value,
        source: 'make',
      })
    }
  } catch {
    // Ignore unreadable Makefiles for quick-command discovery.
  }
}

async function addRootScriptCommands(
  cwd: string,
  addCommand: (command: TerminalQuickCommand) => void,
): Promise<void> {
  await addScriptFileCommands(cwd, '.', addCommand)
}

async function addScriptsDirectoryCommands(
  cwd: string,
  addCommand: (command: TerminalQuickCommand) => void,
): Promise<void> {
  await addScriptFileCommands(join(cwd, 'scripts'), './scripts', addCommand)
}

async function addScriptFileCommands(
  directory: string,
  commandPrefix: string,
  addCommand: (command: TerminalQuickCommand) => void,
): Promise<void> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!entry.name.endsWith('.sh') && !entry.name.endsWith('.cmd')) continue
      const value = `${commandPrefix}/${quoteShellTokenIfNeeded(entry.name)}`
      addCommand({
        label: value,
        value,
        source: 'script',
      })
    }
  } catch {
    // A project without script files simply has no script-file quick commands.
  }
}

function resolvePackageManager(cwd: string): 'npm' | 'pnpm' | 'yarn' | 'bun' {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb'))) return 'bun'
  return 'npm'
}

function formatPackageScriptCommand(packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun', scriptName: string): string {
  const quoted = quoteShellTokenIfNeeded(scriptName)
  if (packageManager === 'npm') return `npm run ${quoted}`
  if (packageManager === 'pnpm') return `pnpm run ${quoted}`
  if (packageManager === 'bun') return `bun run ${quoted}`
  return `yarn ${quoted}`
}

function quoteShellTokenIfNeeded(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

function readBoolean(value: unknown): boolean {
  return value === true
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function countRecoveredContentLines(value: string): number {
  if (!value) return 0
  const normalized = value.replace(/\r\n/g, '\n')
  const trimmed = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized
  if (!trimmed) return 0
  return trimmed.split('\n').length
}

function countRecoveredPatchLines(value: string): { addedLineCount: number; removedLineCount: number } {
  let addedLineCount = 0
  let removedLineCount = 0

  for (const line of value.replace(/\r\n/g, '\n').split('\n')) {
    if (!line) continue
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue
    if (line.startsWith('+')) {
      addedLineCount += 1
      continue
    }
    if (line.startsWith('-')) {
      removedLineCount += 1
    }
  }

  return { addedLineCount, removedLineCount }
}

function mergeRecoveredDiff(first: string, second: string): string {
  if (!first) return second
  if (!second || first === second) return first
  return `${first}\n${second}`.trim()
}

function mergeRecoveredFileChange(first: SessionRecoveredFileChange, second: SessionRecoveredFileChange): SessionRecoveredFileChange {
  const operation = first.operation === 'add' || second.operation === 'add'
    ? 'add'
    : first.operation === 'delete' || second.operation === 'delete'
      ? 'delete'
      : 'update'

  return {
    path: second.path || first.path,
    operation,
    movedToPath: second.movedToPath ?? first.movedToPath ?? null,
    diff: mergeRecoveredDiff(first.diff, second.diff),
    addedLineCount: first.addedLineCount + second.addedLineCount,
    removedLineCount: first.removedLineCount + second.removedLineCount,
  }
}

function isApplyPatchSectionBoundary(value: string): boolean {
  return value.startsWith('*** Update File: ')
    || value.startsWith('*** Add File: ')
    || value.startsWith('*** Delete File: ')
    || value === '*** End Patch'
}

function parseApplyPatchInput(input: string): SessionRecoveredFileChange[] {
  const normalized = input.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const changes: SessionRecoveredFileChange[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''

    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim()
      const contentLines: string[] = []
      for (index += 1; index < lines.length; index += 1) {
        const nextLine = lines[index] ?? ''
        if (isApplyPatchSectionBoundary(nextLine)) {
          index -= 1
          break
        }
        contentLines.push(nextLine.startsWith('+') ? nextLine.slice(1) : nextLine)
      }
      const diff = contentLines.join('\n').trimEnd()
      if (path) {
        changes.push({
          path,
          operation: 'add',
          movedToPath: null,
          diff,
          addedLineCount: countRecoveredContentLines(diff),
          removedLineCount: 0,
        })
      }
      continue
    }

    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim()
      if (path) {
        changes.push({
          path,
          operation: 'delete',
          movedToPath: null,
          diff: '',
          addedLineCount: 0,
          removedLineCount: 0,
        })
      }
      continue
    }

    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim()
      let movedToPath: string | null = null
      const diffLines: string[] = []

      for (index += 1; index < lines.length; index += 1) {
        const nextLine = lines[index] ?? ''
        if (nextLine.startsWith('*** Move to: ')) {
          const moved = nextLine.slice('*** Move to: '.length).trim()
          movedToPath = moved || null
          continue
        }
        if (isApplyPatchSectionBoundary(nextLine)) {
          index -= 1
          break
        }
        diffLines.push(nextLine)
      }

      const diff = diffLines.join('\n').trimEnd()
      const counts = countRecoveredPatchLines(diff)
      if (path) {
        changes.push({
          path,
          operation: 'update',
          movedToPath,
          diff,
          ...counts,
        })
      }
    }
  }

  return changes
}

function buildSessionFileChangeFallback(threadReadPayload: unknown, sessionLogRaw: string): SessionRecoveredTurnFileChanges[] {
  const payload = asRecord(threadReadPayload)
  const thread = asRecord(payload?.thread)
  const turns = Array.isArray(thread?.turns) ? thread.turns : []
  const turnIndexById = new Map<string, number>()

  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turnRecord = asRecord(turns[turnIndex])
    const turnId = readNonEmptyString(turnRecord?.id)
    if (turnId) {
      turnIndexById.set(turnId, turnIndex)
    }
  }

  const collectedByTurnId = new Map<string, SessionRecoveredFileChange[]>()
  let currentTurnId = ''

  for (const line of sessionLogRaw.split('\n')) {
    if (!line.trim()) continue
    let row: Record<string, unknown> | null = null
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }

    if (row.type === 'turn_context') {
      const payloadRecord = asRecord(row.payload)
      currentTurnId = readNonEmptyString(payloadRecord?.turn_id) || currentTurnId
      continue
    }

    if (row.type !== 'response_item' || !currentTurnId || !turnIndexById.has(currentTurnId)) {
      continue
    }

    const payloadRecord = asRecord(row.payload)
    if (
      payloadRecord?.type !== 'custom_tool_call'
      || payloadRecord.name !== 'apply_patch'
      || payloadRecord.status !== 'completed'
    ) {
      continue
    }

    const input = readNonEmptyString(payloadRecord.input)
    if (!input) continue

    const parsedChanges = parseApplyPatchInput(input)
    if (parsedChanges.length === 0) continue

    const previous = collectedByTurnId.get(currentTurnId) ?? []
    previous.push(...parsedChanges)
    collectedByTurnId.set(currentTurnId, previous)
  }

  const recovered: SessionRecoveredTurnFileChanges[] = []
  for (const [turnId, fileChanges] of collectedByTurnId.entries()) {
    const turnIndex = turnIndexById.get(turnId)
    if (typeof turnIndex !== 'number' || fileChanges.length === 0) continue

    const mergedByPath = new Map<string, SessionRecoveredFileChange>()
    for (const fileChange of fileChanges) {
      const key = `${fileChange.path}\u0000${fileChange.movedToPath ?? ''}`
      const previous = mergedByPath.get(key)
      mergedByPath.set(key, previous ? mergeRecoveredFileChange(previous, fileChange) : { ...fileChange })
    }

    recovered.push({
      turnId,
      turnIndex,
      fileChanges: Array.from(mergedByPath.values()),
    })
  }

  return recovered.sort((first, second) => first.turnIndex - second.turnIndex)
}

type SessionRecoveredCommand = {
  id: string
  type: 'commandExecution'
  command: string
  cwd: string | null
  status: 'completed' | 'failed'
  aggregatedOutput: string
  exitCode: number | null
  durationMs: number | null
}

function parseExecCommandOutput(output: string): { exitCode: number | null; wallTime: number | null; cleanOutput: string } {
  let exitCode: number | null = null
  let wallTime: number | null = null
  const outputLines: string[] = []
  let pastHeader = false

  for (const line of output.split('\n')) {
    if (!pastHeader) {
      const exitMatch = line.match(/^Process exited with code (\d+)/)
      if (exitMatch) {
        exitCode = Number.parseInt(exitMatch[1]!, 10)
        continue
      }
      const wallMatch = line.match(/^Wall time:\s+([\d.]+)\s+seconds/)
      if (wallMatch) {
        wallTime = Math.round(Number.parseFloat(wallMatch[1]!) * 1000)
        continue
      }
      if (line.startsWith('Command:') || line.startsWith('Chunk ID:') || line.startsWith('Original token count:')) {
        continue
      }
      if (line === 'Output:') {
        pastHeader = true
        continue
      }
    }
    outputLines.push(line)
  }

  return { exitCode, wallTime, cleanOutput: outputLines.join('\n').trimEnd() }
}

type SessionRecoveredFileChangeItem = {
  id: string
  type: 'fileChange'
  status: 'completed'
  changes: Record<string, unknown>[]
}

type SessionItemSlot = {
  type: 'agentMessage' | 'commandExecution' | 'fileChange'
  command?: SessionRecoveredCommand
  fileChange?: SessionRecoveredFileChangeItem
}

function buildSessionItemOrder(sessionLogRaw: string, turnIds: Set<string>): Map<string, SessionItemSlot[]> {
  let currentTurnId = ''
  const orderByTurnId = new Map<string, SessionItemSlot[]>()
  const callIdToCommand = new Map<string, SessionRecoveredCommand>()

  for (const line of sessionLogRaw.split('\n')) {
    if (!line.trim()) continue
    let row: Record<string, unknown> | null = null
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }

    if (row.type === 'turn_context') {
      const p = asRecord(row.payload)
      currentTurnId = readNonEmptyString(p?.turn_id) || currentTurnId
      continue
    }
    if (row.type === 'event_msg') {
      const p = asRecord(row.payload)
      if (p?.type === 'task_started') {
        currentTurnId = readNonEmptyString(p.turn_id) || currentTurnId
      }
      continue
    }

    if (row.type !== 'response_item' || !currentTurnId || !turnIds.has(currentTurnId)) continue
    const payload = asRecord(row.payload)
    if (!payload) continue

    let slots = orderByTurnId.get(currentTurnId)
    if (!slots) {
      slots = []
      orderByTurnId.set(currentTurnId, slots)
    }

    if (payload.type === 'message' && payload.role === 'assistant') {
      slots.push({ type: 'agentMessage' })
      continue
    }

    if (payload.type === 'function_call' && payload.name === 'exec_command') {
      const callId = readNonEmptyString(payload.call_id)
      if (!callId) continue
      let cmd = ''
      try {
        const args = JSON.parse(payload.arguments as string) as Record<string, unknown>
        cmd = typeof args.cmd === 'string' ? args.cmd : ''
      } catch { /* empty */ }
      const command: SessionRecoveredCommand = {
        id: `session-cmd-${callId}`,
        type: 'commandExecution',
        command: cmd,
        cwd: null,
        status: 'completed',
        aggregatedOutput: '',
        exitCode: null,
        durationMs: null,
      }
      callIdToCommand.set(callId, command)
      slots.push({ type: 'commandExecution', command })
      continue
    }

    if (payload.type === 'function_call_output') {
      const callId = readNonEmptyString(payload.call_id)
      if (!callId) continue
      const existing = callIdToCommand.get(callId)
      if (!existing) continue
      const rawOutput = typeof payload.output === 'string' ? payload.output : ''
      const parsed = parseExecCommandOutput(rawOutput)
      existing.aggregatedOutput = parsed.cleanOutput
      existing.exitCode = parsed.exitCode
      existing.durationMs = parsed.wallTime
      existing.status = parsed.exitCode === 0 || parsed.exitCode === null ? 'completed' : 'failed'
    }

    if (payload.type === 'custom_tool_call' && payload.name === 'apply_patch' && payload.status === 'completed') {
      const input = typeof payload.input === 'string' ? payload.input : ''
      const callId = readNonEmptyString(payload.call_id)
      if (!input || !callId) continue
      const parsedChanges = parseApplyPatchInput(input)
      if (parsedChanges.length === 0) continue
      const fcItem: SessionRecoveredFileChangeItem = {
        id: `session-fc-${callId}`,
        type: 'fileChange',
        status: 'completed',
        changes: parsedChanges.map((fc) => ({
          ...fc,
          kind: { type: fc.operation, ...(fc.movedToPath ? { move_path: fc.movedToPath } : {}) },
        })),
      }
      slots.push({ type: 'fileChange', fileChange: fcItem })
    }
  }

  return orderByTurnId
}

function extractFilePathsFromCommand(cmd: string, cwd: string): string[] {
  const paths: string[] = []
  const absPathPattern = /(?:^|\s|>>|>|<)(\/?(?:Users|home|tmp|var|etc|root)\/[^\s;|&><"']+)/g
  let match: RegExpExecArray | null
  while ((match = absPathPattern.exec(cmd)) !== null) {
    const p = match[1]?.trim()
    if (p && !p.endsWith('/') && !p.startsWith('-')) paths.push(p)
  }

  const redirectPattern = /(?:>>?|cat\s*>\s*)([^\s;|&><"']+)/g
  while ((match = redirectPattern.exec(cmd)) !== null) {
    const p = match[1]?.trim()
    if (p && !p.startsWith('-') && !p.startsWith('/dev/')) {
      paths.push(isAbsolute(p) ? p : join(cwd, p))
    }
  }

  return [...new Set(paths)]
}

type CollectedTurnFileInfo = {
  patchInputs: { callId: string; input: string }[]
  commandFilePaths: string[]
}

function collectFileChangesForTurns(
  sessionLogRaw: string,
  turnIdsToRevert: Set<string>,
  cwd: string,
): Map<string, CollectedTurnFileInfo> {
  let currentTurnId = ''
  const infoByTurnId = new Map<string, CollectedTurnFileInfo>()

  for (const line of sessionLogRaw.split('\n')) {
    if (!line.trim()) continue
    let row: Record<string, unknown> | null = null
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }

    if (row.type === 'turn_context') {
      const p = asRecord(row.payload)
      currentTurnId = readNonEmptyString(p?.turn_id) || currentTurnId
      continue
    }
    if (row.type === 'event_msg') {
      const p = asRecord(row.payload)
      if (p?.type === 'task_started') {
        currentTurnId = readNonEmptyString(p.turn_id) || currentTurnId
      }
      continue
    }

    if (row.type !== 'response_item' || !currentTurnId || !turnIdsToRevert.has(currentTurnId)) continue
    const payload = asRecord(row.payload)
    if (!payload) continue

    let info = infoByTurnId.get(currentTurnId)
    if (!info) {
      info = { patchInputs: [], commandFilePaths: [] }
      infoByTurnId.set(currentTurnId, info)
    }

    if (payload.type === 'custom_tool_call' && payload.name === 'apply_patch' && payload.status === 'completed') {
      const input = typeof payload.input === 'string' ? payload.input : ''
      const callId = readNonEmptyString(payload.call_id)
      if (input && callId) {
        info.patchInputs.push({ callId, input })
      }
    }

    if (payload.type === 'function_call' && payload.name === 'exec_command') {
      let cmd = ''
      try {
        const args = JSON.parse(payload.arguments as string) as Record<string, unknown>
        cmd = typeof args.cmd === 'string' ? args.cmd : ''
      } catch { /* empty */ }
      if (cmd) {
        const extracted = extractFilePathsFromCommand(cmd, cwd)
        for (const p of extracted) {
          if (!info.commandFilePaths.includes(p)) info.commandFilePaths.push(p)
        }
      }
    }
  }

  return infoByTurnId
}

function reverseV4aDiff(fileContent: string, diffText: string): string | null {
  const fileLines = fileContent.split('\n')
  const rawDiffLines = diffText.split('\n')
  while (rawDiffLines.length > 0 && rawDiffLines[rawDiffLines.length - 1]?.trim() === '') rawDiffLines.pop()
  const diffLines = rawDiffLines
  const result = [...fileLines]

  type DiffEntry = { type: 'context' | 'add' | 'remove'; text: string }
  const hunks: DiffEntry[][] = []
  let currentHunk: DiffEntry[] | null = null

  for (const dl of diffLines) {
    if (dl.startsWith('@@')) {
      if (currentHunk) hunks.push(currentHunk)
      currentHunk = []
      continue
    }
    if (!currentHunk) continue
    if (dl.startsWith('+')) {
      currentHunk.push({ type: 'add', text: dl.slice(1) })
    } else if (dl.startsWith('-')) {
      currentHunk.push({ type: 'remove', text: dl.slice(1) })
    } else if (dl.startsWith(' ')) {
      currentHunk.push({ type: 'context', text: dl.slice(1) })
    } else {
      currentHunk.push({ type: 'context', text: dl })
    }
  }
  if (currentHunk) hunks.push(currentHunk)

  for (let hi = hunks.length - 1; hi >= 0; hi--) {
    const hunk = hunks[hi]!
    const expectedSequence = hunk
      .filter((e) => e.type === 'context' || e.type === 'add')
      .map((e) => e.text)

    if (expectedSequence.length === 0) continue

    let seqStart = -1
    outer: for (let ri = result.length - expectedSequence.length; ri >= 0; ri--) {
      for (let si = 0; si < expectedSequence.length; si++) {
        if (result[ri + si] !== expectedSequence[si]) continue outer
      }
      seqStart = ri
      break
    }

    if (seqStart < 0) return null

    const newLines: string[] = []
    let seqIdx = 0
    for (const entry of hunk) {
      if (entry.type === 'context') {
        newLines.push(result[seqStart + seqIdx]!)
        seqIdx++
      } else if (entry.type === 'add') {
        seqIdx++
      } else if (entry.type === 'remove') {
        newLines.push(entry.text)
      }
    }

    result.splice(seqStart, expectedSequence.length, ...newLines)
  }

  return result.join('\n')
}

function applyV4aDiff(fileContent: string, diffText: string): string | null {
  const fileLines = fileContent === '' ? [] : fileContent.split('\n')
  const rawDiffLines = diffText.split('\n')
  while (rawDiffLines.length > 0 && rawDiffLines[rawDiffLines.length - 1]?.trim() === '') rawDiffLines.pop()
  const result = [...fileLines]

  type DiffEntry = { type: 'context' | 'add' | 'remove'; text: string }
  type DiffHunk = { oldStart: number; entries: DiffEntry[] }
  const hunks: DiffHunk[] = []
  let currentHunk: DiffHunk | null = null

  for (const dl of rawDiffLines) {
    const hunkMatch = dl.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/u)
    if (hunkMatch) {
      if (currentHunk) hunks.push(currentHunk)
      currentHunk = { oldStart: Math.max(Number(hunkMatch[1] ?? '1') - 1, 0), entries: [] }
      continue
    }
    if (!currentHunk) continue
    if (dl.startsWith('+')) {
      currentHunk.entries.push({ type: 'add', text: dl.slice(1) })
    } else if (dl.startsWith('-')) {
      currentHunk.entries.push({ type: 'remove', text: dl.slice(1) })
    } else if (dl.startsWith(' ')) {
      currentHunk.entries.push({ type: 'context', text: dl.slice(1) })
    } else {
      currentHunk.entries.push({ type: 'context', text: dl })
    }
  }
  if (currentHunk) hunks.push(currentHunk)

  for (const hunk of hunks) {
    const expectedSequence = hunk.entries
      .filter((e) => e.type === 'context' || e.type === 'remove')
      .map((e) => e.text)

    let seqStart = -1
    if (expectedSequence.length === 0) {
      seqStart = Math.min(hunk.oldStart, result.length)
    } else {
      const maxStart = result.length - expectedSequence.length
      if (maxStart < 0) return null
      const preferredStart = Math.min(hunk.oldStart, Math.max(maxStart, 0))
      const candidateStarts = [
        ...Array.from({ length: maxStart + 1 }, (_, index) => preferredStart + index).filter((value) => value <= maxStart),
        ...Array.from({ length: preferredStart }, (_, index) => preferredStart - index - 1),
      ]
      outer: for (const ri of candidateStarts) {
        for (let si = 0; si < expectedSequence.length; si++) {
          if (result[ri + si] !== expectedSequence[si]) continue outer
        }
        seqStart = ri
        break
      }
    }

    if (seqStart < 0) return null

    const newLines: string[] = []
    let seqIdx = 0
    for (const entry of hunk.entries) {
      if (entry.type === 'context') {
        newLines.push(result[seqStart + seqIdx]!)
        seqIdx++
      } else if (entry.type === 'remove') {
        seqIdx++
      } else if (entry.type === 'add') {
        newLines.push(entry.text)
      }
    }

    result.splice(seqStart, expectedSequence.length, ...newLines)
  }

  return result.join('\n')
}

async function applyTurnFileChanges(
  cwd: string,
  turnInfos: Map<string, CollectedTurnFileInfo>,
  allowedPatchIds?: Set<string>,
): Promise<{ applied: number; errors: string[]; appliedPatchIds: string[] }> {
  if (turnInfos.size === 0) return { applied: 0, errors: [], appliedPatchIds: [] }

  let applied = 0
  const errors: string[] = []
  const appliedPatchIds: string[] = []
  const allPatchInputs = [...turnInfos.values()]
    .flatMap((info) => info.patchInputs)
    .filter((patch) => !allowedPatchIds || allowedPatchIds.has(patch.callId))

  for (const patch of allPatchInputs) {
    let patchApplied = false
    let patchHadError = false
    const changes = parseApplyPatchInput(patch.input)
    for (const change of changes) {
      const filePath = isAbsolute(change.path) ? change.path : join(cwd, change.path)
      const movedToPath = change.movedToPath
        ? (isAbsolute(change.movedToPath) ? change.movedToPath : join(cwd, change.movedToPath))
        : null

      try {
        if (change.operation === 'add') {
          await mkdir(dirname(filePath), { recursive: true })
          await writeFile(filePath, change.diff ? `${change.diff}\n` : '', 'utf8')
          applied++
          patchApplied = true
          continue
        }

        if (change.operation === 'delete') {
          await rm(filePath, { force: true })
          applied++
          patchApplied = true
          continue
        }

        let sourcePath = filePath
        if (movedToPath) {
          const sourceStat = await stat(sourcePath).catch(() => null)
          if (!sourceStat) {
            const movedStat = await stat(movedToPath).catch(() => null)
            if (movedStat) sourcePath = movedToPath
          }
        }

        const currentContent = await readFile(sourcePath, 'utf8')
        const newContent = applyV4aDiff(currentContent, change.diff)
        if (newContent === null) {
          patchHadError = true
          errors.push(`Could not apply patch for ${sourcePath}`)
          continue
        }

        if (movedToPath) {
          if (sourcePath === movedToPath) {
            if (newContent !== currentContent) {
              await writeFile(movedToPath, newContent, 'utf8')
            }
          } else {
            await mkdir(dirname(movedToPath), { recursive: true })
            await writeFile(movedToPath, newContent, 'utf8')
            await rm(filePath, { force: true })
          }
        } else if (newContent !== currentContent) {
          await writeFile(filePath, newContent, 'utf8')
        }
        applied++
        patchApplied = true
      } catch (err) {
        patchHadError = true
        errors.push(`Failed to apply patch for ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (patchApplied && !patchHadError) appliedPatchIds.push(patch.callId)
  }

  return { applied, errors, appliedPatchIds }
}

async function revertTurnFileChanges(
  cwd: string,
  turnInfos: Map<string, CollectedTurnFileInfo>,
  allowedPatchIds?: Set<string>,
): Promise<{ reverted: number; errors: string[]; revertedPatchIds: string[] }> {
  if (turnInfos.size === 0) return { reverted: 0, errors: [], revertedPatchIds: [] }

  let reverted = 0
  const errors: string[] = []
  const revertedPatchIds: string[] = []

  const allEntries = [...turnInfos.values()]
  const allPatchInputs = allEntries
    .flatMap((info) => info.patchInputs)
    .filter((patch) => !allowedPatchIds || allowedPatchIds.has(patch.callId))
    .reverse()
  const allCommandPaths = new Set(allEntries.flatMap((info) => info.commandFilePaths))

  let isGitRepo = false
  let gitRoot = ''
  try {
    gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd })
    isGitRepo = !!gitRoot
  } catch { /* not a git repo */ }

  const trackedFiles = new Set<string>()
  if (isGitRepo) {
    try {
      const tracked = await runCommandCapture('git', ['ls-files', '--full-name'], { cwd: gitRoot })
      for (const f of tracked.split('\n')) {
        if (f.trim()) trackedFiles.add(join(gitRoot, f.trim()))
      }
    } catch { /* empty */ }
  }

  const patchRevertedPaths = new Set<string>()

  for (const patch of allPatchInputs) {
    let patchReverted = false
    let patchHadError = false
    const changes = parseApplyPatchInput(patch.input)
    for (let ci = changes.length - 1; ci >= 0; ci--) {
      const change = changes[ci]!
      const filePath = isAbsolute(change.path) ? change.path : join(cwd, change.path)
      const movedToPath = change.movedToPath
        ? (isAbsolute(change.movedToPath) ? change.movedToPath : join(cwd, change.movedToPath))
        : null

      try {
        if (change.operation === 'add') {
          const fileStat = await stat(filePath).catch(() => null)
          if (fileStat) {
            await rm(filePath, { force: true })
            reverted++
            patchRevertedPaths.add(filePath)
            patchReverted = true
          }
        } else if (change.operation === 'update' && (change.diff || movedToPath)) {
          let reversed = false
          try {
            const sourcePath = movedToPath ?? filePath
            const currentContent = await readFile(sourcePath, 'utf8')
            const newContent = reverseV4aDiff(currentContent, change.diff)
            if (newContent !== null && newContent !== currentContent) {
              const { writeFile } = await import('node:fs/promises')
              if (movedToPath) {
                await mkdir(dirname(filePath), { recursive: true })
                await writeFile(filePath, newContent)
                await rm(movedToPath, { force: true })
              } else {
                await writeFile(filePath, newContent)
              }
              reverted++
              patchRevertedPaths.add(filePath)
              if (movedToPath) patchRevertedPaths.add(movedToPath)
              patchReverted = true
              reversed = true
            } else if (newContent !== null && movedToPath) {
              await mkdir(dirname(filePath), { recursive: true })
              await rename(movedToPath, filePath)
              reverted++
              patchRevertedPaths.add(filePath)
              patchRevertedPaths.add(movedToPath)
              patchReverted = true
              reversed = true
            }
          } catch { /* file read/write failed */ }

          if (!reversed) {
            const isTracked = trackedFiles.has(filePath)
            if (isTracked && isGitRepo) {
              const relativePath = filePath.startsWith(gitRoot + '/') ? filePath.slice(gitRoot.length + 1) : filePath
              try {
                await runCommand('git', ['checkout', 'HEAD', '--', relativePath], { cwd: gitRoot })
                if (movedToPath) {
                  await rm(movedToPath, { force: true })
                }
                reverted++
                patchRevertedPaths.add(filePath)
                if (movedToPath) patchRevertedPaths.add(movedToPath)
                patchReverted = true
              } catch {
                patchHadError = true
                errors.push(`Could not revert: ${filePath}`)
              }
            } else {
              patchHadError = true
              errors.push(`Could not reverse patch for untracked file: ${filePath}`)
            }
          }
        } else if (change.operation === 'delete') {
          const isTracked = trackedFiles.has(filePath)
          if (isTracked && isGitRepo) {
            const relativePath = filePath.startsWith(gitRoot + '/') ? filePath.slice(gitRoot.length + 1) : filePath
            try {
              await runCommand('git', ['checkout', 'HEAD', '--', relativePath], { cwd: gitRoot })
              reverted++
              patchRevertedPaths.add(filePath)
              patchReverted = true
            } catch {
              patchHadError = true
              errors.push(`Could not restore deleted file: ${filePath}`)
            }
          }
        }
      } catch (err) {
        patchHadError = true
        errors.push(`Failed to revert patch for ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (patchReverted) revertedPatchIds.push(patch.callId)
  }

  for (const filePath of allCommandPaths) {
    if (patchRevertedPaths.has(filePath)) continue
    const isTracked = trackedFiles.has(filePath)
    if (isTracked && isGitRepo) {
      const relativePath = filePath.startsWith(gitRoot + '/') ? filePath.slice(gitRoot.length + 1) : filePath
      try {
        await runCommand('git', ['checkout', 'HEAD', '--', relativePath], { cwd: gitRoot })
        reverted++
      } catch {
        errors.push(`Could not restore command-modified file: ${filePath}`)
      }
    }
  }

  return { reverted, errors, revertedPatchIds }
}

function mergeSessionCommandsIntoTurns(turns: unknown[], sessionLogRaw: string): unknown[] {
  const turnIds = new Set<string>()
  for (const turn of turns) {
    const turnRecord = asRecord(turn)
    const turnId = readNonEmptyString(turnRecord?.id)
    if (turnId) turnIds.add(turnId)
  }

  if (turnIds.size === 0) return turns

  const orderByTurnId = buildSessionItemOrder(sessionLogRaw, turnIds)
  if (orderByTurnId.size === 0) return turns

  return turns.map((turn) => {
    const turnRecord = asRecord(turn)
    if (!turnRecord) return turn
    const turnId = readNonEmptyString(turnRecord.id)
    if (!turnId) return turn

    const slots = orderByTurnId.get(turnId)
    if (!slots || slots.length === 0) return turn

    const existingItems = Array.isArray(turnRecord.items) ? (turnRecord.items as Record<string, unknown>[]) : []
    const alreadyHasRecoveredItems = existingItems.some((it) => it.type === 'commandExecution' || it.type === 'fileChange')
    if (alreadyHasRecoveredItems) return turn

    const agentMessages = existingItems.filter((it) => it.type === 'agentMessage')
    const nonAgentNonUserItems = existingItems.filter((it) => it.type !== 'agentMessage' && it.type !== 'userMessage')
    const userMessages = existingItems.filter((it) => it.type === 'userMessage')

    let agentIdx = 0
    const interleaved: Record<string, unknown>[] = [...userMessages]

    for (const slot of slots) {
      if (slot.type === 'agentMessage') {
        if (agentIdx < agentMessages.length) {
          interleaved.push(agentMessages[agentIdx]!)
          agentIdx++
        }
      } else if (slot.type === 'commandExecution' && slot.command) {
        interleaved.push(slot.command as unknown as Record<string, unknown>)
      } else if (slot.type === 'fileChange' && slot.fileChange) {
        interleaved.push(slot.fileChange as unknown as Record<string, unknown>)
      }
    }

    while (agentIdx < agentMessages.length) {
      interleaved.push(agentMessages[agentIdx]!)
      agentIdx++
    }

    interleaved.push(...nonAgentNonUserItems)

    return {
      ...turnRecord,
      items: interleaved,
    }
  })
}

function scoreFileCandidate(path: string, query: string): number {
  if (!query) return 0
  const lowerPath = path.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const baseName = lowerPath.slice(lowerPath.lastIndexOf('/') + 1)
  if (baseName === lowerQuery) return 0
  if (baseName.startsWith(lowerQuery)) return 1
  if (baseName.includes(lowerQuery)) return 2
  if (lowerPath.includes(`/${lowerQuery}`)) return 3
  if (lowerPath.includes(lowerQuery)) return 4
  return 10
}

async function listFilesWithRipgrep(cwd: string): Promise<string[]> {
  return await new Promise<string[]>((resolve, reject) => {
    const ripgrepCommand = resolveRipgrepCommand()
    if (!ripgrepCommand) {
      reject(new Error('ripgrep (rg) is not available'))
      return
    }

    const proc = spawn(ripgrepCommand, ['--files', '--hidden', '-g', '!.git', '-g', '!node_modules'], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) {
        const rows = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
        resolve(rows)
        return
      }
      const details = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
      reject(new Error(details || 'rg --files failed'))
    })
  })
}

function getCodexHomeDir(): string {
  const codexHome = process.env.CODEX_HOME?.trim()
  return codexHome && codexHome.length > 0 ? codexHome : join(homedir(), '.codex')
}

function getSkillsInstallDir(): string {
  return join(getCodexHomeDir(), 'skills')
}

function getPromptsDir(): string {
  return join(getCodexHomeDir(), 'prompts')
}

type ComposerPromptRecord = {
  name: string
  path: string
  content: string
  description: string
}

function promptNameToFileName(name: string): string {
  const trimmed = name.trim()
  const withoutExtension = trimmed.replace(/\.md$/i, '')
  const sanitized = withoutExtension
    .replace(/[\/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return `${sanitized || 'prompt'}.md`
}

function buildPromptDescription(content: string): string {
  const firstNonEmptyLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? ''
  return firstNonEmptyLine.slice(0, 120)
}

async function listComposerPrompts(): Promise<ComposerPromptRecord[]> {
  const promptsDir = getPromptsDir()
  try {
    const entries = await readdir(promptsDir, { withFileTypes: true })
    const prompts = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map(async (entry) => {
        const promptPath = join(promptsDir, entry.name)
        const content = await readFile(promptPath, 'utf8')
        return {
          name: entry.name.replace(/\.md$/i, ''),
          path: promptPath,
          content,
          description: buildPromptDescription(content),
        } satisfies ComposerPromptRecord
      }))
    return prompts.sort((a, b) => a.name.localeCompare(b.name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw error
  }
}

async function createComposerPromptFile(name: string, content: string): Promise<ComposerPromptRecord> {
  const trimmedName = name.trim()
  if (!trimmedName) throw new Error('Prompt name is required')
  const trimmedContent = content.trim()
  if (!trimmedContent) throw new Error('Prompt content is required')
  const promptsDir = getPromptsDir()
  await mkdir(promptsDir, { recursive: true })

  const baseFileName = promptNameToFileName(trimmedName)
  let targetPath = join(promptsDir, baseFileName)
  let suffix = 2
  while (existsSync(targetPath)) {
    const nextFileName = `${baseFileName.replace(/\.md$/i, '')}-${suffix}.md`
    targetPath = join(promptsDir, nextFileName)
    suffix += 1
  }

  await writeFile(targetPath, `${trimmedContent}\n`, 'utf8')
  return {
    name: basename(targetPath).replace(/\.md$/i, ''),
    path: targetPath,
    content: `${trimmedContent}\n`,
    description: buildPromptDescription(trimmedContent),
  }
}

async function removeComposerPromptFile(promptPath: string): Promise<boolean> {
  const resolvedPath = resolve(promptPath)
  const promptsDir = resolve(getPromptsDir())
  const relative = resolvedPath.startsWith(`${promptsDir}/`) ? resolvedPath.slice(promptsDir.length + 1) : ''
  if (!relative || relative.includes('..') || !resolvedPath.toLowerCase().endsWith('.md')) {
    throw new Error('Invalid prompt path')
  }
  try {
    await rm(resolvedPath, { force: false })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false
    throw error
  }
}

async function runCommand(command: string, args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let closed = false
    const timeout =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? setTimeout(() => {
          timedOut = true
          proc.kill('SIGTERM')
          setTimeout(() => {
            if (!closed) proc.kill('SIGKILL')
          }, 5_000).unref()
        }, options.timeoutMs)
        : null
    timeout?.unref()
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('error', (error) => {
      if (timeout) clearTimeout(timeout)
      reject(error)
    })
    proc.on('close', (code) => {
      closed = true
      if (timeout) clearTimeout(timeout)
      if (timedOut) {
        reject(new Error(`Command timed out after ${options.timeoutMs}ms (${command} ${args.join(' ')})`))
        return
      }
      if (code === 0) {
        resolve()
        return
      }
      const details = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
      const suffix = details.length > 0 ? `: ${details}` : ''
      reject(new Error(`Command failed (${command} ${args.join(' ')})${suffix}`))
    })
  })
}

function isMissingHeadError(error: unknown): boolean {
  const message = getErrorMessage(error, '').toLowerCase()
  return (
    message.includes("not a valid object name: 'head'") ||
    message.includes('not a valid object name: head') ||
    message.includes('invalid reference: head')
  )
}

function isNotGitRepositoryError(error: unknown): boolean {
  const message = getErrorMessage(error, '').toLowerCase()
  return message.includes('not a git repository') || message.includes('fatal: not a git repository')
}

async function ensureRepoHasInitialCommit(repoRoot: string): Promise<void> {
  const agentsPath = join(repoRoot, 'AGENTS.md')
  try {
    await stat(agentsPath)
  } catch {
    await writeFile(agentsPath, '', 'utf8')
  }

  await runCommand('git', ['add', 'AGENTS.md'], { cwd: repoRoot })
  await runCommand(
    'git',
    ['-c', 'user.name=Codex', '-c', 'user.email=codex@local', 'commit', '-m', 'Initialize repository for worktree support'],
    { cwd: repoRoot },
  )
}

async function runCommandCapture(command: string, args: string[], options: { cwd?: string } = {}): Promise<string> {
  return (await runCommandCaptureRaw(command, args, options)).trim()
}

async function runCommandCaptureRaw(command: string, args: string[], options: { cwd?: string } = {}): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout)
        return
      }
      const details = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
      const suffix = details.length > 0 ? `: ${details}` : ''
      reject(new Error(`Command failed (${command} ${args.join(' ')})${suffix}`))
    })
  })
}

function normalizeBranchRefName(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('refs/heads/')) return trimmed.slice('refs/heads/'.length)
  if (trimmed.startsWith('refs/remotes/')) return trimmed.slice('refs/remotes/'.length)
  return trimmed
}

function toHeaderGitResetHistoryRef(branchName: string, commitSha: string): string {
  return `refs/codex/header-git-reset-history/${branchName}/${commitSha}`
}

const HEADER_GIT_RESET_HISTORY_REF_LIMIT = 25
const HEADER_GIT_UNTRACKED_BACKUP_DIR = '.codex/untracked-backups'

async function assertLocalGitBranch(repoRoot: string, branchName: string): Promise<void> {
  await runCommandCapture('git', ['show-ref', '--verify', `refs/heads/${branchName}`], { cwd: repoRoot })
}

function splitGitPathList(raw: string): string[] {
  return raw
    .split('\0')
    .filter((entry) => entry.length > 0)
}

function isSafeGitRelativePath(filePath: string): boolean {
  return Boolean(filePath) && !isAbsolute(filePath) && !filePath.split('/').includes('..')
}

function resolveGitRelativePath(repoRoot: string, filePath: string): string {
  return join(repoRoot, ...filePath.split('/'))
}

type PreservedUntrackedFile = {
  filePath: string
  sourcePath: string
  backupPath: string
}

function gitPathsConflict(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

async function removeEmptyGitRelativeParents(repoRoot: string, filePath: string): Promise<void> {
  let current = dirname(resolveGitRelativePath(repoRoot, filePath))
  while (current !== repoRoot && current.startsWith(`${repoRoot}/`)) {
    try {
      await rm(current, { recursive: false })
    } catch {
      return
    }
    current = dirname(current)
  }
}

async function rollbackPreservedUntrackedFiles(entries: PreservedUntrackedFile[]): Promise<void> {
  for (const entry of entries.slice().reverse()) {
    try {
      if (existsSync(entry.backupPath) && !existsSync(entry.sourcePath)) {
        await mkdir(dirname(entry.sourcePath), { recursive: true })
        await rename(entry.backupPath, entry.sourcePath)
      }
    } catch {
      // Preserve the original git failure; best-effort rollback avoids masking it.
    }
  }
}

async function preserveUntrackedFilesForGitTarget(repoRoot: string, targetRef: string): Promise<PreservedUntrackedFile[]> {
  const [untrackedRaw, targetTreeRaw] = await Promise.all([
    runCommandCaptureRaw('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: repoRoot }),
    runCommandCaptureRaw('git', ['ls-tree', '-r', '--name-only', '-z', `${targetRef}^{tree}`], { cwd: repoRoot }),
  ])
  const targetPaths = splitGitPathList(targetTreeRaw)
  const conflictingUntrackedPaths = splitGitPathList(untrackedRaw)
    .filter((filePath) => isSafeGitRelativePath(filePath) && targetPaths.some((targetPath) => gitPathsConflict(filePath, targetPath)))
  if (conflictingUntrackedPaths.length === 0) return []

  const backupRoot = join(repoRoot, HEADER_GIT_UNTRACKED_BACKUP_DIR, new Date().toISOString().replace(/[:.]/g, '-'))
  const movedFiles: PreservedUntrackedFile[] = []
  for (const filePath of conflictingUntrackedPaths) {
    const sourcePath = resolveGitRelativePath(repoRoot, filePath)
    const backupPath = join(backupRoot, ...filePath.split('/'))
    await mkdir(dirname(backupPath), { recursive: true })
    await rename(sourcePath, backupPath)
    movedFiles.push({ filePath, sourcePath, backupPath })
    await removeEmptyGitRelativeParents(repoRoot, filePath)
  }
  return movedFiles
}

async function withPreservedUntrackedFilesForGitTarget(repoRoot: string, targetRef: string, operation: () => Promise<void>): Promise<void> {
  const movedFiles = await preserveUntrackedFilesForGitTarget(repoRoot, targetRef)
  try {
    await operation()
  } catch (error) {
    await rollbackPreservedUntrackedFiles(movedFiles)
    throw error
  }
}

async function checkoutGitBranchWithWorktreeRecovery(repoRoot: string, branchName: string): Promise<void> {
  await withPreservedUntrackedFilesForGitTarget(repoRoot, branchName, async () => {
    try {
      await runCommand('git', ['checkout', branchName], { cwd: repoRoot })
    } catch (checkoutError) {
      const blockingWorktreePath = extractBranchLockedWorktreePath(checkoutError, branchName)
      if (!blockingWorktreePath) {
        throw checkoutError
      }
      await runCommand('git', ['checkout', '--detach'], { cwd: blockingWorktreePath })
      await runCommand('git', ['checkout', branchName], { cwd: repoRoot })
    }
  })
}

async function pruneHeaderGitResetHistoryRefs(repoRoot: string, branchName: string): Promise<void> {
  const resetHistoryRefPrefix = `refs/codex/header-git-reset-history/${branchName}/`
  const refsRaw = await runCommandCapture(
    'git',
    ['for-each-ref', '--sort=-creatordate', '--format=%(refname)', resetHistoryRefPrefix],
    { cwd: repoRoot },
  ).catch(() => '')
  const refs = refsRaw
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean)
  const staleRefs = refs.slice(HEADER_GIT_RESET_HISTORY_REF_LIMIT)
  for (const refName of staleRefs) {
    await runCommand('git', ['update-ref', '-d', refName], { cwd: repoRoot })
  }
}

async function readGitHeaderState(cwd: string): Promise<{
  currentBranch: string | null
  headSha: string | null
  headSubject: string | null
  headDate: string | null
  detached: boolean
  dirty: boolean
  gitRoot: string
}> {
  const gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd })
  const currentBranchRaw = await runCommandCapture('git', ['branch', '--show-current'], { cwd: gitRoot })
  const currentBranch = currentBranchRaw.trim() || null
  const headShaRaw = await runCommandCapture('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: gitRoot })
  const headCommitRaw = await runCommandCapture('git', ['show', '-s', '--date=short', '--format=%cd%x09%s', 'HEAD'], { cwd: gitRoot })
  const [headDate = '', ...headSubjectParts] = headCommitRaw.split('\t')
  const statusRaw = await runCommandCapture('git', ['status', '--porcelain'], { cwd: gitRoot })
  return {
    currentBranch,
    headSha: headShaRaw.trim() || null,
    headSubject: headSubjectParts.join('\t').trim() || null,
    headDate: headDate.trim() || null,
    detached: !currentBranch,
    dirty: statusRaw.trim().length > 0,
    gitRoot,
  }
}

async function assertNoTrackedGitChanges(repoRoot: string): Promise<void> {
  const statusRaw = await runCommandCapture('git', ['status', '--porcelain'], { cwd: repoRoot })
  const trackedChanges = statusRaw
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith('?? '))
  if (trackedChanges.length > 0) {
    throw new Error('切换分支或重置前，请先提交、Stash 或丢弃已跟踪的改动；未跟踪文件仅在会被覆盖时需处理。')
  }
}

function extractBranchLockedWorktreePath(error: unknown, branchName: string): string {
  const message = getErrorMessage(error, '')
  if (!message || !branchName) return ''
  const escapedBranch = branchName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const pattern = new RegExp(`'${escapedBranch}' is already checked out at '([^']+)'`, 'u')
  const match = pattern.exec(message)
  return match?.[1]?.trim() ?? ''
}

function toPermanentWorktreeBranchNameDraft(worktreeName: string): string {
  const sanitized = worktreeName
    .trim()
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/\.+/gu, '.')
    .replace(/-+/gu, '-')
    .replace(/^[.-]+|[.-]+$/gu, '')
  return sanitized || 'worktree'
}

async function isValidGitBranchName(gitRoot: string, branchName: string): Promise<boolean> {
  try {
    await runCommand('git', ['check-ref-format', '--branch', branchName], { cwd: gitRoot })
    return true
  } catch {
    return false
  }
}

async function doesLocalGitBranchExist(gitRoot: string, branchName: string): Promise<boolean> {
  try {
    await runCommand('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], { cwd: gitRoot })
    return true
  } catch {
    return false
  }
}

async function allocatePermanentWorktreeBranchName(gitRoot: string, worktreeName: string): Promise<string> {
  const base = toPermanentWorktreeBranchNameDraft(worktreeName)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`
    if (!await isValidGitBranchName(gitRoot, candidate)) continue
    if (!await doesLocalGitBranchExist(gitRoot, candidate)) return candidate
  }
  throw new Error('Failed to allocate a unique branch name for worktree')
}

async function runCommandWithOutput(command: string, args: string[], options: { cwd?: string } = {}): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim())
        return
      }
      const details = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
      const suffix = details.length > 0 ? `: ${details}` : ''
      reject(new Error(`Command failed (${command} ${args.join(' ')})${suffix}`))
    })
  })
}


function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const normalized: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0 && !normalized.includes(item)) {
      normalized.push(item)
    }
  }
  return normalized
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const next: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key === 'string' && key.length > 0 && typeof item === 'string') {
      next[key] = item
    }
  }
  return next
}

function normalizeRemoteProjects(value: unknown): WorkspaceRootsState['remoteProjects'] {
  if (!Array.isArray(value)) return []
  const next: WorkspaceRootsState['remoteProjects'] = []
  const seen = new Set<string>()
  for (const item of value) {
    const record = asRecord(item)
    if (!record) continue
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    next.push({
      id,
      hostId: typeof record.hostId === 'string' ? record.hostId.trim() : '',
      remotePath: typeof record.remotePath === 'string' ? record.remotePath.trim() : '',
      label: typeof record.label === 'string' ? record.label.trim() : '',
    })
  }
  return next
}



function getCodexAuthPath(): string {
  return join(getCodexHomeDir(), 'auth.json')
}

type CodexAuth = {
  auth_mode?: string
  last_refresh?: number
  tokens?: {
    access_token?: string
    refresh_token?: string
    id_token?: string
    account_id?: string
  }
}

export async function refreshChatgptAuthTokensForExternalAuth(
  params: ChatgptAuthTokensRefreshParams = {},
): Promise<ChatgptAuthTokensRefreshResponse> {
  return await getAccountAuthCoordinator().refreshActiveTokens(params)
}

async function readCodexAuth(): Promise<{ accessToken: string; accountId?: string } | null> {
  try {
    const raw = await readFile(getCodexAuthPath(), 'utf8')
    const auth = JSON.parse(raw) as CodexAuth
    const token = auth.tokens?.access_token
    if (!token) return null
    return { accessToken: token, accountId: auth.tokens?.account_id ?? undefined }
  } catch {
    return null
  }
}

function hasUsableCodexAuthSync(): boolean {
  try {
    const raw = readFileSync(getCodexAuthPath(), 'utf8')
    const auth = JSON.parse(raw) as CodexAuth
    return Boolean(auth.tokens?.access_token?.trim())
  } catch {
    return false
  }
}

function readFreeModeStateSync(statePath: string): FreeModeState | null {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8')) as FreeModeState
  } catch {
    return null
  }
}

type TomlScanState = {
  inMultilineBasicString: boolean
  inMultilineLiteralString: boolean
}

function stripTomlComment(line: string, state: TomlScanState): string {
  let content = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false
  for (let i = 0; i < line.length; i++) {
    if (state.inMultilineBasicString) {
      const end = line.indexOf('"""', i)
      if (end === -1) return content
      state.inMultilineBasicString = false
      i = end + 2
      continue
    }
    if (state.inMultilineLiteralString) {
      const end = line.indexOf("'''", i)
      if (end === -1) return content
      state.inMultilineLiteralString = false
      i = end + 2
      continue
    }
    const ch = line[i]
    if (inDoubleQuote && escaped) {
      escaped = false
      content += ch
      continue
    }
    if (inDoubleQuote && ch === '\\') {
      escaped = true
      content += ch
      continue
    }
    if (!inSingleQuote && !inDoubleQuote && line.startsWith('"""', i)) {
      state.inMultilineBasicString = true
      i += 2
      continue
    }
    if (!inSingleQuote && !inDoubleQuote && line.startsWith("'''", i)) {
      state.inMultilineLiteralString = true
      i += 2
      continue
    }
    if (!inDoubleQuote && ch === "'") {
      inSingleQuote = !inSingleQuote
      content += ch
      continue
    }
    if (!inSingleQuote && ch === '"') {
      inDoubleQuote = !inDoubleQuote
      content += ch
      continue
    }
    if (!inSingleQuote && !inDoubleQuote && ch === '#') {
      return content
    }
    content += ch
  }
  return content
}

function isModelProviderAssignment(content: string): boolean {
  return /^(?:model_provider|"model_provider"|'model_provider')\s*=/.test(content)
}

let explicitCodexModelProviderConfigCache: {
  path: string
  mtimeMs: number | null
  size: number | null
  value: boolean
} | null = null

function hasExplicitCodexModelProviderConfigSync(): boolean {
  const configPath = join(getCodexHomeDir(), 'config.toml')
  let info: ReturnType<typeof statSync> | null = null
  try {
    info = statSync(configPath)
  } catch {
    explicitCodexModelProviderConfigCache = {
      path: configPath,
      mtimeMs: null,
      size: null,
      value: false,
    }
    return false
  }
  if (
    explicitCodexModelProviderConfigCache?.path === configPath
    && explicitCodexModelProviderConfigCache.mtimeMs === info.mtimeMs
    && explicitCodexModelProviderConfigCache.size === info.size
  ) {
    return explicitCodexModelProviderConfigCache.value
  }

  let value = false
  try {
    const raw = readFileSync(configPath, 'utf8')
    let inTopLevelTable = true
    const scanState: TomlScanState = {
      inMultilineBasicString: false,
      inMultilineLiteralString: false,
    }
    for (const line of raw.split(/\r?\n/)) {
      const content = stripTomlComment(line, scanState).trim()
      if (!content) continue
      if (/^\[\[?[^\]]+\]?\]$/.test(content)) {
        inTopLevelTable = false
        continue
      }
      if (!inTopLevelTable) continue
      if (isModelProviderAssignment(content)) {
        value = true
        break
      }
    }
  } catch {
    value = false
  }
  explicitCodexModelProviderConfigCache = {
    path: configPath,
    mtimeMs: info.mtimeMs,
    size: info.size,
    value,
  }
  return value
}

export async function writeFreeModeStateFile(statePath: string, state: FreeModeState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true })
  await writeFile(statePath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
}

export function ensureDefaultFreeModeStateForMissingAuthSync(statePath: string): FreeModeState | null {
  const current = readFreeModeStateSync(statePath)
  const hasUsableCodexAuth = hasUsableCodexAuthSync()
  if (shouldSuppressCommunityFreeModeForCodexAuth(current, hasUsableCodexAuth)) {
    return null
  }
  const shouldCreateDefault = shouldCreateDefaultFreeModeStateForMissingAuth(current, hasUsableCodexAuth)
  const hasExplicitModelProviderConfig = shouldCreateDefault && hasExplicitCodexModelProviderConfigSync()
  if (hasExplicitModelProviderConfig || !shouldCreateDefault) {
    return current
  }

  return createDefaultOpenCodeZenFreeModeState()
}

function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false
  const normalized = remoteAddress.startsWith('::ffff:')
    ? remoteAddress.slice('::ffff:'.length)
    : remoteAddress
  return normalized === '127.0.0.1' || normalized === '::1'
}

let virtualProjectStore: VirtualProjectStore | undefined
function getVirtualProjectStore(): VirtualProjectStore {
  const home = getCodexHomeDir()
  if (!virtualProjectStore || virtualProjectStore.path !== join(home, 'codexapp-projects.json')) virtualProjectStore = new VirtualProjectStore(home)
  return virtualProjectStore
}

async function createProjectConversationDirectory(prompt: string | null, projectId: string) {
  const project = await getVirtualProjectStore().get(projectId)
  const directory = await createProjectlessThreadDirectory(prompt)
  await getVirtualProjectStore().assign(directory.cwd, project.id)
  return directory
}

async function createAutomationProjectConversationDirectory(prompt: string, projectId: string) {
  const directory = await createProjectlessThreadDirectory(prompt)
  await getVirtualProjectStore().assignIfPresent(directory.cwd, projectId)
  return directory
}

function getCodexGlobalStatePath(): string {
  return join(getCodexHomeDir(), '.codex-global-state.json')
}

function getTelegramBridgeConfigPath(): string {
  return join(getCodexHomeDir(), 'telegram-bridge.json')
}

function getCodexSessionIndexPath(): string {
  return join(getCodexHomeDir(), 'session_index.jsonl')
}

function getCodexAutomationsDir(): string {
  return join(getCodexHomeDir(), 'automations')
}

function toAutomationApiMap(
  automationsByTarget: Record<string, ThreadAutomationRecord[]>,
): Record<string, Array<Omit<ThreadAutomationRecord, 'extraTomlLines'>>> {
  return Object.fromEntries(
    Object.entries(automationsByTarget).map(([target, automations]) => [
      target,
      automations.map(toAutomationApiRecord),
    ]),
  )
}

function toAutomationApiData(
  automation: ThreadAutomationRecord | ThreadAutomationRecord[] | null,
): Omit<ThreadAutomationRecord, 'extraTomlLines'> | Array<Omit<ThreadAutomationRecord, 'extraTomlLines'>> | null {
  if (Array.isArray(automation)) return automation.map(toAutomationApiRecord)
  return automation ? toAutomationApiRecord(automation) : null
}

function slugifyAutomationId(threadId: string, name: string): string {
  const preferred = name.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '')
  if (preferred) return preferred.slice(0, 48)
  const fallback = threadId.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '')
  return `heartbeat-${fallback.slice(0, 24) || randomBytes(4).toString('hex')}`
}

async function readAutomationRecordFromFile(filePath: string): Promise<ThreadAutomationRecord | null> {
  try {
    const record = parseAutomationToml(await readFile(filePath, 'utf8'))
    const engine = (globalThis as any)[SHARED_BRIDGE_KEY]?.automationEngine as AutomationEngine | undefined
    return record && engine ? engine.decorate(record) : record
  } catch {
    return null
  }
}

async function listThreadHeartbeatAutomations(): Promise<Record<string, ThreadAutomationRecord[]>> {
  const automationRoot = getCodexAutomationsDir()
  const next: Record<string, ThreadAutomationRecord[]> = {}
  let entries
  try {
    entries = await readdir(automationRoot, { withFileTypes: true })
  } catch {
    return next
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const automation = await readAutomationRecordFromFile(join(automationRoot, entry.name, 'automation.toml'))
    if (!automation || automation.kind !== 'heartbeat' || !automation.targetThreadId) continue
    next[automation.targetThreadId] = [...(next[automation.targetThreadId] ?? []), automation]
  }

  for (const automations of Object.values(next)) {
    automations.sort((first, second) => {
      const firstCreatedAt = first.createdAtMs ?? 0
      const secondCreatedAt = second.createdAtMs ?? 0
      if (firstCreatedAt !== secondCreatedAt) return firstCreatedAt - secondCreatedAt
      return first.id.localeCompare(second.id)
    })
  }

  return next
}

async function readThreadHeartbeatAutomations(threadId: string): Promise<ThreadAutomationRecord[]> {
  const all = await listThreadHeartbeatAutomations()
  return all[threadId] ?? []
}

async function readThreadHeartbeatAutomation(threadId: string, automationId = ''): Promise<ThreadAutomationRecord | null> {
  const automations = await readThreadHeartbeatAutomations(threadId)
  if (automationId) return automations.find((automation) => automation.id === automationId) ?? null
  return automations[0] ?? null
}

function resolveUniqueAutomationId(existingIds: Set<string>, threadId: string, name: string): string {
  const baseId = slugifyAutomationId(threadId, name)
  if (!existingIds.has(baseId)) return baseId
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${baseId}-${index}`
    if (!existingIds.has(candidate)) return candidate
  }
  return `${baseId}-${randomBytes(4).toString('hex')}`
}

async function writeThreadHeartbeatAutomation(input: {
  threadId: string
  id?: string
  name: string
  prompt: string
  rrule: string
  status: ThreadAutomationStatus
  model?: unknown
  serviceTier?: unknown
  accountStorageId?: unknown
  protected?: unknown
  reasoningEffort?: unknown
  timezone?: string
}): Promise<ThreadAutomationRecord> {
  const threadId = input.threadId.trim()
  const name = input.name.trim()
  const prompt = input.prompt.trim()
  const rrule = input.rrule.trim()
  if (!threadId || !name || !prompt || !rrule) {
    throw new Error('threadId, name, prompt, and rrule are required')
  }

  const automationRoot = getCodexAutomationsDir()
  await mkdir(automationRoot, { recursive: true })
  const existing = input.id ? await readThreadHeartbeatAutomation(threadId, input.id.trim()) : null
  const entries = await readdir(automationRoot, { withFileTypes: true }).catch(() => [])
  const existingIds = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
  const id = existing?.id ?? resolveUniqueAutomationId(existingIds, threadId, name)
  const automationDir = join(automationRoot, id)
  const now = Date.now()
  const record: ThreadAutomationRecord = {
    ...normalizeAutomationModelSettings(input, existing ?? {}),
    timezone: input.timezone ?? existing?.timezone,
    id,
    kind: 'heartbeat',
    name,
    prompt,
    rrule,
    status: input.status,
    targetThreadId: threadId,
    cwds: [],
    extraTomlLines: existing?.extraTomlLines ?? [],
    createdAtMs: existing?.createdAtMs ?? now,
    updatedAtMs: now,
    nextRunAtMs: null,
  }

  await mkdir(automationDir, { recursive: true })
  await writeAutomationFileAtomic(join(automationDir, 'automation.toml'), serializeAutomationToml(record))
  const memoryPath = join(automationDir, 'memory.md')
  try {
    await stat(memoryPath)
  } catch {
    await writeFile(memoryPath, '', 'utf8')
  }
  return record
}

async function deleteThreadHeartbeatAutomation(threadId: string, automationId = ''): Promise<boolean> {
  const normalizedThreadId = threadId.trim()
  const normalizedAutomationId = automationId.trim()
  if (normalizedAutomationId) {
    const automation = await readThreadHeartbeatAutomation(normalizedThreadId, normalizedAutomationId)
    if (!automation) return false
    await rm(join(getCodexAutomationsDir(), automation.id), { recursive: true, force: true })
    return true
  }

  const automations = await readThreadHeartbeatAutomations(normalizedThreadId)
  if (automations.length === 0) return false
  await Promise.all(automations.map((automation) => rm(join(getCodexAutomationsDir(), automation.id), { recursive: true, force: true })))
  return true
}

async function listProjectCronAutomations(): Promise<Record<string, ThreadAutomationRecord[]>> {
  const automationRoot = getCodexAutomationsDir()
  const next: Record<string, ThreadAutomationRecord[]> = {}
  let entries
  try {
    entries = await readdir(automationRoot, { withFileTypes: true })
  } catch {
    return next
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const automation = await readAutomationRecordFromFile(join(automationRoot, entry.name, 'automation.toml'))
    if (!automation || automation.kind !== 'cron' || automation.cwds.length === 0) continue
    for (const cwd of automation.cwds) {
      next[cwd] = [...(next[cwd] ?? []), automation]
    }
  }

  for (const automations of Object.values(next)) {
    automations.sort((first, second) => {
      const firstCreatedAt = first.createdAtMs ?? 0
      const secondCreatedAt = second.createdAtMs ?? 0
      if (firstCreatedAt !== secondCreatedAt) return firstCreatedAt - secondCreatedAt
      return first.id.localeCompare(second.id)
    })
  }

  return next
}

async function readProjectCronAutomations(projectName: string): Promise<ThreadAutomationRecord[]> {
  const all = await listProjectCronAutomations()
  return all[projectName] ?? []
}

async function readProjectCronAutomation(projectName: string, automationId = ''): Promise<ThreadAutomationRecord | null> {
  const automations = await readProjectCronAutomations(projectName)
  if (automationId) return automations.find((automation) => automation.id === automationId) ?? null
  return automations[0] ?? null
}

async function writeProjectCronAutomation(input: {
  projectName: string
  id?: string
  name: string
  prompt: string
  rrule: string
  status: ThreadAutomationStatus
  model?: unknown
  serviceTier?: unknown
  accountStorageId?: unknown
  protected?: unknown
  reasoningEffort?: unknown
  timezone?: string
}): Promise<ThreadAutomationRecord> {
  const projectName = input.projectName.trim()
  const name = input.name.trim()
  const prompt = input.prompt.trim()
  const rrule = input.rrule.trim()
  if (!projectName || !name || !prompt || !rrule) {
    throw new Error('projectName, name, prompt, and rrule are required')
  }
  if (!isAbsoluteLikePath(projectName) && !isVirtualProjectId(projectName)) {
    throw new Error('Project automation cwd must be an absolute path')
  }

  const automationRoot = getCodexAutomationsDir()
  await mkdir(automationRoot, { recursive: true })
  const existing = input.id ? await readProjectCronAutomation(projectName, input.id.trim()) : null
  const entries = await readdir(automationRoot, { withFileTypes: true }).catch(() => [])
  const existingIds = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
  const id = existing?.id ?? resolveUniqueAutomationId(existingIds, projectName, name)
  const automationDir = join(automationRoot, id)
  const now = Date.now()
  const record: ThreadAutomationRecord = {
    ...normalizeAutomationModelSettings(input, existing ?? {}),
    timezone: input.timezone ?? existing?.timezone,
    id,
    kind: 'cron',
    name,
    prompt,
    rrule,
    status: input.status,
    targetThreadId: null,
    cwds: Array.from(new Set([...(existing?.cwds ?? []), projectName])),
    extraTomlLines: existing?.extraTomlLines ?? [],
    createdAtMs: existing?.createdAtMs ?? now,
    updatedAtMs: now,
    nextRunAtMs: null,
  }

  await mkdir(automationDir, { recursive: true })
  await writeAutomationFileAtomic(join(automationDir, 'automation.toml'), serializeAutomationToml(record))
  const memoryPath = join(automationDir, 'memory.md')
  try {
    await stat(memoryPath)
  } catch {
    await writeFile(memoryPath, '', 'utf8')
  }
  return record
}

async function deleteProjectCronAutomation(projectName: string, automationId = ''): Promise<boolean> {
  const normalizedProjectName = projectName.trim()
  const normalizedAutomationId = automationId.trim()
  if (!normalizedProjectName || (!isAbsoluteLikePath(normalizedProjectName) && !isVirtualProjectId(normalizedProjectName))) return false
  if (normalizedAutomationId) {
    const automation = await readProjectCronAutomation(normalizedProjectName, normalizedAutomationId)
    if (!automation) return false
    const remainingCwds = automation.cwds.filter((cwd) => cwd !== normalizedProjectName)
    if (remainingCwds.length > 0) {
      const record = { ...automation, cwds: remainingCwds, updatedAtMs: Date.now() }
      await writeAutomationFileAtomic(join(getCodexAutomationsDir(), automation.id, 'automation.toml'), serializeAutomationToml(record))
    } else {
      await rm(join(getCodexAutomationsDir(), automation.id), { recursive: true, force: true })
    }
    return true
  }

  const automations = await readProjectCronAutomations(normalizedProjectName)
  if (automations.length === 0) return false
  await Promise.all(automations.map(async (automation) => {
    const remainingCwds = automation.cwds.filter((cwd) => cwd !== normalizedProjectName)
    if (remainingCwds.length > 0) {
      const record = { ...automation, cwds: remainingCwds, updatedAtMs: Date.now() }
      await writeAutomationFileAtomic(join(getCodexAutomationsDir(), automation.id, 'automation.toml'), serializeAutomationToml(record))
      return
    }
    await rm(join(getCodexAutomationsDir(), automation.id), { recursive: true, force: true })
  }))
  return true
}

type ThreadTitleCache = { titles: Record<string, string>; order: string[] }
const MAX_THREAD_TITLES = 500
const EMPTY_THREAD_TITLE_CACHE: ThreadTitleCache = { titles: {}, order: [] }
const PINNED_THREAD_IDS_KEY = 'pinned-thread-ids'

type SessionIndexThreadTitleCacheState = {
  fileSignature: string | null
  cache: ThreadTitleCache
}

let sessionIndexThreadTitleCacheState: SessionIndexThreadTitleCacheState = {
  fileSignature: null,
  cache: EMPTY_THREAD_TITLE_CACHE,
}

type TelegramBridgeConfigState = QuietHoursSettings & {
  botToken: string
  notificationsEnabled: boolean
  chatIds: number[]
  allowedUserIds: Array<number | '*'>
}

function normalizeThreadTitleCache(value: unknown): ThreadTitleCache {
  const record = asRecord(value)
  if (!record) return EMPTY_THREAD_TITLE_CACHE
  const rawTitles = asRecord(record.titles)
  const titles: Record<string, string> = {}
  if (rawTitles) {
    for (const [k, v] of Object.entries(rawTitles)) {
      if (typeof v === 'string' && v.length > 0) titles[k] = v
    }
  }
  const order = normalizeStringArray(record.order)
  return { titles, order }
}

function normalizePinnedThreadIds(value: unknown): string[] {
  return normalizeStringArray(value)
}

function updateThreadTitleCache(cache: ThreadTitleCache, id: string, title: string): ThreadTitleCache {
  const titles = { ...cache.titles, [id]: title }
  const order = [id, ...cache.order.filter((o) => o !== id)]
  while (order.length > MAX_THREAD_TITLES) {
    const removed = order.pop()
    if (removed) delete titles[removed]
  }
  return { titles, order }
}

function removeFromThreadTitleCache(cache: ThreadTitleCache, id: string): ThreadTitleCache {
  const { [id]: _, ...titles } = cache.titles
  return { titles, order: cache.order.filter((o) => o !== id) }
}

type SessionIndexThreadTitle = {
  id: string
  title: string
  updatedAtMs: number
}

function normalizeSessionIndexThreadTitle(value: unknown): SessionIndexThreadTitle | null {
  const record = asRecord(value)
  if (!record) return null

  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const title = typeof record.thread_name === 'string' ? record.thread_name.trim() : ''
  const updatedAtIso = typeof record.updated_at === 'string' ? record.updated_at.trim() : ''
  const updatedAtMs = updatedAtIso ? Date.parse(updatedAtIso) : Number.NaN

  if (!id || !title) return null
  return {
    id,
    title,
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
  }
}

function trimThreadTitleCache(cache: ThreadTitleCache): ThreadTitleCache {
  const titles = { ...cache.titles }
  const order = cache.order.filter((id) => {
    if (!titles[id]) return false
    return true
  }).slice(0, MAX_THREAD_TITLES)

  for (const id of Object.keys(titles)) {
    if (!order.includes(id)) {
      delete titles[id]
    }
  }

  return { titles, order }
}

function mergeThreadTitleCaches(base: ThreadTitleCache, overlay: ThreadTitleCache): ThreadTitleCache {
  const titles = { ...base.titles, ...overlay.titles }
  const order: string[] = []

  for (const id of [...overlay.order, ...base.order]) {
    if (!titles[id] || order.includes(id)) continue
    order.push(id)
  }

  for (const id of Object.keys(titles)) {
    if (!order.includes(id)) {
      order.push(id)
    }
  }

  return trimThreadTitleCache({ titles, order })
}

async function readThreadTitleCache(): Promise<ThreadTitleCache> {
  const statePath = getCodexGlobalStatePath()
  try {
    const raw = await readFile(statePath, 'utf8')
    const payload = asRecord(JSON.parse(raw)) ?? {}
    return normalizeThreadTitleCache(payload['thread-titles'])
  } catch {
    return EMPTY_THREAD_TITLE_CACHE
  }
}

async function writeThreadTitleCache(cache: ThreadTitleCache): Promise<void> {
  const statePath = getCodexGlobalStatePath()
  let payload: Record<string, unknown> = {}
  try {
    const raw = await readFile(statePath, 'utf8')
    payload = asRecord(JSON.parse(raw)) ?? {}
  } catch {
    payload = {}
  }
  payload['thread-titles'] = cache
  await writeFile(statePath, JSON.stringify(payload), 'utf8')
}

async function readPinnedThreadIds(): Promise<string[]> {
  const statePath = getCodexGlobalStatePath()
  try {
    const raw = await readFile(statePath, 'utf8')
    const payload = asRecord(JSON.parse(raw)) ?? {}
    return normalizePinnedThreadIds(payload[PINNED_THREAD_IDS_KEY])
  } catch {
    return []
  }
}

async function writePinnedThreadIds(threadIds: string[]): Promise<void> {
  const statePath = getCodexGlobalStatePath()
  let payload: Record<string, unknown> = {}
  try {
    const raw = await readFile(statePath, 'utf8')
    payload = asRecord(JSON.parse(raw)) ?? {}
  } catch {
    payload = {}
  }

  payload[PINNED_THREAD_IDS_KEY] = normalizePinnedThreadIds(threadIds)
  await writeFile(statePath, JSON.stringify(payload), 'utf8')
}

const FIRST_LAUNCH_PLUGINS_CARD_DISMISSED_KEY = 'first-launch-plugins-card-dismissed'
const THREAD_QUEUE_STATE_KEY = 'thread-queue-state'

type BackendQueuedTurn = {
  threadId: string
  message: StoredQueuedMessage
}

type ResolvedCollaborationModeSettings = {
  model: string
  reasoningEffort: ReasoningEffort | null
}

async function readLegacyThreadQueueState(): Promise<ThreadQueueState> {
  const statePath = getCodexGlobalStatePath()
  try {
    const raw = await readFile(statePath, 'utf8')
    const payload = asRecord(JSON.parse(raw)) ?? {}
    const legacy = payload[THREAD_QUEUE_STATE_KEY]
    if (legacy === undefined) return {}
    const queues = asRecord(legacy)
    if (!queues || Object.entries(queues).some(([id, rows]) => !id.trim() || !Array.isArray(rows) || rows.some(row => !normalizeStoredQueuedMessage(row)))) throw new Error('旧队列内容无效，已停止迁移')
    return normalizeThreadQueueState(queues)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

async function clearLegacyThreadQueueState(): Promise<void> {
  await queueWorkspaceRootsMutation(async () => {
    const statePath = getCodexGlobalStatePath()
    let payload: Record<string, unknown>
    try {
      const parsed = asRecord(JSON.parse(await readFile(statePath, 'utf8')))
      if (!parsed) throw new Error('全局状态文件无效，已停止队列迁移')
      payload = parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (!(THREAD_QUEUE_STATE_KEY in payload)) return
    delete payload[THREAD_QUEUE_STATE_KEY]
    await writeAutomationFileAtomic(statePath, JSON.stringify(payload))
  })
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | '' {
  return capabilityValue(value)
}

function normalizeCollaborationModeReasoningEffort(value: ReasoningEffort | '' | null | undefined): ReasoningEffort | null {
  return value && value.length > 0 ? value : null
}

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

function buildTextWithAttachments(prompt: string, files: StoredQueuedMessage['fileAttachments']): string {
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

function extractThreadIdFromNotificationParams(params: unknown): string {
  const record = asRecord(params)
  if (!record) return ''
  const threadId =
    (typeof record.threadId === 'string' ? record.threadId : '') ||
    (typeof record.thread_id === 'string' ? record.thread_id : '') ||
    (typeof record.conversationId === 'string' ? record.conversationId : '') ||
    (typeof record.conversation_id === 'string' ? record.conversation_id : '')
  if (threadId) return threadId
  const thread = asRecord(record.thread)
  if (thread && typeof thread.id === 'string') return thread.id
  const turn = asRecord(record.turn)
  if (turn) {
    const turnThreadId =
      (typeof turn.threadId === 'string' ? turn.threadId : '') ||
      (typeof turn.thread_id === 'string' ? turn.thread_id : '')
    if (turnThreadId) return turnThreadId
  }
  return ''
}

function isTurnCompletedNotification(notification: { method: string; params: unknown }): boolean {
  return notification.method === 'turn/completed'
}

async function readFirstLaunchPluginsCardDismissed(): Promise<boolean> {
  const statePath = getCodexGlobalStatePath()
  try {
    const raw = await readFile(statePath, 'utf8')
    const payload = asRecord(JSON.parse(raw)) ?? {}
    return payload[FIRST_LAUNCH_PLUGINS_CARD_DISMISSED_KEY] === true
  } catch {
    return false
  }
}

async function writeFirstLaunchPluginsCardDismissed(dismissed: boolean): Promise<void> {
  const statePath = getCodexGlobalStatePath()
  let payload: Record<string, unknown> = {}
  try {
    const raw = await readFile(statePath, 'utf8')
    payload = asRecord(JSON.parse(raw)) ?? {}
  } catch {
    payload = {}
  }
  payload[FIRST_LAUNCH_PLUGINS_CARD_DISMISSED_KEY] = dismissed === true
  await writeFile(statePath, JSON.stringify(payload), 'utf8')
}

function getSessionIndexFileSignature(stats: { mtimeMs: number; size: number }): string {
  return `${String(stats.mtimeMs)}:${String(stats.size)}`
}

async function parseThreadTitlesFromSessionIndex(sessionIndexPath: string): Promise<ThreadTitleCache> {
  const latestById = new Map<string, SessionIndexThreadTitle>()
  const input = createReadStream(sessionIndexPath, { encoding: 'utf8' })
  const lines = createInterface({
    input,
    crlfDelay: Infinity,
  })

  try {
    for await (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      try {
        const entry = normalizeSessionIndexThreadTitle(JSON.parse(trimmed) as unknown)
        if (!entry) continue

        const previous = latestById.get(entry.id)
        if (!previous || entry.updatedAtMs >= previous.updatedAtMs) {
          latestById.set(entry.id, entry)
        }
      } catch {
        // Skip malformed lines and keep scanning the rest of the index.
      }
    }
  } finally {
    lines.close()
    input.close()
  }

  const entries = Array.from(latestById.values()).sort((first, second) => second.updatedAtMs - first.updatedAtMs)
  const titles: Record<string, string> = {}
  const order: string[] = []
  for (const entry of entries) {
    titles[entry.id] = entry.title
    order.push(entry.id)
  }

  return trimThreadTitleCache({ titles, order })
}

async function readThreadTitlesFromSessionIndex(): Promise<ThreadTitleCache> {
  const sessionIndexPath = getCodexSessionIndexPath()

  try {
    const stats = await stat(sessionIndexPath)
    const fileSignature = getSessionIndexFileSignature(stats)
    if (sessionIndexThreadTitleCacheState.fileSignature === fileSignature) {
      return sessionIndexThreadTitleCacheState.cache
    }

    const cache = await parseThreadTitlesFromSessionIndex(sessionIndexPath)
    sessionIndexThreadTitleCacheState = { fileSignature, cache }
    return cache
  } catch {
    sessionIndexThreadTitleCacheState = {
      fileSignature: 'missing',
      cache: EMPTY_THREAD_TITLE_CACHE,
    }
    return sessionIndexThreadTitleCacheState.cache
  }
}

async function readMergedThreadTitleCache(): Promise<ThreadTitleCache> {
  const [sessionIndexCache, persistedCache] = await Promise.all([
    readThreadTitlesFromSessionIndex(),
    readThreadTitleCache(),
  ])
  return mergeThreadTitleCaches(persistedCache, sessionIndexCache)
}

type PathRealpathResolver = (path: string) => Promise<string>

async function canonicalizeWorkspaceRootPath(
  value: string,
  pathRealpath: PathRealpathResolver,
): Promise<string> {
  if (!isAbsolute(value)) return value
  try {
    return await pathRealpath(value)
  } catch {
    return value
  }
}

async function canonicalizeWorkspaceRootPathList(
  values: string[],
  pathRealpath: PathRealpathResolver,
): Promise<string[]> {
  return normalizeStringArray(await Promise.all(values.map((value) => canonicalizeWorkspaceRootPath(value, pathRealpath))))
}

export async function canonicalizeWorkspaceRootsState(
  state: WorkspaceRootsState,
  pathRealpath: PathRealpathResolver = realpath,
): Promise<WorkspaceRootsState> {
  const [order, active, projectOrder] = await Promise.all([
    canonicalizeWorkspaceRootPathList(state.order, pathRealpath),
    canonicalizeWorkspaceRootPathList(state.active, pathRealpath),
    canonicalizeWorkspaceRootPathList(state.projectOrder, pathRealpath),
  ])
  const labelEntries = await Promise.all(
    Object.entries(state.labels)
      .sort(([first], [second]) => first.localeCompare(second))
      .map(async ([key, label]) => {
        const canonicalKey = await canonicalizeWorkspaceRootPath(key, pathRealpath)
        return {
          canonicalKey,
          label,
          isCanonicalSource: canonicalKey === key,
        }
      }),
  )
  const labels: Record<string, string> = {}
  const labelSourceByCanonicalKey = new Map<string, { isCanonicalSource: boolean }>()
  for (const entry of labelEntries) {
    const existing = labelSourceByCanonicalKey.get(entry.canonicalKey)
    if (existing?.isCanonicalSource === true && !entry.isCanonicalSource) continue
    if (existing && existing.isCanonicalSource === entry.isCanonicalSource) continue
    labels[entry.canonicalKey] = entry.label
    labelSourceByCanonicalKey.set(entry.canonicalKey, {
      isCanonicalSource: entry.isCanonicalSource,
    })
  }

  return {
    order,
    labels,
    active,
    projectOrder,
    remoteProjects: state.remoteProjects.map((project) => ({ ...project })),
    ...(state.virtualProjects ? { virtualProjects: state.virtualProjects } : {}),
  }
}

export async function canonicalizeWorkspaceRootsStateForRead(
  state: WorkspaceRootsState,
  pathRealpath: PathRealpathResolver = realpath,
): Promise<WorkspaceRootsState> {
  return await canonicalizeWorkspaceRootsState(state, pathRealpath)
}

async function canonicalizeThreadCwdRecord(
  value: unknown,
  canonicalizeCwd: (cwd: string) => Promise<string>,
): Promise<unknown> {
  const record = asRecord(value)
  const cwd = typeof record?.cwd === 'string' ? record.cwd : ''
  if (!record || !cwd) return value
  const canonicalCwd = await canonicalizeCwd(cwd)
  return canonicalCwd === cwd ? value : { ...record, cwd: canonicalCwd }
}

export async function canonicalizeThreadListResponseForRead(
  payload: unknown,
  pathRealpath: PathRealpathResolver = realpath,
): Promise<unknown> {
  const record = asRecord(payload)
  if (!record || !Array.isArray(record.data)) return payload
  const cwdCanonicalizationByValue = new Map<string, Promise<string>>()
  const canonicalizeCwd = (cwd: string): Promise<string> => {
    let canonicalized = cwdCanonicalizationByValue.get(cwd)
    if (!canonicalized) {
      canonicalized = canonicalizeWorkspaceRootPath(cwd, pathRealpath)
      cwdCanonicalizationByValue.set(cwd, canonicalized)
    }
    return canonicalized
  }
  return {
    ...record,
    data: await Promise.all(record.data.map((item) => canonicalizeThreadCwdRecord(item, canonicalizeCwd))),
  }
}

async function readWorkspaceRootsState(): Promise<WorkspaceRootsState> {
  const statePath = getCodexGlobalStatePath()
  let payload: Record<string, unknown> = {}

  try {
    const raw = await readFile(statePath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    payload = asRecord(parsed) ?? {}
  } catch {
    payload = {}
  }

  const virtualProjects = await getVirtualProjectStore().list()
  return await canonicalizeWorkspaceRootsState({
    virtualProjects,
    order: normalizeStringArray(payload['electron-saved-workspace-roots']),
    labels: { ...normalizeStringRecord(payload['electron-workspace-root-labels']), ...Object.fromEntries(virtualProjects.map(project => [project.id, project.label])) },
    active: normalizeStringArray(payload['active-workspace-roots']),
    projectOrder: normalizeStringArray(payload['project-order']),
    remoteProjects: normalizeRemoteProjects(payload['remote-projects']),
  })
}

export async function writeWorkspaceRootsState(nextState: WorkspaceRootsState): Promise<void> {
  const state = await canonicalizeWorkspaceRootsState(nextState)
  const statePath = getCodexGlobalStatePath()
  let payload: Record<string, unknown> = {}
  try {
    const raw = await readFile(statePath, 'utf8')
    payload = asRecord(JSON.parse(raw)) ?? {}
  } catch {
    payload = {}
  }

  payload['electron-saved-workspace-roots'] = normalizeStringArray(state.order)
  payload['electron-workspace-root-labels'] = normalizeStringRecord(Object.fromEntries(Object.entries(state.labels).filter(([id]) => !isVirtualProjectId(id))))
  payload['active-workspace-roots'] = normalizeStringArray(state.active)
  payload['project-order'] = normalizeStringArray(state.projectOrder)

  await writeFile(statePath, JSON.stringify(payload), 'utf8')
}

let workspaceRootsMutation: Promise<void> = Promise.resolve()

function queueWorkspaceRootsMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const run = workspaceRootsMutation.catch(() => undefined).then(mutation)
  workspaceRootsMutation = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function prependUniqueString(value: string, items: string[]): string[] {
  return [value, ...items.filter((item) => item !== value)]
}

async function updateWorkspaceRootsState(
  updater: (existingState: WorkspaceRootsState) => WorkspaceRootsState,
): Promise<void> {
  await queueWorkspaceRootsMutation(async () => {
    const existingState = await readWorkspaceRootsState()
    await writeWorkspaceRootsState(updater(existingState))
  })
}

async function persistWorkspaceRoot(workspaceRoot: string, label = ''): Promise<void> {
  const normalizedRoot = workspaceRoot.trim()
  if (!normalizedRoot) return

  await updateWorkspaceRootsState((existingState) => {
    const nextLabels = { ...existingState.labels }
    const trimmedLabel = label.trim()
    if (trimmedLabel.length > 0) {
      nextLabels[normalizedRoot] = trimmedLabel
    }
    return {
      order: prependUniqueString(normalizedRoot, existingState.order),
      labels: nextLabels,
      active: prependUniqueString(normalizedRoot, existingState.active),
      projectOrder: prependUniqueString(normalizedRoot, existingState.projectOrder),
      remoteProjects: existingState.remoteProjects,
    }
  })
}

async function rollbackCreatedWorktree(
  gitRoot: string,
  worktreeCwd: string,
  cleanupDirectory?: string,
  branchName?: string,
): Promise<void> {
  try {
    await runCommand('git', ['worktree', 'remove', '--force', worktreeCwd], { cwd: gitRoot })
  } catch {
    await rm(worktreeCwd, { recursive: true, force: true }).catch(() => undefined)
  }

  if (cleanupDirectory && cleanupDirectory !== worktreeCwd) {
    await rm(cleanupDirectory, { recursive: true, force: true }).catch(() => undefined)
  }

  if (branchName) {
    await runCommand('git', ['branch', '-D', branchName], { cwd: gitRoot }).catch(() => undefined)
  }
}

function normalizeTelegramBridgeConfig(value: unknown): TelegramBridgeConfigState {
  const record = asRecord(value)
  if (!record) return { ...defaultQuietHours, botToken: '', notificationsEnabled: false, chatIds: [], allowedUserIds: [] }
  const botToken = typeof record.botToken === 'string' ? record.botToken.trim() : ''
  const notificationsEnabled = typeof record.notificationsEnabled === 'boolean' ? record.notificationsEnabled : !!botToken
  const rawChatIds = Array.isArray(record.chatIds) ? record.chatIds : []
  const chatIds = Array.from(new Set(rawChatIds
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .map((value) => Math.trunc(value)))).slice(0, 50)
  const rawAllowedUserIds = Array.isArray(record.allowedUserIds) ? record.allowedUserIds : []
  const allowAllUsers = rawAllowedUserIds.some((value) => typeof value === 'string' && value.trim() === '*')
  const normalizedAllowedUserIds = Array.from(new Set(rawAllowedUserIds
    .map((value) => {
      if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
      if (typeof value === 'string') {
        const normalized = value.trim().replace(/^(telegram|tg):/i, '').trim()
        if (/^-?\d+$/.test(normalized)) {
          return Number.parseInt(normalized, 10)
        }
      }
      return Number.NaN
    })
    .filter((value) => Number.isFinite(value)))).slice(0, 100)
  const allowedUserIds: Array<number | '*'> = allowAllUsers
    ? ['*' as const, ...normalizedAllowedUserIds]
    : normalizedAllowedUserIds
  const quietHours = validateQuietHours({
    timezone: typeof record.timezone === 'string' ? record.timezone : defaultQuietHours.timezone,
    quietEnabled: typeof record.quietEnabled === 'boolean' ? record.quietEnabled : false,
    quietStart: typeof record.quietStart === 'string' ? record.quietStart : defaultQuietHours.quietStart,
    quietEnd: typeof record.quietEnd === 'string' ? record.quietEnd : defaultQuietHours.quietEnd,
  })
  return { ...quietHours, botToken, notificationsEnabled, chatIds, allowedUserIds }
}

async function readTelegramBridgeConfig(): Promise<TelegramBridgeConfigState> {
  const telegramConfigPath = getTelegramBridgeConfigPath()
  try {
    const raw = await readFile(telegramConfigPath, 'utf8')
    const payload = asRecord(JSON.parse(raw)) ?? {}
    return normalizeTelegramBridgeConfig(payload)
  } catch {
    return { ...defaultQuietHours, botToken: '', notificationsEnabled: false, chatIds: [], allowedUserIds: [] }
  }
}

async function writeTelegramBridgeConfig(nextState: TelegramBridgeConfigState): Promise<void> {
  const normalized = normalizeTelegramBridgeConfig(nextState)
  const telegramConfigPath = getTelegramBridgeConfigPath()
  await writeFile(telegramConfigPath, JSON.stringify(normalized), 'utf8')
}

let telegramBridgeConfigMutation: Promise<void> = Promise.resolve()

function mutateTelegramBridgeConfig<T>(mutation: () => Promise<T>): Promise<T> {
  const result = telegramBridgeConfigMutation.then(mutation)
  telegramBridgeConfigMutation = result.then(() => {}, () => {})
  return result
}

function rememberTelegramChatId(chatId: number): Promise<void> {
  const normalizedChatId = Math.trunc(chatId)
  if (!Number.isFinite(normalizedChatId)) return Promise.resolve()

  return mutateTelegramBridgeConfig(async () => {
    const current = await readTelegramBridgeConfig()
    if (current.chatIds.includes(normalizedChatId)) return
    const next = {
      ...current,
      chatIds: [normalizedChatId, ...current.chatIds].slice(0, 50),
    }
    await writeTelegramBridgeConfig(next)
  })
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readRawBody(req)
  if (raw.length === 0) return null
  const text = raw.toString('utf8').trim()
  if (text.length === 0) return null
  return JSON.parse(text) as unknown
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks)
}

function bufferIndexOf(buf: Buffer, needle: Buffer, start = 0): number {
  for (let i = start; i <= buf.length - needle.length; i++) {
    let match = true
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) { match = false; break }
    }
    if (match) return i
  }
  return -1
}

function handleFileUpload(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => chunks.push(chunk))
  req.on('end', async () => {
    try {
      const body = Buffer.concat(chunks)
      const contentType = req.headers['content-type'] ?? ''
      const boundaryMatch = contentType.match(/boundary=(.+)/i)
      if (!boundaryMatch) { setJson(res, 400, { error: 'Missing multipart boundary' }); return }
      const boundary = boundaryMatch[1]
      const boundaryBuf = Buffer.from(`--${boundary}`)
      const parts: Buffer[] = []
      let searchStart = 0
      while (searchStart < body.length) {
        const idx = body.indexOf(boundaryBuf, searchStart)
        if (idx < 0) break
        if (searchStart > 0) parts.push(body.subarray(searchStart, idx))
        searchStart = idx + boundaryBuf.length
        if (body[searchStart] === 0x0d && body[searchStart + 1] === 0x0a) searchStart += 2
      }
      let fileName = 'uploaded-file'
      let fileData: Buffer | null = null
      const headerSep = Buffer.from('\r\n\r\n')
      for (const part of parts) {
        const headerEnd = bufferIndexOf(part, headerSep)
        if (headerEnd < 0) continue
        const headers = part.subarray(0, headerEnd).toString('utf8')
        const fnMatch = headers.match(/filename="([^"]+)"/i)
        if (!fnMatch) continue
        fileName = fnMatch[1].replace(/[/\\]/g, '_')
        let end = part.length
        if (end >= 2 && part[end - 2] === 0x0d && part[end - 1] === 0x0a) end -= 2
        fileData = part.subarray(headerEnd + 4, end)
        break
      }
      if (!fileData) { setJson(res, 400, { error: 'No file in request' }); return }
      const uploadDir = join(tmpdir(), 'codex-web-uploads')
      await mkdir(uploadDir, { recursive: true })
      const destDir = await mkdtemp(join(uploadDir, 'f-'))
      const destPath = join(destDir, fileName)
      await writeFile(destPath, fileData)
      setJson(res, 200, { path: destPath })
    } catch (err) {
      setJson(res, 500, { error: getErrorMessage(err, 'Upload failed') })
    }
  })
  req.on('error', (err: Error) => {
    setJson(res, 500, { error: getErrorMessage(err, 'Upload stream error') })
  })
}

function httpPost(
  url: string,
  headers: Record<string, string | number>,
  body: Buffer,
): Promise<{ status: number; body: string }> {
  const doRequest = url.startsWith('http://') ? httpRequest : httpsRequest
  return new Promise((resolve, reject) => {
    const req = doRequest(url, { method: 'POST', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

let curlImpersonateAvailable: boolean | null = null

function curlImpersonatePost(
  url: string,
  headers: Record<string, string | number>,
  body: Buffer,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const args = ['-s', '-w', '\n%{http_code}', '-X', 'POST', url]
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === 'content-length') continue
      args.push('-H', `${k}: ${String(v)}`)
    }
    args.push('--data-binary', '@-')
    const proc = spawn('curl-impersonate-chrome', args, {
      env: { ...process.env, CURL_IMPERSONATE: 'chrome116' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    proc.stdout.on('data', (c: Buffer) => chunks.push(c))
    proc.on('error', (e) => {
      curlImpersonateAvailable = false
      reject(e)
    })
    proc.on('close', (code) => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const lastNewline = raw.lastIndexOf('\n')
      const statusStr = lastNewline >= 0 ? raw.slice(lastNewline + 1).trim() : ''
      const responseBody = lastNewline >= 0 ? raw.slice(0, lastNewline) : raw
      const status = parseInt(statusStr, 10) || (code === 0 ? 200 : 500)
      curlImpersonateAvailable = true
      resolve({ status, body: responseBody })
    })
    proc.stdin.write(body)
    proc.stdin.end()
  })
}

async function proxyTranscribe(
  body: Buffer,
  contentType: string,
  authToken: string,
  accountId?: string,
): Promise<{ status: number; body: string }> {
  const chatgptHeaders: Record<string, string | number> = {
    'Content-Type': contentType,
    'Content-Length': body.length,
    Authorization: `Bearer ${authToken}`,
    originator: 'Codex Desktop',
    'User-Agent': `Codex Desktop/0.1.0 (${process.platform}; ${process.arch})`,
  }
  if (accountId) chatgptHeaders['ChatGPT-Account-Id'] = accountId

  const postFn = curlImpersonateAvailable !== false ? curlImpersonatePost : httpPost
  let result: { status: number; body: string }
  try {
    result = await postFn('https://chatgpt.com/backend-api/transcribe', chatgptHeaders, body)
  } catch {
    result = await httpPost('https://chatgpt.com/backend-api/transcribe', chatgptHeaders, body)
  }

  if (result.status === 403 && result.body.includes('cf_chl')) {
    if (curlImpersonateAvailable !== false && postFn !== curlImpersonatePost) {
      try {
        const ciResult = await curlImpersonatePost('https://chatgpt.com/backend-api/transcribe', chatgptHeaders, body)
        if (ciResult.status !== 403) return ciResult
      } catch {}
    }
    return { status: 503, body: JSON.stringify({ error: 'Transcription blocked by Cloudflare. Install curl-impersonate-chrome.' }) }
  }

  return result
}

function parseConnectorLogoUrl(rawUrl: string): { connectorId: string; theme: 'light' | 'dark' } | null {
  const trimmed = rawUrl.trim()
  if (!trimmed.startsWith('connectors://')) return null
  const rest = trimmed.slice('connectors://'.length)
  const connectorId = (rest.split(/[/?#]/u)[0] ?? '').trim()
  if (!connectorId) return null
  const query = rest.includes('?') ? rest.slice(rest.indexOf('?') + 1).split('#')[0] ?? '' : ''
  const theme = new URLSearchParams(query).get('theme')?.toLowerCase() === 'dark' ? 'dark' : 'light'
  return { connectorId, theme }
}

async function fetchConnectorLogo(rawUrl: string): Promise<{ contentType: string; body: Buffer }> {
  const parsed = parseConnectorLogoUrl(rawUrl)
  if (!parsed) throw new Error('Unsupported connector logo URL')
  const auth = await readCodexAuth()
  if (!auth) throw new Error('No auth token available for connector logo')

  const endpoint = `https://chatgpt.com/backend-api/aip/connectors/${encodeURIComponent(parsed.connectorId)}/logo?theme=${parsed.theme}`
  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      originator: 'Codex Desktop',
      'User-Agent': `Codex Desktop/0.1.0 (${process.platform}; ${process.arch})`,
      ...(auth.accountId ? { 'ChatGPT-Account-Id': auth.accountId } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Connector logo fetch failed (${response.status})`)

  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    const payload = asRecord(await response.json())
    const body = asRecord(payload?.body)
    const base64 = readNonEmptyString(body?.base64)
    const nestedContentType = readNonEmptyString(body?.contentType) ?? readNonEmptyString(body?.content_type)
    if (!base64 || !nestedContentType) throw new Error('Connector logo response was missing image data')
    return { contentType: nestedContentType, body: Buffer.from(base64, 'base64') }
  }

  return {
    contentType: contentType || 'image/png',
    body: Buffer.from(await response.arrayBuffer()),
  }
}

const STREAM_EVENT_BUFFER_LIMIT = 400

type StreamEventFrame = {
  method: string
  params: unknown
  atIso: string
}

type CapturedItem = {
  id: string
  type: string
  turnId: string
  data: Record<string, unknown>
  completed: boolean
}

const MERGEABLE_ITEM_TYPES = new Set([
  'commandExecution',
  'fileChange',
])

export class AppServerProcess {
  notifyAccountQuota(account: import('./accountAuthStore.js').StoredAccountEntry): void {
    this.emitNotification({ method: 'codexapp/accountQuota/updated', params: { account } })
  }
  private quotaReadFlight: { storageId: string | null; promise: Promise<{ payload: unknown; account: import('./accountAuthStore.js').StoredAccountEntry | null }> } | null = null
  private quotaReadCache: { storageId: string | null; at: number; result: { payload: unknown; account: import('./accountAuthStore.js').StoredAccountEntry | null } } | null = null
  private async readRuntimeQuota(storageId: string | null): Promise<{ payload: unknown; account: import('./accountAuthStore.js').StoredAccountEntry | null }> {
    const coordinator = getAccountAuthCoordinator()
    if (!this.runtimeOptions.isolatedTask && coordinator.blocksNewSubmissions()) throw new Error('账号正在切换，稍后读取额度')
    if (this.quotaReadFlight?.storageId === storageId) return boundedQuotaRead(this.quotaReadFlight.promise)
    if (this.quotaReadCache?.storageId === storageId && Date.now() - this.quotaReadCache.at < 2000) return this.quotaReadCache.result
    const revision = storageId ? coordinator.quotaRevision(storageId) : 0
    const promise = (async () => {
      const payload = await coordinator.readQuotaWithBackoff(storageId || 'runtime', () => this.call('account/rateLimits/read', null))
      const account = storageId ? await coordinator.applyRuntimeQuotaRead(storageId, payload, revision) : null
      const result = { payload, account }
      this.quotaReadCache = !storageId || revision === coordinator.quotaRevision(storageId) ? { storageId, at: Date.now(), result } : null
      return result
    })()
    this.quotaReadFlight = { storageId, promise }
    const clear = () => { if (this.quotaReadFlight?.promise === promise) this.quotaReadFlight = null }
    void promise.then(clear, clear)
    return boundedQuotaRead(promise)
  }
  quotaBlocked: (threadId: string, turnId: string) => Promise<void> = async () => {}
  notifyQuotaErrorIgnored(threadId: string): void { this.emitNotification({ method: 'thread/quotaErrorIgnored/changed', params: { threadId } }) }
  notifyQuotaResumeChanged(): void { this.emitNotification({ method: 'thread/quotaResume/changed', params: {} }) }
  async observeAccountQuota(payload: unknown): Promise<void> {
    this.quotaReadCache = null
    const coordinator = getAccountAuthCoordinator()
    const id = await this.runtimeAccountId()
    if (id && !getCustomConnectionStore().get(id)) await coordinator.observeRuntimeQuota(id, payload)
  }
  constructor(private readonly runtimeOptions: { isolatedTask?: boolean; requestIdOffset?: number } = {}) {
    this.nextId = runtimeOptions.requestIdOffset || 1
  }
  private runtimeStorageId: string | null = null
  private assignedStorageId: string | null = null
  private sessionOperations = 0
  private closingSession: Promise<void> | null = null
  private executionLease: AccountExecutionLease | null = null
  private taskLease: { runId: string; storageId: string | null; protected: boolean } | null = null
  private readonly acquiringAccounts = new Set<string>()
  // Native unsubscribe retains a writer for 30 minutes. A session therefore
  // keeps one process across chat and automation; credentials change only at
  // that session's boundary. Idle eviction closes the process and awaits exit.
  private readonly sessionWorkers = new AccountResourcePool<AppServerProcess>({
    capacity: 16,
    idle: async (worker, _key, scope) => {
      if (worker.currentTaskRun || worker.sessionOperations || worker.activeTurnThreadIds.size || worker.pendingServerRequests.size || worker.pending.size) return false
      if (!worker.process) return true
      const terminals = await threadsWithBackgroundTerminals((method, params) => worker.rpc(method, params, undefined, scope))
      return !terminals.length && !worker.currentTaskRun && !worker.sessionOperations && !worker.activeTurnThreadIds.size && !worker.pendingServerRequests.size && !worker.pending.size
    },
    dispose: worker => worker.closeSession(),
  })
  private readonly taskRuns = new Map<string, AppServerProcess>()
  private readonly taskPreparations = new Map<string, { scope: AutomationPreparation; worker?: AppServerProcess; owned: boolean; releaseRequested?: boolean }>()
  private readonly ownedThreadIds = new Set<string>()
  private nextWorkerId = 1
  private nextForwardedRequestId = -1
  private readonly forwardedRequests = new Map<number, { worker: AppServerProcess; nativeId: number }>()
  private currentTaskRun: string | null = null

  private threadWorker(threadId: string): AppServerProcess | undefined {
    if (!threadId) return undefined
    return [...this.sessionWorkers.values()].find(worker => worker.ownedThreadIds.has(threadId)) || this.sessionWorkers.get(threadId)
  }
  private runtimeAccountId(): Promise<string | null> {
    if (this.runtimeOptions.isolatedTask) return Promise.resolve(this.assignedStorageId)
    if (this.runtimeStorageId) return Promise.resolve(this.runtimeStorageId)
    return getAccountAuthCoordinator().store.readState().then(state => state.activeStorageId)
  }
  private async closeSession(): Promise<void> {
    this.dispose()
    await this.closingSession
  }
  private async sessionWorker(key: string, scope?: AutomationPreparation): Promise<AppServerProcess | null> {
    scope?.assertActive()
    const owned = this.threadWorker(key)
    if (owned) {
      // Touch the pool so an asynchronous idle check cannot evict this use.
      const entry = [...this.sessionWorkers].find(([, worker]) => worker === owned)!
      return this.sessionWorkers.getOrCreate(entry[0], () => owned, true, scope)
    }
    return this.sessionWorkers.getOrCreate(key, () => {
      const worker = new AppServerProcess({ isolatedTask: true, requestIdOffset: this.nextWorkerId++ * 1_000_000 })
      worker.queueStateReader = async () => ({})
      worker.quotaBlocked = (threadId, turnId) => this.quotaBlocked(threadId, turnId)
      worker.onNotification(notification => {
        if (notification.method === 'account/rateLimits/updated') void worker.observeAccountQuota(notification.params).catch(() => undefined)
        if (/^(account\/|codexapp\/runtime\/)/.test(notification.method)) return
        this.activityRevision++
        this.forwardTaskNotification(this.remapTaskRequest(worker, notification))
      })
      return worker
    }, true, scope)
  }
  private async configureSession(storageId: string | null, kind: 'primary' | 'automation', ownerId: string, scope?: AutomationPreparation): Promise<void> {
    scope?.assertActive()
    if (this.assignedStorageId !== storageId && (this.activeTurnThreadIds.size || this.pendingServerRequests.size)) {
      throw Object.assign(new Error('会话运行中，暂不能更换账号。'), { rpcRejected: true, submissionNotSent: true })
    }
    const coordinator = getAccountAuthCoordinator()
    const changed = this.assignedStorageId !== storageId
    const initialized = this.initialized
    const customChanged = changed && (!!getCustomConnectionStore().get(storageId) || !!getCustomConnectionStore().get(this.assignedStorageId))
    if (customChanged && this.process) await this.closeSession()
    scope?.assertActive()
    this.assignedStorageId = storageId
    this.executionLease?.release()
    this.executionLease = storageId ? coordinator.executions.register({ storageId, kind, ownerId, protected: this.taskLease?.protected, busy: !!this.currentTaskRun || !!this.activeTurnThreadIds.size, disconnect: () => this.dispose() }) : null
    const lease = this.executionLease
    try {
      await this.ensureInitialized(scope)
      scope?.assertActive()
      if (initialized && changed && !customChanged) {
        if (storageId) {
          const credential = scope ? await scope.read(() => coordinator.getApiCredential(storageId)) : await coordinator.getApiCredential(storageId)
          scope?.assertActive()
          await this.call('account/login/start', { type: 'chatgptAuthTokens', accessToken: credential.accessToken, chatgptAccountId: credential.accountId })
          scope?.assertActive()
        } else {
          await this.closeSession()
          scope?.assertActive()
          await this.ensureInitialized(scope)
        }
        this.quotaReadCache = null
      }
      lease?.assertCurrent()
    } catch (error) {
      if (!scope?.signal.aborted || error !== scope.signal.reason) this.dispose()
      throw error
    }
  }
  stopTaskRouting(): void {
    for (const worker of this.sessionWorkers.values()) worker.dispose()
    this.sessionWorkers.clear()
    this.taskRuns.clear()
    this.forwardedRequests.clear()
  }
  taskAccountBusy(): boolean { return !!this.currentTaskRun }

  beginTaskPreparation(runId: string, scope: AutomationPreparation): void {
    const entry = { scope, owned: false } as { scope: AutomationPreparation; worker?: AppServerProcess; owned: boolean; releaseRequested?: boolean }
    this.taskPreparations.set(runId, entry)
    scope.onCancel(async () => {
      const worker = entry.worker
      if (!entry.owned || !worker || worker.currentTaskRun !== runId
        || worker.activeTurnThreadIds.size || worker.pendingServerRequests.size || worker.sessionOperations) return
      await worker.closeOwnedPreparationProcess(scope)
    })
  }

  private async closeOwnedPreparationProcess(scope: AutomationPreparation): Promise<void> {
    if (this.activeTurnThreadIds.size || this.pendingServerRequests.size || this.sessionOperations) return
    for (const id of this.ownedThreadIds) scope.discardedThreadIds.add(id)
    // Keep the account busy until confirmed process exit, even though dispose()
    // normally releases a lease immediately for an explicit runtime shutdown.
    const lease = this.executionLease
    this.executionLease = null
    const process = this.process
    await this.closeSession()
    if (process && process.exitCode === null && process.signalCode === null) throw new Error('自动化准备进程尚未退出')
    lease?.release()
  }

  endTaskPreparation(runId: string): void {
    const entry = this.taskPreparations.get(runId)
    this.taskPreparations.delete(runId)
    if (entry?.releaseRequested) this.releaseTaskAccount(runId)
  }

  async acquireTaskAccount(runId: string, settings: import('../automationOptions.js').AutomationModelSettings & { targetThreadId?: string | null }, scope?: AutomationPreparation): Promise<boolean> {
    scope?.assertActive()
    if (this.taskRuns.has(runId)) return true
    if (this.taskRuns.size + this.acquiringAccounts.size >= 4 || this.acquiringAccounts.has(runId)) return false
    this.acquiringAccounts.add(runId)
    let worker: AppServerProcess | null = null
    try {
      const coordinator = getAccountAuthCoordinator()
      const state = scope ? await scope.read(() => coordinator.store.readState()) : await coordinator.store.readState()
      const config = settings.accountStorageId ? null : asRecord(asRecord(await this.rpc('config/read', {}, undefined, scope))?.config)
      const followsOtherProvider = !settings.accountStorageId && !settings.protected && config?.model_provider && config.model_provider !== 'openai'
      if (scope) await scope.read(() => getCustomConnectionStore().ready)
      else await getCustomConnectionStore().ready
      scope?.assertActive()
      const custom = settings.accountStorageId ? getCustomConnectionStore().get(settings.accountStorageId) : getCustomConnectionStore().active()
      if (custom && custom.wireApi !== 'responses') throw new Error('Codex 需要 Responses API')
      const storageId = custom?.storageId || (followsOtherProvider ? null : resolveAccountSelection(state, settings).storageId)
      if (coordinator.blocksApiAccount(settings.accountStorageId || null)) return false
      if (storageId && !custom) {
        if (scope) await scope.read(() => coordinator.getApiCredential(storageId))
        else await coordinator.getApiCredential(storageId)
        const account = scope ? await scope.read(() => coordinator.refreshAccount(storageId)) : await coordinator.refreshAccount(storageId)
        const fresh = account.quotaUpdatedAtIso && Date.now() - Date.parse(account.quotaUpdatedAtIso) < 30000
        const windows = [account.quotaSnapshot?.primary, account.quotaSnapshot?.secondary].filter(Boolean)
        if (fresh && windows.some(window => window!.usedPercent >= 100)) return false
        try {
          if (scope) await scope.read(() => coordinator.assertSubmissionAllowed(undefined, { storageId, protected: settings.protected }))
          else await coordinator.assertSubmissionAllowed(undefined, { storageId, protected: settings.protected })
        }
        catch { return false }
      }
      scope?.assertActive()
      worker = await this.sessionWorker(settings.targetThreadId || `run:${runId}`, scope)
      scope?.assertActive()
      if (!worker || worker.currentTaskRun || worker.sessionOperations || worker.activeTurnThreadIds.size || worker.pendingServerRequests.size) return false
      worker.taskLease = { runId, storageId, protected: settings.protected === true }
      worker.currentTaskRun = runId
      this.taskRuns.set(runId, worker)
      const preparation = this.taskPreparations.get(runId)
      if (preparation) {
        preparation.worker = worker
        preparation.owned = !settings.targetThreadId
      }
      await worker.configureSession(storageId, 'automation', runId, scope)
      scope?.assertActive()
      return true
    } catch (error) {
      this.releaseTaskAccount(runId)
      throw error
    } finally {
      this.acquiringAccounts.delete(runId)
    }
  }
  taskAccountStorageId(runId: string): string | null | undefined {
    return this.taskRuns.get(runId)?.assignedStorageId
  }
  releaseTaskAccount(runId: string): void {
    const preparation = this.taskPreparations.get(runId)
    if (preparation) {
      preparation.releaseRequested = true
      return
    }
    const worker = this.taskRuns.get(runId)
    if (!worker) return
    worker.currentTaskRun = null
    worker.taskLease = null
    worker.executionLease?.setBusy(!!worker.activeTurnThreadIds.size)
    this.taskRuns.delete(runId)
  }

  async automationRpc(method: string, params: unknown, runId?: string, preparationScope?: AutomationPreparation): Promise<unknown> {
    const scope = runId ? this.taskPreparations.get(runId)?.scope : preparationScope
    scope?.assertActive()
    const worker = runId ? this.taskRuns.get(runId) : this.threadWorker(readNonEmptyString(asRecord(params)?.threadId))
    if (!worker && runId) throw Object.assign(new Error('自动化账号连接已释放，本次操作未发送'), { rpcRejected: true, submissionNotSent: true })
    if (!worker) return this.rpc(method, params, undefined, scope)
    const input = worker.taskLease?.storageId && ['thread/start', 'thread/resume'].includes(method)
      ? { ...asRecord(params), modelProvider: getCustomConnectionStore().get(worker.taskLease.storageId) ? `custom_${worker.taskLease.storageId}` : 'openai' }
      : params
    return worker.rpc(method, input, worker.taskLease?.runId, scope)
  }
  private remapTaskRequest(worker: AppServerProcess, notification: { method: string; params: unknown }): { method: string; params: unknown } {
    const params = asRecord(notification.params)
    const nativeId = params?.id
    if (!['server/request', 'server/request/resolved'].includes(notification.method) || typeof nativeId !== 'number') return notification
    let id = [...this.forwardedRequests].find(([, entry]) => entry.worker === worker && entry.nativeId === nativeId)?.[0]
    if (notification.method === 'server/request' && id === undefined) {
      id = this.nextForwardedRequestId--
      this.forwardedRequests.set(id, { worker, nativeId })
    }
    if (id === undefined) return notification
    if (notification.method === 'server/request/resolved') this.forwardedRequests.delete(id)
    return { ...notification, params: { ...params, id } }
  }
  private forwardTaskNotification(notification: { method: string; params: unknown }): void {
    this.recordStreamEvent(notification)
    this.captureItemFromNotification(notification)
    const id = this.extractThreadIdFromParams(notification.params)
    if (id) this.invalidateLiveStateCache(id)
    for (const listener of this.notificationListeners) listener(notification)
  }

  accountDisconnected: (storageId: string, primary: boolean, runIds: string[]) => void = () => {}
  async disconnectAccount(storageId: string, wasActive = false): Promise<void> {
    const affected = [...this.sessionWorkers].filter(([, worker]) => worker.assignedStorageId === storageId)
    const runIds = [...this.taskRuns].filter(([, runtime]) => affected.some(([, worker]) => worker === runtime)).map(([id]) => id)
    for (const [key, worker] of affected) {
      worker.dispose()
      this.sessionWorkers.delete(key)
      for (const [id, request] of this.forwardedRequests) if (request.worker === worker) this.forwardedRequests.delete(id)
    }
    for (const id of runIds) this.taskRuns.delete(id)
    await Promise.all(affected.map(([, worker]) => worker.closeSession()))
    if (wasActive || this.runtimeStorageId === storageId) {
      this.dispose()
      this.runtimeStorageId = null
    }
    this.accountDisconnected(storageId, wasActive, runIds)
    this.forwardTaskNotification({ method: 'codexapp/account/removed', params: { storageId } })
  }

  async reloadAccount(storageId: string): Promise<void> {
    const credential = await getAccountAuthCoordinator().store.readCredential(storageId)
    await this.ensureInitialized()
    await this.call('account/login/start', { type: 'chatgptAuthTokens', accessToken: credential.auth.tokens!.access_token, chatgptAccountId: credential.identity.accountId })
    this.runtimeStorageId = storageId
    this.executionLease?.release()
    this.executionLease = getAccountAuthCoordinator().executions.register({ storageId, kind: 'primary', ownerId: 'primary', busy: this.activeTurnThreadIds.size > 0, disconnect: () => this.dispose() })
    this.quotaReadCache = null
    this.authRecovery.clear()
  }

  readonly authRecovery = new AuthRecoveryRegistry()
  automationActivity: () => string[] = () => []
  backgroundActivity: () => Promise<string[]> = async () => []
  queueStateReader: () => Promise<ThreadQueueState> = readLegacyThreadQueueState
  private process: ChildProcessWithoutNullStreams | null = null
  private initialized = false
  private initializePromise: Promise<void> | null = null
  private readBuffer = ''
  private nextId = 1
  private stopping = false
  private readonly pending = new Map<number, { method: string; resolve: (value: unknown) => void; reject: (reason?: unknown) => void }>()
  private readonly notificationListeners = new Set<(value: { method: string; params: unknown }) => void>()
  private readonly pendingServerRequests = new Map<number, PendingServerRequest>()
  private readonly streamEventsByThreadId = new Map<string, StreamEventFrame[]>()
  private readonly lastThreadReadSnapshotByThreadId = new Map<string, unknown>()
  private readonly capturedItemsByThreadId = new Map<string, Map<string, CapturedItem>>()
  private readonly liveStateCache = new Map<string, { data: unknown; turnCount: number; sessionSize: number }>()
  private chatgptAuthRefreshPromise: Promise<ChatgptAuthTokensRefreshResponse> | null = null
  private readonly activeTurnThreadIds = new Set<string>()
  private readonly activeTurnIds = new Map<string, string>()
  private readonly terminalTurnIds = new Set<string>()
  private readonly accountFailureInterrupts = new Set<string>()
  private activityRevision = 0
  private activeConfigSignature = ''


  private getCodexCommand(): string {
    const codexCommand = resolveCodexCommand()
    if (!codexCommand) {
      throw new Error('Codex CLI is not available. Install @openai/codex or set CODEXUI_CODEX_COMMAND.')
    }
    return codexCommand
  }

  private buildAppServerConfig(): { args: string[]; env: Record<string, string> } {
    const args = buildAppServerArgs()
    const connections = getCustomConnectionStore()
    const custom = this.runtimeOptions.isolatedTask ? connections.get(this.assignedStorageId) : undefined
    if (custom) {
      const config = customRuntimeConfig(custom, Number(process.env.CODEXUI_SERVER_PORT) || 4173)
      return { args: [...args, ...config.args], env: config.env }
    }
    if ((!this.runtimeOptions.isolatedTask && connections.explicitSelection()) || (this.runtimeOptions.isolatedTask && this.assignedStorageId)) {
      args.push('-c', 'model_provider="openai"')
      return { args, env: {} }
    }
    let extraEnv: Record<string, string> = {}
    const serverPort = parseInt(process.env.CODEXUI_SERVER_PORT ?? '', 10) || undefined
    args.push(...getProviderCompatibilityConfigArgs(serverPort))
    const statePath = join(getCodexHomeDir(), FREE_MODE_STATE_FILE)
    try {
      const state = ensureDefaultFreeModeStateForMissingAuthSync(statePath)
      if (state) {
        args.push(...getFreeModeConfigArgs(state, serverPort))
        extraEnv = getFreeModeEnvVars(state)
      }
    } catch {
      // No free-mode state or invalid — use defaults
    }
    return { args, env: extraEnv }
  }

  private async withRuntimeThreadProvider(params: unknown): Promise<Record<string, unknown>> {
    const input = asRecord(params) ?? {}
    const custom = this.runtimeOptions.isolatedTask ? getCustomConnectionStore().get(this.assignedStorageId) : undefined
    if (custom) return { ...input, modelProvider: `custom_${custom.storageId}` }
    const result = asRecord(await this.call('config/read', {}))
    const config = asRecord(result?.config)
    // Resume/fork otherwise inherit the rollout's provider, which may only
    // exist in a previous custom worker. Use this worker's selected outlet;
    // do not register other providers or mutate the global account selection.
    return { ...input, modelProvider: readNonEmptyString(config?.model_provider) || 'openai' }
  }

  private getAppServerConfigSignature(config: { args: string[]; env: Record<string, string> }): string {
    return JSON.stringify({
      args: config.args,
      env: Object.keys(config.env)
        .sort()
        .map((key) => [key, config.env[key]]),
    })
  }

  private disposeIfConfigChanged(): void {
    if (!this.process) return
    const config = this.buildAppServerConfig()
    const nextSignature = this.getAppServerConfigSignature(config)
    if (this.activeConfigSignature === nextSignature) return
    this.dispose()
  }

  private start(): void {
    if (this.process) return

    this.stopping = false
    const config = this.buildAppServerConfig()
    this.activeConfigSignature = this.getAppServerConfigSignature(config)
    const invocation = getSpawnInvocation(this.getCodexCommand(), config.args)
    const spawnEnv = Object.keys(config.env).length > 0
      ? { ...process.env, ...config.env }
      : undefined
    const proc = spawn(invocation.command, invocation.args, { stdio: ['pipe', 'pipe', 'pipe'], ...(spawnEnv ? { env: spawnEnv } : {}) })
    this.process = proc

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      this.readBuffer += chunk

      let lineEnd = this.readBuffer.indexOf('\n')
      while (lineEnd !== -1) {
        const line = this.readBuffer.slice(0, lineEnd).trim()
        this.readBuffer = this.readBuffer.slice(lineEnd + 1)

        if (line.length > 0) {
          this.handleLine(line)
        }

        lineEnd = this.readBuffer.indexOf('\n')
      }
    })

    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', () => {
      // Keep stderr silent in dev middleware; JSON-RPC errors are forwarded via responses.
    })

    proc.on('exit', () => {
      if (this.process !== proc) {
        return
      }

      const failure = new Error(this.stopping ? 'codex app-server stopped' : 'codex app-server exited unexpectedly')
      for (const request of this.pending.values()) {
        request.reject(failure)
      }

      this.pending.clear()
      this.pendingServerRequests.clear()
      this.process = null
      this.initialized = false
      this.initializePromise = null
      this.readBuffer = ''
      this.emitNotification({ method: 'codexapp/runtime/stopped', params: {} })
    })
  }

  private sendLine(payload: Record<string, unknown>): void {
    if (!this.process) {
      throw new Error('codex app-server is not running')
    }

    this.process.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse
    try {
      message = JSON.parse(line) as JsonRpcResponse
    } catch {
      return
    }

    if (typeof message.id === 'number' && !message.method && this.pending.has(message.id)) {
      const pendingRequest = this.pending.get(message.id)
      this.pending.delete(message.id)

      if (!pendingRequest) return

      if (message.error) {
        pendingRequest.reject(Object.assign(new Error(message.error.message), { rpcRejected: true, data: (message.error as { data?: unknown }).data }))
      } else {
        pendingRequest.resolve(message.result)
      }
      return
    }

    if (typeof message.method === 'string' && typeof message.id !== 'number') {
      this.emitNotification({
        method: message.method,
        params: message.params ?? null,
      })
      return
    }

    // Handle server-initiated JSON-RPC requests (approvals, dynamic tool calls, etc.).
    if (typeof message.id === 'number' && typeof message.method === 'string') {
      this.handleServerRequest(message.id, message.method, message.params ?? null)
    }
  }

  private ignoredErrorMarks: IgnoredQuotaErrors | null = null
  get ignoredErrors(): IgnoredQuotaErrors {
    return this.ignoredErrorMarks ??= new IgnoredQuotaErrors(getCodexHomeDir())
  }

  private interruptionList: ThreadInterruptionList | null = null
  get interruptions(): ThreadInterruptionList {
    return this.interruptionList ??= new ThreadInterruptionList(getCodexHomeDir(), this.ignoredErrors, (threadId, issues) => {
      for (const listener of this.notificationListeners) {
        listener({ method: 'codexapp/interruptions/changed', params: { threadId, issues } })
      }
    })
  }

  private completionList: ThreadCompletionList | null = null
  get completions(): ThreadCompletionList {
    return this.completionList ??= new ThreadCompletionList(join(getCodexHomeDir(), 'codexapp-thread-completions-v1.json'), (threadId, token) => {
      for (const listener of this.notificationListeners) {
        listener({ method: 'codexapp/completions/changed', params: { threadId, token } })
      }
    })
  }

  notifyQueueChanged(threadId: string): void {
    this.activityRevision++
    // Queue changes do not invalidate thread history or live item caches.
    for (const listener of this.notificationListeners) {
      listener({ method: 'codexapp/queue/changed', params: { threadId } })
    }
  }

  private emitNotification(notification: { method: string; params: unknown }): void {
    if (/^(turn\/(started|completed|cancelled)|thread\/(started|status\/changed|goal\/updated)|server\/request(?:\/resolved)?|codexapp\/runtime\/stopped)$/.test(notification.method)) {
      this.activityRevision++
    }
    this.authRecovery.observe(notification.method, notification.params)
    if (notification.method === 'error') {
      const payload = asRecord(notification.params)
      const error = asRecord(payload?.error)
      const detail = JSON.stringify([error?.message, error?.codexErrorInfo])
      const threadId = this.extractThreadIdFromParams(notification.params)
      const turnId = readNonEmptyString(payload?.turnId) || this.activeTurnIds.get(threadId)
      if (threadId && turnId && /usage.?limit|quota|rate.?limit|429|额度|限额|token_revoked|invalid_grant|authentication|unauthorized|\b401\b/i.test(detail) && !this.accountFailureInterrupts.has(turnId)) {
        this.accountFailureInterrupts.add(turnId)
        if (/usage.?limit|quota|rate.?limit|429|额度|限额/i.test(detail)) void this.quotaBlocked(threadId, turnId).catch(() => undefined)
        void this.call('turn/interrupt', { threadId, turnId }).catch(() => undefined)
      }
    }
    const notificationThreadId = this.extractThreadIdFromParams(notification.params)
    if (notificationThreadId && this.runtimeOptions.isolatedTask && notification.method === 'thread/started') this.ownedThreadIds.add(notificationThreadId)
    if (notificationThreadId && notification.method === 'turn/started') {
      this.executionLease?.setBusy(true)
      this.activeTurnThreadIds.add(notificationThreadId)
      const params = asRecord(notification.params)
      const turnId = readNonEmptyString(asRecord(params?.turn)?.id) || readNonEmptyString(params?.turnId)
      if (turnId) this.activeTurnIds.set(notificationThreadId, turnId)
    }
    if (notificationThreadId && (notification.method === 'turn/completed' || notification.method === 'turn/cancelled')) {
      const finishedTurnId = readNonEmptyString(asRecord(asRecord(notification.params)?.turn)?.id) || this.activeTurnIds.get(notificationThreadId)
      if (finishedTurnId) {
        this.terminalTurnIds.add(finishedTurnId)
        if (this.terminalTurnIds.size > 256) this.terminalTurnIds.delete(this.terminalTurnIds.values().next().value!)
      }
      if (finishedTurnId) this.accountFailureInterrupts.delete(finishedTurnId)
      this.activeTurnThreadIds.delete(notificationThreadId)
      this.activeTurnIds.delete(notificationThreadId)
      this.executionLease?.setBusy(this.activeTurnThreadIds.size > 0)
    }
    this.recordStreamEvent(notification)
    this.captureItemFromNotification(notification)
    const nThreadId = this.extractThreadIdFromParams(notification.params)
    if (nThreadId) {
      this.invalidateLiveStateCache(nThreadId)
    }
    for (const listener of this.notificationListeners) {
      listener(notification)
    }
  }

  private extractThreadIdFromParams(params: unknown): string {
    const record = asRecord(params)
    if (!record) return ''
    const threadId =
      (typeof record.threadId === 'string' ? record.threadId : '') ||
      (typeof record.thread_id === 'string' ? record.thread_id : '') ||
      (typeof record.conversationId === 'string' ? record.conversationId : '') ||
      (typeof record.conversation_id === 'string' ? record.conversation_id : '')
    if (threadId) return threadId
    const thread = asRecord(record.thread)
    if (thread && typeof thread.id === 'string') return thread.id
    const turn = asRecord(record.turn)
    if (turn) {
      const turnThreadId =
        (typeof turn.threadId === 'string' ? turn.threadId : '') ||
        (typeof turn.thread_id === 'string' ? turn.thread_id : '')
      if (turnThreadId) return turnThreadId
    }
    return ''
  }

  private recordStreamEvent(notification: { method: string; params: unknown }): void {
    const threadId = this.extractThreadIdFromParams(notification.params)
    if (!threadId) return
    const frame: StreamEventFrame = {
      method: notification.method,
      params: notification.params,
      atIso: new Date().toISOString(),
    }
    let buffer = this.streamEventsByThreadId.get(threadId)
    if (!buffer) {
      buffer = []
      this.streamEventsByThreadId.set(threadId, buffer)
    }
    buffer.push(frame)
    if (buffer.length > STREAM_EVENT_BUFFER_LIMIT) {
      buffer.splice(0, buffer.length - STREAM_EVENT_BUFFER_LIMIT)
    }
  }

  getStreamEvents(threadId: string, limit: number): StreamEventFrame[] {
    const buffer = this.streamEventsByThreadId.get(threadId)
    if (!buffer || buffer.length === 0) return []
    return buffer.slice(-limit)
  }

  storeThreadReadSnapshot(threadId: string, snapshot: unknown): void {
    this.lastThreadReadSnapshotByThreadId.set(threadId, snapshot)
  }

  getLastThreadReadSnapshot(threadId: string): unknown | null {
    return this.lastThreadReadSnapshotByThreadId.get(threadId) ?? null
  }

  cacheLiveState(threadId: string, data: unknown, turnCount: number, sessionSize: number): void {
    this.liveStateCache.set(threadId, { data, turnCount, sessionSize })
  }

  getCachedLiveState(threadId: string, turnCount: number, sessionSize: number): unknown | null {
    const cached = this.liveStateCache.get(threadId)
    if (!cached) return null
    if (cached.turnCount !== turnCount || cached.sessionSize !== sessionSize) return null
    return cached.data
  }

  invalidateLiveStateCache(threadId: string): void {
    this.liveStateCache.delete(threadId)
  }

  private captureItemFromNotification(notification: { method: string; params: unknown }): void {
    if (notification.method !== 'item/started' && notification.method !== 'item/completed') return

    const params = asRecord(notification.params)
    if (!params) return
    const item = asRecord(params.item)
    if (!item) return
    const itemType = typeof item.type === 'string' ? item.type : ''
    if (!MERGEABLE_ITEM_TYPES.has(itemType)) return

    const itemId = typeof item.id === 'string' ? item.id : ''
    if (!itemId) return

    const threadId = this.extractThreadIdFromParams(params)
    if (!threadId) return

    const turnId =
      (typeof params.turnId === 'string' ? params.turnId : '') ||
      (typeof params.turn_id === 'string' ? params.turn_id : '')
    if (!turnId) return

    let threadItems = this.capturedItemsByThreadId.get(threadId)
    if (!threadItems) {
      threadItems = new Map()
      this.capturedItemsByThreadId.set(threadId, threadItems)
    }

    const isCompleted = notification.method === 'item/completed'
    const existing = threadItems.get(itemId)

    if (existing && existing.completed && !isCompleted) return

    threadItems.set(itemId, {
      id: itemId,
      type: itemType,
      turnId,
      data: item as Record<string, unknown>,
      completed: isCompleted,
    })
  }

  mergeItemsIntoTurns(threadId: string, turns: unknown[]): unknown[] {
    const capturedMap = this.capturedItemsByThreadId.get(threadId)
    if (!capturedMap || capturedMap.size === 0) return turns

    const itemsByTurnId = new Map<string, CapturedItem[]>()
    for (const captured of capturedMap.values()) {
      let group = itemsByTurnId.get(captured.turnId)
      if (!group) {
        group = []
        itemsByTurnId.set(captured.turnId, group)
      }
      group.push(captured)
    }

    return turns.map((turn) => {
      const turnRecord = asRecord(turn)
      if (!turnRecord) return turn
      const turnId = typeof turnRecord.id === 'string' ? turnRecord.id : ''
      if (!turnId) return turn

      const captured = itemsByTurnId.get(turnId)
      if (!captured || captured.length === 0) return turn

      const existingItems = Array.isArray(turnRecord.items) ? (turnRecord.items as Record<string, unknown>[]) : []
      const existingIds = new Set(existingItems.map((it) => (typeof it.id === 'string' ? it.id : '')).filter(Boolean))

      const newItems = captured
        .filter((c) => !existingIds.has(c.id))
        .map((c) => c.data)

      if (newItems.length === 0) return turn

      return {
        ...turnRecord,
        items: [...existingItems, ...newItems],
      }
    })
  }

  private sendServerRequestReply(requestId: number, reply: ServerRequestReply): void {
    if (reply.error) {
      this.sendLine({
        jsonrpc: '2.0',
        id: requestId,
        error: reply.error,
      })
      return
    }

    this.sendLine({
      jsonrpc: '2.0',
      id: requestId,
      result: reply.result ?? {},
    })
  }

  private resolvePendingServerRequest(requestId: number, reply: ServerRequestReply): void {
    const pendingRequest = this.pendingServerRequests.get(requestId)
    if (!pendingRequest) {
      throw new Error(`No pending server request found for id ${String(requestId)}`)
    }
    this.pendingServerRequests.delete(requestId)

    this.sendServerRequestReply(requestId, reply)
    const requestParams = asRecord(pendingRequest.params)
    const threadId =
      typeof requestParams?.threadId === 'string' && requestParams.threadId.length > 0
        ? requestParams.threadId
        : ''
    this.emitNotification({
      method: 'server/request/resolved',
      params: {
        id: requestId,
        method: pendingRequest.method,
        threadId,
        mode: 'manual',
        resolvedAtIso: new Date().toISOString(),
      },
    })
  }

  private async refreshChatgptAuthTokens(params: ChatgptAuthTokensRefreshParams): Promise<ChatgptAuthTokensRefreshResponse> {
    const storageId = await this.runtimeAccountId()
    if (storageId) {
      const credential = await getAccountAuthCoordinator().refreshTokensForStorage(storageId, params)
      return credential
    }
    if (!this.chatgptAuthRefreshPromise) {
      this.chatgptAuthRefreshPromise = refreshChatgptAuthTokensForExternalAuth(params).finally(() => {
        this.chatgptAuthRefreshPromise = null
      })
    }
    return await this.chatgptAuthRefreshPromise
  }

  private async handleChatgptAuthTokensRefreshRequest(requestId: number, params: unknown): Promise<void> {
    const requestParams = asRecord(params)
    const previousAccountId = readNonEmptyString(requestParams?.previousAccountId ?? requestParams?.previous_account_id)
    const process = this.process
    const storageId = await this.runtimeAccountId()
    try {
      const result = await this.refreshChatgptAuthTokens({
        reason: readNonEmptyString(requestParams?.reason) || undefined,
        previousAccountId: previousAccountId || undefined,
      })
      if (this.process !== process || await this.runtimeAccountId() !== storageId) throw new Error('账号连接已变更，请重新核对认证')
      this.sendServerRequestReply(requestId, { result })
      this.emitNotification({
        method: 'server/request/resolved',
        params: {
          id: requestId,
          method: 'account/chatgptAuthTokens/refresh',
          mode: 'automatic',
          resolvedAtIso: new Date().toISOString(),
        },
      })
    } catch (error) {
      this.sendServerRequestReply(requestId, {
        error: {
          code: -32001,
          message: getErrorMessage(error, 'Failed to refresh ChatGPT auth tokens'),
        },
      })
    }
  }

  private handleServerRequest(requestId: number, method: string, params: unknown): void {
    if (method === 'account/chatgptAuthTokens/refresh') {
      void this.handleChatgptAuthTokensRefreshRequest(requestId, params)
      return
    }

    const pendingRequest: PendingServerRequest = {
      id: requestId,
      method,
      params,
      receivedAtIso: new Date().toISOString(),
    }
    this.pendingServerRequests.set(requestId, pendingRequest)

    this.emitNotification({
      method: 'server/request',
      params: pendingRequest,
    })
  }

  private async call(method: string, params: unknown): Promise<unknown> {
    this.start()
    const id = this.nextId++

    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject })

      this.sendLine({
        jsonrpc: '2.0',
        id,
        method,
        params,
      } satisfies JsonRpcCall)
    })
  }

  private readonly preparationReads = new Map<string, Promise<unknown>>()
  private async readForPreparation(method: string, params: unknown, scope: AutomationPreparation): Promise<unknown> {
    scope.assertActive()
    const key = JSON.stringify([method, params])
    let read = this.preparationReads.get(key)
    if (!read) {
      if (this.preparationReads.size >= 4) throw new Error('准备状态读取超时，仍有读取等待上游返回')
      const flight = this.call(method, params).finally(() => {
        if (this.preparationReads.get(key) === flight) this.preparationReads.delete(key)
      })
      this.preparationReads.set(key, flight)
      void flight.catch(() => {})
      read = flight
    }
    // Cancellation ends this caller's wait, not the native RPC's lifetime.
    // Keep its actual pending slot and share retries until the response/exit.
    return scope.read(() => read!)
  }

  private async ensureInitialized(scope?: AutomationPreparation): Promise<void> {
    if (scope) await scope.read(() => getCustomConnectionStore().ready)
    else await getCustomConnectionStore().ready
    if (this.closingSession) await this.closingSession
    scope?.assertActive()
    if (this.initialized) return
    if (this.initializePromise) {
      await this.initializePromise
      return
    }

    // Only a newly started process belongs to this preparation. An existing
    // shared initialization completes under its original ownership.
    const initializationScope = !this.process ? scope : undefined

    const initialization = this.call('initialize', {
      clientInfo: {
        name: 'codex-web-local',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    }).then(async () => {
      initializationScope?.assertActive()
      this.sendLine({
        jsonrpc: '2.0',
        method: 'initialized',
      })
      if (this.runtimeOptions.isolatedTask && this.assignedStorageId && !getCustomConnectionStore().get(this.assignedStorageId)) {
        const credential = initializationScope
          ? await initializationScope.read(() => getAccountAuthCoordinator().getApiCredential(this.assignedStorageId!))
          : await getAccountAuthCoordinator().getApiCredential(this.assignedStorageId)
        initializationScope?.assertActive()
        await this.call('account/login/start', { type: 'chatgptAuthTokens', accessToken: credential.accessToken, chatgptAccountId: credential.accountId })
      }
      initializationScope?.assertActive()
      if (this.runtimeOptions.isolatedTask && this.assignedStorageId && !this.executionLease) {
        this.executionLease = getAccountAuthCoordinator().executions.register({ storageId: this.assignedStorageId, kind: this.currentTaskRun ? 'automation' : 'primary', ownerId: this.currentTaskRun || [...this.ownedThreadIds][0] || 'session', busy: !!this.currentTaskRun, disconnect: () => this.dispose() })
      }
      if (!this.runtimeOptions.isolatedTask) {
        const storageId = await this.runtimeAccountId()
        if (storageId && !getCustomConnectionStore().get(storageId)) {
          this.runtimeStorageId = storageId
          const credential = await getAccountAuthCoordinator().store.readCredential(storageId)
          // All ChatGPT runtimes delegate token rotation to the same coordinator.
          // Local token login does not wait for quota or a remote refresh.
          await this.call('account/login/start', { type: 'chatgptAuthTokens', accessToken: credential.auth.tokens!.access_token, chatgptAccountId: credential.identity.accountId })
          this.executionLease?.release()
          this.executionLease = getAccountAuthCoordinator().executions.register({ storageId, kind: 'primary', ownerId: 'primary', busy: false, disconnect: () => this.dispose() })
        }
      }
      this.initialized = true
      void Promise.resolve().then(async () => {
        const coordinator = getAccountAuthCoordinator()
        const storageId = await this.runtimeAccountId()
        if (storageId && !getCustomConnectionStore().get(storageId) && this.initialized && this.process) await this.readRuntimeQuota(storageId)
      }).catch(() => undefined)
    }).finally(() => {
      if (this.initializePromise === initialization) this.initializePromise = null
    })
    this.initializePromise = initialization
    const process = this.process
    initializationScope?.onCancel(async () => {
      if (this.process === process) await this.closeOwnedPreparationProcess(initializationScope)
    })
    await initialization
  }

  async rpc(method: string, params: unknown, taskId?: string, scope?: AutomationPreparation): Promise<unknown> {
    scope?.assertActive()
    const coordinator = getAccountAuthCoordinator()
    const threadId = readNonEmptyString(asRecord(params)?.threadId)
    const mutatingTurn = ['turn/start', 'turn/steer', 'thread/compact/start', 'thread/goal/set'].includes(method)
    if (mutatingTurn && this.taskAccountBusy() && taskId !== this.taskLease?.runId) {
      throw Object.assign(new Error('该会话正在执行自动化，请等待本次运行结束'), { rpcRejected: true, submissionNotSent: true })
    }
    if (!this.runtimeOptions.isolatedTask) {
      coordinator.runtimeQuotaReader = async storageId => {
        const candidates = [this, ...this.sessionWorkers.values()]
        for (const candidate of candidates) {
          if (candidate.initialized && await candidate.runtimeAccountId() === storageId) return (await candidate.readRuntimeQuota(storageId)).account
        }
        return null
      }
      coordinator.activeUsageAccounts = async () => {
        const ids = await Promise.all([this, ...this.sessionWorkers.values()].filter(candidate => candidate.activeTurnThreadIds.size).map(candidate => candidate.runtimeAccountId()))
        return [...new Set(ids.filter((id): id is string => !!id))]
      }
      coordinator.setProtectionInterrupt(async storageId => {
        for (const candidate of [this, ...this.sessionWorkers.values()]) {
          if (await candidate.runtimeAccountId() !== storageId || candidate.taskLease?.protected || !candidate.activeTurnThreadIds.size) continue
          const config = asRecord(asRecord(await candidate.call('config/read', {}))?.config)
          if (config?.model_provider && config.model_provider !== 'openai') continue
          for (const [id, turnId] of candidate.activeTurnIds) {
            if (candidate === this) void this.quotaBlocked(id, turnId).catch(() => undefined)
            await candidate.call('turn/interrupt', { threadId: id, turnId }).catch(() => undefined)
          }
        }
      })
    }
    if (!this.runtimeOptions.isolatedTask) {
      if (method === 'thread/loaded/list') {
        const ids = new Set<string>()
        for (const worker of this.sessionWorkers.values()) {
          if (!worker.process) continue
          const loaded = asRecord(await worker.rpc(method, params))
          for (const id of Array.isArray(loaded?.data) ? loaded.data : []) if (typeof id === 'string') ids.add(id)
        }
        return { data: [...ids], nextCursor: null }
      }
      const owner = this.threadWorker(threadId)
      if (owner || (mutatingTurn && threadId) || ['thread/start', 'thread/resume', 'thread/fork'].includes(method)) {
        const worker = await this.sessionWorker(method === 'thread/start' || method === 'thread/fork' ? `chat:${randomUUID()}` : threadId, scope)
        scope?.assertActive()
        if (!worker) throw Object.assign(new Error('会话运行资源已满，请先结束一个活动会话后重试'), { rpcRejected: true, submissionNotSent: true })
        const selectsAccount = mutatingTurn || ['thread/start', 'thread/resume', 'thread/fork'].includes(method)
        if (selectsAccount) worker.sessionOperations++
        try {
          if (!worker.currentTaskRun && selectsAccount) {
            const state = await coordinator.store.readState()
            const config = asRecord(asRecord(await this.rpc('config/read', {}))?.config)
            const storageId = getCustomConnectionStore().active()?.storageId || (config?.model_provider && config.model_provider !== 'openai' ? null : state.activeStorageId)
            await worker.configureSession(storageId, 'primary', threadId || 'new-thread')
          }
          const input = worker.currentTaskRun && method === 'thread/resume'
            ? { threadId, excludeTurns: asRecord(params)?.excludeTurns === true }
            : params
          return await worker.rpc(method, input, taskId, scope)
        } finally {
          if (selectsAccount) worker.sessionOperations--
        }
      }
    }
    this.disposeIfConfigChanged()
    if (scope && !taskId) await scope.read(() => this.ensureInitialized())
    else await this.ensureInitialized(scope)
    scope?.assertActive()
    const customConnection = this.runtimeOptions.isolatedTask ? getCustomConnectionStore().get(this.assignedStorageId) : undefined
    const selectedCustom = getCustomConnectionStore().active()
    if (!this.runtimeOptions.isolatedTask && selectedCustom && method === 'model/list') return { data: customConnectionModels({ ...selectedCustom, hasApiKey: true }), nextCursor: null }
    if (customConnection && method === 'model/list') return { data: customConnectionModels({ ...customConnection, hasApiKey: true }), nextCursor: null }
    if (customConnection && method === 'account/rateLimits/read') return null
    if (method === 'account/rateLimits/read') {
      const storageId = await this.runtimeAccountId()
      return (await this.readRuntimeQuota(storageId)).payload
    }
    if (mutatingTurn && !customConnection) {
      await getAccountAuthCoordinator().assertSubmissionAllowed(async () => {
        const result = asRecord(await this.call('config/read', {}))
        const config = asRecord(result?.config)
        return !config?.model_provider || config.model_provider === 'openai'
      }, this.runtimeOptions.isolatedTask ? { storageId: this.assignedStorageId || undefined, protected: !!taskId && this.taskLease?.protected === true } : undefined).catch(error => {
        throw Object.assign(error instanceof Error ? error : new Error('额度校验失败'), { rpcRejected: true, submissionNotSent: true })
      })
    }
    if (this.runtimeOptions.isolatedTask && mutatingTurn && threadId && !this.ownedThreadIds.has(threadId)) {
      const resumeParams = await this.withRuntimeThreadProvider({
        threadId,
        excludeTurns: true,
        ...(customConnection ? { model: customConnection.model } : {}),
      })
      await this.call('thread/resume', resumeParams)
      this.ownedThreadIds.add(threadId)
    }
    if (method === 'thread/resume' || method === 'thread/fork') {
      params = await this.withRuntimeThreadProvider(params)
    } else if (customConnection && method === 'thread/start') {
      params = { ...asRecord(params), modelProvider: `custom_${customConnection.storageId}` }
    }
    if (customConnection && mutatingTurn) {
      const input = { ...asRecord(params) }
      const capability = customConnection.models.find(model => model.id === input.model) || customConnection.models.find(model => model.id === customConnection.model)
      if (!capability?.efforts?.length) {
        delete input.effort
        if (input.collaborationMode) {
          const mode = asRecord(input.collaborationMode)
          input.collaborationMode = { ...mode, settings: { ...asRecord(mode?.settings), reasoning_effort: null } }
        }
      }
      if (!capability?.serviceTiers?.length) delete input.serviceTier
      params = input
    }
    scope?.assertActive()
    const result = scope && ['config/read', 'thread/read', 'thread/backgroundTerminals/list'].includes(method)
      ? await this.readForPreparation(method, params, scope)
      : await this.call(method, params)
    scope?.assertActive()
    if (!this.runtimeOptions.isolatedTask && selectedCustom && method === 'config/read') {
      const response = asRecord(result)
      const config = asRecord(response?.config)
      const provider = `custom_${selectedCustom.storageId}`
      return { ...response, config: { ...config, model: selectedCustom.model, model_provider: provider,
        model_reasoning_effort: selectedCustom.models.find(model => model.id === selectedCustom.model)?.defaultEffort || null,
        model_providers: { ...asRecord(config?.model_providers), [provider]: { base_url: selectedCustom.baseUrl, wire_api: selectedCustom.wireApi } },
      } }
    }
    if (method === 'turn/start' && threadId) {
      const turn = asRecord(asRecord(result)?.turn)
      const turnId = readNonEmptyString(turn?.id)
      if (turnId && !this.terminalTurnIds.has(turnId) && !['completed', 'failed', 'interrupted'].includes(String(turn?.status))) {
        this.activeTurnThreadIds.add(threadId)
        this.activeTurnIds.set(threadId, turnId)
        this.executionLease?.setBusy(true)
      }
    }
    if (!this.runtimeOptions.isolatedTask && method === 'thread/list') {
      const response = asRecord(result)
      if (Array.isArray(response?.data)) {
        return { ...response, data: response.data.map(value => {
          const thread = asRecord(value)
          const id = readNonEmptyString(thread?.id)
          const owner = this.threadWorker(id)
          if (!owner?.process || !owner.ownedThreadIds.has(id)) return value
          // The catalog process sees other processes' threads as notLoaded.
          // Surface the actual owner so UI and deployment checks see live work.
          return { ...thread, status: owner.activeTurnThreadIds.has(id) ? { type: 'active', activeFlags: [] } : { type: 'idle' } }
        }) }
      }
    }
    if (['thread/start', 'thread/resume', 'thread/fork'].includes(method)) {
      const id = readNonEmptyString(asRecord(asRecord(result)?.thread)?.id) || threadId
      if (id) this.ownedThreadIds.add(id)
    }
    if (method === 'thread/archive' || (method === 'thread/unsubscribe' && asRecord(result)?.status === 'notLoaded')) this.ownedThreadIds.delete(threadId)
    return result
  }

  onNotification(listener: (value: { method: string; params: unknown }) => void): () => void {
    this.notificationListeners.add(listener)
    return () => {
      this.notificationListeners.delete(listener)
    }
  }

  async respondToServerRequest(payload: unknown): Promise<void> {
    const body = asRecord(payload)
    if (!body) {
      throw new Error('Invalid response payload: expected object')
    }

    const id = body.id
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      throw new Error('Invalid response payload: "id" must be an integer')
    }

    const forwarded = this.forwardedRequests.get(id)
    if (forwarded) return forwarded.worker.respondToServerRequest({ ...body, id: forwarded.nativeId })
    await this.ensureInitialized()

    const rawError = asRecord(body.error)
    if (rawError) {
      const message = typeof rawError.message === 'string' && rawError.message.trim().length > 0
        ? rawError.message.trim()
        : 'Server request rejected by client'
      const code = typeof rawError.code === 'number' && Number.isFinite(rawError.code)
        ? Math.trunc(rawError.code)
        : -32000
      this.resolvePendingServerRequest(id, { error: { code, message } })
      return
    }

    if (!('result' in body)) {
      throw new Error('Invalid response payload: expected "result" or "error"')
    }

    this.resolvePendingServerRequest(id, { result: body.result })
  }

  listPendingServerRequests(): PendingServerRequest[] {
    const taskRequests = [...this.forwardedRequests].flatMap(([id, request]) => {
      const native = request.worker.pendingServerRequests.get(request.nativeId)
      return native ? [{ ...native, id }] : []
    })
    return [...this.pendingServerRequests.values(), ...taskRequests]
  }

  liveActivity(): { activeTurnThreadIds: string[]; pendingOperationCount: number } {
    const runtimes = [this, ...this.sessionWorkers.values()]
    return {
      activeTurnThreadIds: [...new Set(runtimes.flatMap(runtime => [...runtime.activeTurnThreadIds]))],
      pendingOperationCount: runtimes.reduce((count, runtime) => count + runtime.sessionOperations + [...runtime.pending.values()].filter(request => /^(?:turn\/(?:start|steer|interrupt)|thread\/(?:start|resume|fork|compact\/start|goal\/set|settings\/update))$/.test(request.method)).length, 0),
    }
  }

  async getAccountSwitchSnapshot(): Promise<RuntimeQuiescenceSnapshot> {
    return this.getRuntimeQuiescenceSnapshot(false, true)
  }

  async getRuntimeQuiescenceSnapshot(ignoreTaskAcquisition = false, accountSwitch = false): Promise<RuntimeQuiescenceSnapshot> {
    const activityRevision = this.activityRevision
    const runtimes = [this, ...this.sessionWorkers.values()].filter(worker => !accountSwitch || !worker.currentTaskRun)
    const activeTurnThreadIds = new Set(runtimes.flatMap(worker => [...worker.activeTurnThreadIds]))
    if (accountSwitch) {
      // Account switching depends on live session owners, not the number of
      // historical threads or archived/incomplete records in the catalog.
      for (const runtime of runtimes) {
        for (const threadId of [...runtime.activeTurnThreadIds]) {
          const response = asRecord(await runtime.rpc('thread/read', { threadId, includeTurns: false }))
          const thread = asRecord(response?.thread)
          const status = readNonEmptyString(asRecord(thread?.status)?.type) || readNonEmptyString(thread?.status)
          if (['idle', 'notLoaded', 'systemError', 'completed', 'interrupted', 'failed'].includes(status)) {
            runtime.activeTurnThreadIds.delete(threadId)
            runtime.activeTurnIds.delete(threadId)
            activeTurnThreadIds.delete(threadId)
          }
        }
      }
    } else {
      let cursor: string | null = null
      let pageCount = 0
      const cursors = new Set<string>()
      do {
        const response = asRecord(await this.rpc('thread/list', {
          archived: false,
          limit: 100,
          sortKey: 'updated_at',
          modelProviders: [],
          cursor,
        }))
        if (!Array.isArray(response?.data)) throw new Error('无法核对当前会话状态，请稍后重试')
        const threads = response.data
        for (const value of threads) {
          const thread = asRecord(value)
          const threadId = readNonEmptyString(thread?.id)
          const status = asRecord(thread?.status)
          const owner = this.threadWorker(threadId)
          const statusType = owner?.activeTurnThreadIds.has(threadId) ? 'active' : readNonEmptyString(status?.type) || readNonEmptyString(thread?.status)
          if (!threadId || !['idle', 'notLoaded', 'systemError', 'completed', 'interrupted', 'failed', 'inProgress', 'running', 'active'].includes(statusType)) {
            throw new Error('会话运行状态未知，暂不能切换账号')
          }
          if (accountSwitch && owner?.currentTaskRun) continue
          if (threadId && !['active', 'running', 'inProgress'].includes(statusType)) {
            activeTurnThreadIds.delete(threadId)
          }
          if (threadId && (statusType === 'inProgress' || statusType === 'running' || statusType === 'active')) {
            activeTurnThreadIds.add(threadId)
          }
        }
        cursor = readNonEmptyString(response?.nextCursor) || null
        if (cursor && cursors.has(cursor)) throw new Error('会话分页未前进，暂不能切换账号')
        if (cursor) cursors.add(cursor)
        pageCount += 1
      } while (cursor && pageCount < 10)
      if (cursor) activeTurnThreadIds.add('__thread_inventory_truncated__')
    }

    const queuedState = await this.queueStateReader()
    const queuedThreadIds = Object.entries(queuedState)
      .filter(([, messages]) => messages.some(message => !accountSwitch || ['sending', 'unknown'].includes(message.delivery?.status || 'queued')))
      .map(([threadId]) => threadId)
    const pendingTurnMutationCount = runtimes.flatMap(worker => [...worker.pending.values()]).filter((request) => (
      request.method === 'turn/start'
      || request.method === 'turn/interrupt'
      || request.method === 'turn/steer'
      || request.method === 'thread/resume'
      || request.method === 'thread/compact/start'
      || request.method === 'thread/goal/set'
      || request.method === 'thread/settings/update'
      || request.method === 'thread/backgroundTerminals/terminate'
    )).length + runtimes.reduce((count, worker) => count + worker.sessionOperations, 0)
    const pendingServerRequestCount = runtimes.reduce((count, worker) => count + worker.pendingServerRequests.size, 0)
    const automationRunIds = accountSwitch ? [] : this.automationActivity()
    if (!ignoreTaskAcquisition && this.taskAccountBusy()) automationRunIds.push('__account_task_lease__')
    const backgroundThreadIds = accountSwitch || activeTurnThreadIds.size || queuedThreadIds.length || automationRunIds.length
      || pendingServerRequestCount || pendingTurnMutationCount ? [] : await this.backgroundActivity()
    if (activityRevision !== this.activityRevision) throw new Error('核对期间运行状态已变化，请稍后重试')
    for (const id of this.activeTurnThreadIds) if (!activeTurnThreadIds.has(id)) { this.activeTurnThreadIds.delete(id); this.activeTurnIds.delete(id) }
    return {
      idle: automationRunIds.length === 0 && activeTurnThreadIds.size === 0
        && backgroundThreadIds.length === 0
        && queuedThreadIds.length === 0
        && pendingServerRequestCount === 0
        && pendingTurnMutationCount === 0,
      activeTurnThreadIds: Array.from(activeTurnThreadIds),
      queuedThreadIds,
      automationRunIds,
      backgroundThreadIds,
      pendingServerRequestCount,
      pendingTurnMutationCount,
    }
  }

  dispose(): void {
    this.ownedThreadIds.clear()
    this.executionLease?.release()
    this.executionLease = null
    this.quotaReadCache = null
    if (!this.process) return

    const proc = this.process
    const closing = proc.exitCode === null && proc.signalCode === null ? once(proc, 'exit').then(() => undefined).catch(() => undefined) : Promise.resolve()
    this.closingSession = closing
    void closing.then(() => { if (this.closingSession === closing) this.closingSession = null })
    this.stopping = true
    this.process = null
    this.initialized = false
    this.initializePromise = null
    this.activeConfigSignature = ''
    this.readBuffer = ''

    this.runtimeStorageId = null
    const failure = new Error('codex app-server stopped')
    for (const request of this.pending.values()) {
      request.reject(failure)
    }
    this.pending.clear()
    this.pendingServerRequests.clear()
    this.activeTurnThreadIds.clear()
    this.activeTurnIds.clear()
    this.terminalTurnIds.clear()
    this.accountFailureInterrupts.clear()
    this.authRecovery.clear()
    this.emitNotification({ method: 'codexapp/runtime/stopped', params: {} })

    try {
      proc.stdin.end()
    } catch {
      // ignore close errors on shutdown
    }

    try {
      proc.kill('SIGTERM')
    } catch {
      // ignore kill errors on shutdown
    }

    const forceKillTimer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        try {
          proc.kill('SIGKILL')
        } catch {
          // ignore kill errors on shutdown
        }
      }
    }, 1500)
    forceKillTimer.unref()
  }
}

export class BackendQueueProcessor {
  readonly store: DeliveryStore
  readonly deliveries: DeliveryService
  readonly history: ThreadHistory
  private readonly processingThreadIds = new Set<string>()
  private readonly queueDrainTimersByThreadId = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly queueDrainDueAtByThreadId = new Map<string, number>()
  private readonly recoveryChecks = new Map<string, number>()
  private readonly threadsNeedingResume = new Set<string>()
  private readonly unsubscribe: () => void
  private pruneTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  private disposal: Promise<void> | null = null
  private providerChanging = false

  constructor(private readonly appServer: AppServerProcess, options: {
    startRecovery?: boolean
    directory?: string
    features?: ConstructorParameters<typeof ThreadHistory>[1]
    context?: () => Promise<string>
    previousRuntimeStopped?: Promise<void>
  } = {}) {
    this.store = new DeliveryStore(options.directory ?? join(getCodexHomeDir(), 'codexapp-delivery'), {
      ...(options.directory ? {} : { readLegacy: readLegacyThreadQueueState, clearLegacy: clearLegacyThreadQueueState }),
      previousRuntimeStopped: options.previousRuntimeStopped,
    })
    const catalog = new MethodCatalog()
    this.history = new ThreadHistory(
      (method, params) => callRpcWithArchiveRecovery(appServer, method, params),
      options.features ?? (async () => (await catalog.snapshot()).features),
    )
    this.deliveries = new DeliveryService(this.store, {
      accountBusy: () => this.providerChanging || this.appServer.taskAccountBusy() || getAccountAuthCoordinator().blocksNewSubmissions(),
      submissionBlocked: () => this.providerChanging || getAccountAuthCoordinator().blocksNewSubmissions(),
      context: options.context ?? (() => this.deliveryContext()),
      canStart: threadId => this.canStartQueuedTurn(threadId),
      prepare: async row => {
        if (row.mode === 'steer') await this.readThreadStatus(row.threadId)
        const needsResume = this.threadsNeedingResume.delete(row.threadId)
        if (needsResume) await appServer.rpc('thread/resume', { threadId: row.threadId, excludeTurns: true })
        return row.params ?? this.buildQueuedTurnParams(row)
      },
      start: async params => {
        const response = asRecord(await appServer.rpc('turn/start', params))
        const turnId = readNonEmptyString(asRecord(response?.turn)?.id)
        if (!turnId) throw new Error('未收到回合 ID，请核对发送状态')
        return { turnId }
      },
      inspect: row => inspectDelivery(this.history, row),
      changed: threadId => appServer.notifyQueueChanged(threadId),
    })
    appServer.queueStateReader = () => this.readState()
    this.unsubscribe = appServer.onNotification(notification => {
      const threadId = extractThreadIdFromNotificationParams(notification.params)
      if (threadId) this.history.invalidate(threadId)
      void this.deliveries.observe(notification).catch(() => {})
      if (threadId && isTurnCompletedNotification(notification)) this.scheduleThreadQueueDrain(threadId, 0)
    })
    if (options.startRecovery !== false) {
      void this.scheduleAllQueuedThreads(1000)
      this.pruneTimer = setInterval(() => { void this.store.pruneReceipts().catch(() => {}) }, 3600000)
      this.pruneTimer.unref?.()
    }
  }

  async cancelAccountDeliveries(): Promise<void> {
    for (const row of await this.store.records()) {
      if (row.status === 'sending') await this.store.unknown(row.message.id, '账号已移除，请核对会话历史')
      else if (row.status === 'queued') await this.store.failed(row.message.id, row.revision, '账号已移除，请登录后重新发送')
      this.appServer.notifyQueueChanged(row.threadId)
    }
  }

  async deliveryContext(): Promise<string> {
    const [account, auth, response] = await Promise.all([
      getAccountAuthCoordinator().store.readState(),
      readCodexAuth(),
      this.appServer.rpc('config/read', {}),
    ])
    const config = asRecord(asRecord(response)?.config)
    const provider = readNonEmptyString(config?.model_provider) || 'openai'
    const settings = asRecord(asRecord(config?.model_providers)?.[provider])
    // Persist only the identity digest, never the credential or unrelated model settings.
    return createHash('sha256').update(JSON.stringify({
      account: getCustomConnectionStore().active()?.storageId || account.activeStorageId || auth?.accountId || null,
      connectionRevision: getCustomConnectionStore().active()?.revision || null,
      provider, baseUrl: settings?.base_url ?? null, wireApi: settings?.wire_api ?? null,
    })).digest('hex')
  }

  beginProviderChange(): () => void {
    if (this.providerChanging || getAccountAuthCoordinator().isAccountOperationInProgress()) throw new Error('账号或供应方正在切换，请稍后重试')
    this.providerChanging = true
    return () => { this.providerChanging = false }
  }

  isIdentityChanging(): boolean {
    return this.providerChanging || getAccountAuthCoordinator().blocksNewSubmissions()
  }

  async readState(): Promise<ThreadQueueState> {
    const state: ThreadQueueState = {}
    const records = await this.store.records()
    const pendingIds = new Set(records.map(row => row.message.id))
    for (const id of this.recoveryChecks.keys()) {
      if (!pendingIds.has(id)) this.recoveryChecks.delete(id)
    }
    for (const row of records) {
      (state[row.threadId] ??= []).push({ ...row.message, delivery: deliveryView(row) })
    }
    return state
  }

  async readDeliveryStatuses(threadId: string, ids: string[]): Promise<Array<{ id: string; status: string; turnId?: string }>> {
    if (!threadId || ids.length > 100 || ids.some(id => !/^[a-zA-Z0-9_-]{1,160}$/.test(id))) throw new Error('无效的发送记录查询')
    const result: Array<{ id: string; status: string; turnId?: string }> = []
    // Only completed receipts are read here. This must never call reconcile/process:
    // observing the UI is not permission to submit or change account blocking.
    for (const id of new Set(ids)) {
      const receipt = await this.store.readReceipt(id)
      if (receipt?.threadId === threadId) result.push({ id, status: receipt.status, turnId: receipt.turnId })
    }
    return result
  }

  async submit(input: unknown): Promise<Record<string, unknown>> {
    const body = asRecord(input)
    if (body?.protocol !== 2) throw new Error('发送接口已更新，请刷新页面后重试')
    const threadId = readNonEmptyString(body.threadId)
    const message = normalizeStoredQueuedMessage(body.message)
    const params = asRecord(body.params)
    const expectedContextId = readNonEmptyString(body.expectedContextId)
    if (!threadId || !message || !params || !expectedContextId || params.threadId !== threadId || !Array.isArray(params.input)) throw new Error('无效的发送内容或缺少账号快照，请刷新页面')
    const browserMessageId = message.id
    if (browserMessageId.startsWith('question:')) {
      const createdAt = body.legacyQuestionCreatedAt
      if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt)) throw new Error('发送接口已更新，请刷新页面后重试')
      // Legacy question IDs could never pass DeliveryStore admission. Normalize
      // only this old format, preserving its first-attempt age and retry identity.
      message.id = `q-${createdAt}-${createHash('sha256').update(browserMessageId).digest('hex')}`
    }
    const result = await this.deliveries.submit({
      threadId, message, params, expectedContextId,
      mode: body.mode === 'steer' ? 'steer' : 'immediate',
    })
    this.scheduleThreadQueueDrain(threadId, 1000)
    if (!result) throw new Error('找不到发送记录，请核对状态')
    return 'message' in result
      ? { id: browserMessageId, ...deliveryView(result) }
      : { id: browserMessageId, status: result.status, turnId: result.turnId }
  }

  async mutate(input: unknown): Promise<{ state: ThreadQueueState; removed?: StoredQueuedMessage; delivered?: { id: string; turnId: string } }> {
    const body = asRecord(input)
    if (body?.protocol !== 2) throw new Error('队列接口已更新，请刷新页面后重试')
    const threadId = readNonEmptyString(body.threadId)
    if (!threadId) throw new Error('缺少会话 ID')
    let removed: StoredQueuedMessage | undefined
    if (body.type === 'add') {
      const message = normalizeStoredQueuedMessage(body.message)
      const expectedContextId = readNonEmptyString(body.expectedContextId)
      if (!message || !expectedContextId) throw new Error('无效的排队消息或缺少账号快照，请刷新页面')
      await this.deliveries.submit({ threadId, message, mode: 'queue', expectedContextId }, readNonEmptyString(body.beforeId) || undefined)
    } else {
      const id = readNonEmptyString(body.messageId)
      const row = await this.deliveries.result(id)
      if (!row || row.threadId !== threadId) throw new Error('该消息状态已变化，请刷新队列')
      if (!('message' in row)) {
        if (!['reconcile', 'steer'].includes(String(body.type))) throw new Error('该消息已发送或已移除，请刷新队列')
      } else if (body.type === 'reconcile') {
        await this.deliveries.reconcile(id)
      } else {
        const revision = Number(body.revision)
        if (!Number.isInteger(revision) || revision < 1) throw new Error('缺少消息版本，请刷新队列')
        if (body.type === 'remove' || body.type === 'abandon') {
          removed = await this.store.remove(id, revision, body.type === 'abandon')
        } else if (body.type === 'move') {
          await this.store.move(id, revision, readNonEmptyString(body.targetId))
        } else if (body.type === 'edit' || body.type === 'update') {
          const contents = body.type === 'update' ? normalizeStoredQueuedMessage({ ...asRecord(body.message), id }) : undefined
          if (body.type === 'update' && !contents) throw new Error('无效的编辑内容')
          // Queue editing keeps the original execution settings and position.
          await this.store.edit(id, revision, readNonEmptyString(body.editToken), contents ? {
            text: contents.text, imageUrls: contents.imageUrls, skills: contents.skills, fileAttachments: contents.fileAttachments,
          } : undefined)
        } else if (body.type === 'resume') {
          await this.store.resume(id, revision)
        } else if (body.type === 'steer') {
          await this.deliveries.steer(id, revision)
        } else {
          throw new Error('无效的队列操作')
        }
      }
    }
    this.appServer.notifyQueueChanged(threadId)
    this.scheduleThreadQueueDrain(threadId, 0)
    const receipt = body.messageId ? await this.store.readReceipt(String(body.messageId)) : null
    return { state: await this.readState(), ...(removed ? { removed } : {}),
      ...(receipt?.turnId ? { delivered: { id: receipt.id, turnId: receipt.turnId } } : {}) }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    this.unsubscribe()
    if (this.pruneTimer) clearInterval(this.pruneTimer)
    for (const timer of this.queueDrainTimersByThreadId.values()) clearTimeout(timer)
    this.queueDrainTimersByThreadId.clear()
    this.queueDrainDueAtByThreadId.clear()
    this.recoveryChecks.clear()
    this.threadsNeedingResume.clear()
    this.history.clear()
    this.disposal = this.deliveries.dispose()
    return this.disposal
  }

  async scheduleAllQueuedThreads(delayMs = 0): Promise<void> {
    try {
      for (const threadId of Object.keys(await this.readState())) this.scheduleThreadQueueDrain(threadId, delayMs)
    } catch (error) {
      console.error('[delivery] 自动恢复已停止:', getErrorMessage(error, '无法读取发送记录'))
    }
  }

  scheduleThreadQueueDrain(threadId: string, delayMs = 5000): void {
    if (!threadId || this.disposed) return
    const normalizedDelayMs = Math.max(0, delayMs)
    const nextDueAt = Date.now() + normalizedDelayMs
    const existingDueAt = this.queueDrainDueAtByThreadId.get(threadId)
    const existingTimer = this.queueDrainTimersByThreadId.get(threadId)
    if (existingTimer) {
      if (existingDueAt !== undefined && existingDueAt <= nextDueAt) return
      clearTimeout(existingTimer)
    }
    const timer = setTimeout(() => {
      this.queueDrainTimersByThreadId.delete(threadId)
      this.queueDrainDueAtByThreadId.delete(threadId)
      void this.processThreadQueue(threadId)
    }, normalizedDelayMs)
    timer.unref?.()
    this.queueDrainTimersByThreadId.set(threadId, timer)
    this.queueDrainDueAtByThreadId.set(threadId, nextDueAt)
  }

  async processThreadQueue(threadId: string): Promise<void> {
    if (this.disposed || this.processingThreadIds.has(threadId)) return
    this.processingThreadIds.add(threadId)
    try {
      const rows = await this.store.records(threadId)
      const uncertain = rows.find(row => ['sending', 'unknown'].includes(row.status))
      if (uncertain) {
        const count = this.recoveryChecks.get(uncertain.message.id) ?? 0
        if (count >= 3) return
        this.recoveryChecks.set(uncertain.message.id, count + 1)
        await this.deliveries.reconcile(uncertain.message.id)
        this.scheduleThreadQueueDrain(threadId, [1000, 5000, 15000][count])
        return
      }
      const steer = rows.find(row => row.status === 'queued' && row.mode === 'steer')
      const head = steer ?? rows[0]
      if (!head || head.status !== 'queued') return
      await this.deliveries.process(threadId, steer?.message.id)
      if ((await this.store.records(threadId)).length) this.scheduleThreadQueueDrain(threadId)
    } catch (error) {
      // A persisted failure remains visible through readState; it never authorizes replay.
      console.error('[delivery] 队列已暂停:', getErrorMessage(error, '发送状态读取失败'))
    } finally {
      this.processingThreadIds.delete(threadId)
    }
  }

  private async canStartQueuedTurn(threadId: string): Promise<boolean> {
    if (this.appServer.listPendingServerRequests().some(row => extractThreadIdFromNotificationParams(row.params) === threadId)) return false
    const statusType = await this.readThreadStatus(threadId)
    return !['inProgress', 'running', 'active'].includes(statusType)
  }

  private async readThreadStatus(threadId: string): Promise<string> {
    this.threadsNeedingResume.delete(threadId)
    let response: Record<string, unknown> | null
    try {
      response = asRecord(await this.appServer.rpc('thread/read', { threadId, includeTurns: false }))
    } catch (error) {
      if (!isEmptyThreadReadError(error)) throw error
      response = asRecord(this.appServer.getLastThreadReadSnapshot(threadId))
    }
    const thread = asRecord(response?.thread)
    if (!thread) throw new Error('无法读取会话状态')
    const statusType = readNonEmptyString(asRecord(thread.status)?.type) || readNonEmptyString(thread.status)
    if (statusType === 'notLoaded') this.threadsNeedingResume.add(threadId)
    return statusType
  }

  private async resolveCollaborationModeSettings(mode: CollaborationModeKind): Promise<ResolvedCollaborationModeSettings> {
    let currentConfig: Record<string, unknown> | null = null
    try {
      const configPayload = asRecord(await this.appServer.rpc('config/read', {}))
      currentConfig = asRecord(configPayload?.config)
    } catch {
      currentConfig = null
    }

    const configuredModel = readNonEmptyString(currentConfig?.model)
    if (configuredModel) {
      return {
        model: configuredModel,
        reasoningEffort: normalizeCollaborationModeReasoningEffort(normalizeReasoningEffort(currentConfig?.model_reasoning_effort)),
      }
    }

    try {
      const modelsPayload = asRecord(await this.appServer.rpc('model/list', {}))
      const models = Array.isArray(modelsPayload?.data) ? modelsPayload.data : []
      for (const row of models) {
        const record = asRecord(row)
        const candidate = readNonEmptyString(record?.id) || readNonEmptyString(record?.model)
        if (candidate) {
          return {
            model: candidate,
            reasoningEffort: normalizeCollaborationModeReasoningEffort(normalizeReasoningEffort(currentConfig?.model_reasoning_effort)),
          }
        }
      }
    } catch {
      // Fall through to no collaboration-mode payload.
    }

    throw new Error(`${mode === 'plan' ? 'Plan' : 'Default'} mode requires an available model.`)
  }

  async buildQueuedTurnParams(turn: BackendQueuedTurn): Promise<Record<string, unknown>> {
    const localImageAttachments: StoredQueuedMessage['fileAttachments'] = []
    for (const imageUrl of turn.message.imageUrls) {
      const localImagePath = extractLocalImagePathFromUrl(imageUrl.trim())
      if (!localImagePath) continue
      localImageAttachments.push({
        label: fileNameFromPath(localImagePath),
        path: localImagePath,
        fsPath: localImagePath,
      })
    }

    const allFileAttachments = [...turn.message.fileAttachments, ...localImageAttachments]
    const dedupedFileAttachments = allFileAttachments.filter((entry, index) =>
      allFileAttachments.findIndex((candidate) => candidate.fsPath === entry.fsPath) === index)

    const input: Array<Record<string, unknown>> = [{
      type: 'text',
      text: buildTextWithAttachments(turn.message.text, dedupedFileAttachments),
    }]

    for (const imageUrl of turn.message.imageUrls) {
      const normalizedUrl = imageUrl.trim()
      if (!normalizedUrl) continue
      const localImagePath = extractLocalImagePathFromUrl(normalizedUrl)
      if (localImagePath) {
        input.push({ type: 'localImage', path: localImagePath })
      } else {
        input.push({ type: 'image', url: normalizedUrl, image_url: normalizedUrl })
      }
    }

    for (const skill of turn.message.skills) {
      input.push({ type: 'skill', name: skill.name, path: skill.path })
    }

    const params: Record<string, unknown> = {
      threadId: turn.threadId,
      input,
    }
    if (dedupedFileAttachments.length > 0) {
      params.attachments = dedupedFileAttachments.map((f) => ({ label: f.label, path: f.path, fsPath: f.fsPath }))
    }

    const defaults = turn.message.model ? null : await this.resolveCollaborationModeSettings(turn.message.collaborationMode)
    const model = turn.message.model || defaults!.model
    const reasoningEffort = turn.message.effort !== undefined ? turn.message.effort || null : defaults?.reasoningEffort || null
    params.model = model
    if (turn.message.effort) params.effort = turn.message.effort
    if (turn.message.serviceTier !== undefined) params.serviceTier = turn.message.serviceTier
    params.collaborationMode = {
      mode: turn.message.collaborationMode,
      settings: { model, reasoning_effort: reasoningEffort, developer_instructions: null },
    }

    return params
  }

}

type CodexBridgeMiddleware = ((req: IncomingMessage, res: ServerResponse, next: () => void) => Promise<void>) & {
  dispose: () => Promise<void>
  subscribeNotifications: (listener: (value: { method: string; params: unknown; atIso: string }) => void) => () => void
}

type SharedBridgeState = {
  unsubscribeQuota: () => void
  quotaResume: ThreadQuotaResume
  disposed: boolean
  owners: number
  disposal: Promise<void> | null
  version: string
  appServer: AppServerProcess
  terminalManager: ThreadTerminalManager
  methodCatalog: MethodCatalog
  telegramBridge: TelegramThreadBridge
  backendQueueProcessor: BackendQueueProcessor
  automationEngine: AutomationEngine
  threadGoalReader: ThreadGoalReader
  threadCompactionGate: ThreadCompactionGate
  processActivity: ProcessActivityStore
}

const SHARED_BRIDGE_KEY = '__codexRemoteSharedBridge__'
const SHARED_BRIDGE_VERSION = 'shared-runtime-0217-settings-history-quiet-v1'

function disposeSharedBridgeState(state: SharedBridgeState): Promise<void> {
  if (state.disposal) return state.disposal
    state.disposed = true
  state.disposal = (async () => {
    state.unsubscribeQuota?.()
    const automationDisposal = state.automationEngine.dispose()
    state.telegramBridge.stop()
    state.terminalManager.dispose()
    const deliveryDisposal = state.backendQueueProcessor.dispose()
    state.appServer.stopTaskRouting?.()
    state.appServer.dispose()
    await Promise.all([automationDisposal, deliveryDisposal, state.telegramBridge.settleNotifications(), state.processActivity.flush(), state.quotaResume?.close()])
  })()
  return state.disposal
}

function getSharedBridgeState(): SharedBridgeState {
  const globalScope = globalThis as typeof globalThis & {
    [SHARED_BRIDGE_KEY]?: SharedBridgeState
  }

  const existing = globalScope[SHARED_BRIDGE_KEY]
  if (existing && !existing.disposed && existing.version === SHARED_BRIDGE_VERSION && existing.terminalManager) {
    return existing
  }
  const previousRuntimeStopped = existing ? disposeSharedBridgeState(existing) : undefined

  const appServer = new AppServerProcess()
  let wakeQuotaResume = () => {}
  const lastQuotaUsage = new Map<string, number[]>()
  const unsubscribeQuota = getAccountAuthCoordinator().subscribeQuotaUpdates(account => {
    appServer.notifyAccountQuota(account)
    const usage = [account.quotaSnapshot?.primary?.usedPercent, account.quotaSnapshot?.secondary?.usedPercent]
      .filter((value): value is number => typeof value === 'number')
    const previous = lastQuotaUsage.get(account.storageId)
    lastQuotaUsage.set(account.storageId, usage)
    if (!previous || usage.some((value, index) => value < (previous[index] ?? Infinity))) wakeQuotaResume()
  })
  const processActivity = existing?.processActivity ?? new ProcessActivityStore(join(getCodexHomeDir(), 'codexapp-hook-observations.json'))
  const terminalManager = new ThreadTerminalManager()
  const methodCatalog = new MethodCatalog()
  appServer.backgroundActivity = async () => {
    const methods = (await methodCatalog.snapshot()).methods
    if (!methods.includes('thread/backgroundTerminals/list')) return []
    if (!methods.includes('thread/loaded/list')) throw new Error('无法完整核对后台终端，暂不能切换账号')
    return threadsWithBackgroundTerminals((method, params) => appServer.rpc(method, params))
  }
  const backendQueueProcessor = new BackendQueueProcessor(appServer, { features: async () => (await methodCatalog.snapshot()).features, previousRuntimeStopped })
  const quotaResume = new ThreadQuotaResume(getCodexHomeDir(), {
    inspect: async threadId => {
      const response = asRecord((await backendQueueProcessor.history.page(threadId, { limit: 1 })).result)
      const thread = asRecord(response?.thread)
      const turns = Array.isArray(thread?.turns) ? thread.turns : []
      const last = asRecord(turns.at(-1))
      const active = appServer.taskAccountBusy() || Boolean((await backendQueueProcessor.readState())[threadId]?.length)
        || ['active', 'running', 'inProgress'].includes(readNonEmptyString(asRecord(thread?.status)?.type) || String(thread?.status))
        || appServer.listPendingServerRequests().some(request => asRecord(request.params)?.threadId === threadId)
      return { active, turnId: readNonEmptyString(last?.id) || null, status: readNonEmptyString(last?.status), error: JSON.stringify(last?.error || '') }
    },
    available: async () => {
      const coordinator = getAccountAuthCoordinator()
      if (appServer.taskAccountBusy() || coordinator.blocksNewSubmissions()) return false
      const state = await coordinator.store.readState()
      const account = state.accounts.find(row => row.storageId === state.activeStorageId)
      if (!account || account.quotaStatus !== 'ready' || !account.quotaSnapshot || !account.quotaUpdatedAtIso || Date.now() - Date.parse(account.quotaUpdatedAtIso) > 5 * 60_000) return false
      const windows = [account.quotaSnapshot.primary, account.quotaSnapshot.secondary].filter(Boolean)
      if (!windows.length || windows.some(window => window!.usedPercent >= 100)) return false
      try { await coordinator.assertSubmissionAllowed(undefined); return true } catch { return false }
    },
    submit: async (threadId, id) => {
      const message = { id, text: '继续之前的工作', imageUrls: [], skills: [], fileAttachments: [], collaborationMode: 'default' as const }
      let params: Record<string, unknown>
      try { params = await backendQueueProcessor.buildQueuedTurnParams({ threadId, message }) }
      catch { throw Object.assign(new Error('续跑参数准备未完成，稍后重试'), { retryableQuota: true }) }
      const result = await backendQueueProcessor.submit({ protocol: 2, threadId, message, params, expectedContextId: await backendQueueProcessor.deliveryContext() })
      if (result.status === 'failed') {
        const row = await backendQueueProcessor.deliveries.result(id)
        if (row && 'message' in row && /额度|限额/.test(row.error || '')) {
          await backendQueueProcessor.store.remove(id, row.revision)
          throw Object.assign(new Error('额度仍受限'), { retryableQuota: true })
        }
        throw new Error('续跑准备失败，请核对会话')
      }
    },
    reconcile: async (threadId, id, attemptedAt) => {
      const row = await backendQueueProcessor.deliveries.result(id)
      // A recent durable claim with no ledger record failed before submission.
      // Old missing receipts may have expired; never replay those automatically.
      if (!row) {
        return attemptedAt && Date.now() - attemptedAt < 86400_000 ? 'waiting' : 'unknown'
      }
      if (row.threadId !== threadId) return 'unknown'
      if (!('message' in row) || row.status === 'queued' || row.status === 'sending') return 'submitted'
      if (row.status === 'unknown') {
        const reconciled = await backendQueueProcessor.deliveries.reconcile(id)
        return reconciled && !('message' in reconciled) ? 'submitted' : 'unknown'
      }
      return 'unknown'
    },
    cancel: async id => {
      const row = await backendQueueProcessor.deliveries.result(id)
      if (row && 'message' in row && row.status === 'queued') await backendQueueProcessor.store.remove(id, row.revision)
    },
    changed: () => appServer.notifyQuotaResumeChanged(),
  })
  wakeQuotaResume = () => { void quotaResume.tick().catch(() => undefined) }
  appServer.quotaBlocked = (threadId, turnId) => quotaResume.blocked(threadId, turnId)
  const threadGoalReader = new ThreadGoalReader((method, params) => appServer.rpc(method, params))
  const threadCompactionGate = new ThreadCompactionGate((method, params) => appServer.rpc(method, params),
    async threadId => backendQueueProcessor.isIdentityChanging() || Boolean((await backendQueueProcessor.readState())[threadId]?.length))
  const automationEngine = new AutomationEngine(getCodexHomeDir(), createAutomationRuntime({
    resolveCwd: async (cwd, name) => isVirtualProjectId(cwd) ? (await createAutomationProjectConversationDirectory(name, cwd)).cwd : cwd,
    rpc: (method, params, runId, scope) => appServer.automationRpc(method, params, runId, scope),
    beginPreparation: (runId, scope) => appServer.beginTaskPreparation(runId, scope),
    endPreparation: runId => appServer.endTaskPreparation(runId),
    acquireAccount: (runId, settings, scope) => appServer.acquireTaskAccount(runId, settings, scope),
    releaseAccount: runId => appServer.releaseTaskAccount(runId),
    accountStorageId: runId => appServer.taskAccountStorageId(runId),
    accountBusy: () => false,
    hasQueuedMessages: async (id) => Boolean((await backendQueueProcessor.readState())[id]?.length),
    pendingRequests: () => appServer.listPendingServerRequests(),
    readHistory: async threadId => (await backendQueueProcessor.history.page(threadId, { limit: 50 })).result,
    buildParams: async (threadId, text) => ({ threadId, input: [{ type: 'text', text }] }),
  }), Date.now, true, previousRuntimeStopped)
  appServer.automationActivity = () => automationEngine.activity()
  appServer.accountDisconnected = (storageId, primary, runIds) => {
    void automationEngine.cancelAccount(storageId, primary, runIds).catch(() => undefined)
    if (primary) void backendQueueProcessor.cancelAccountDeliveries().catch(() => undefined)
  }
  appServer.onNotification((notification) => {
    if (notification.method === 'turn/completed') {
      const params = asRecord(notification.params)
      const threadId = readNonEmptyString(params?.threadId)
      const turnId = readNonEmptyString(asRecord(params?.turn)?.id) || readNonEmptyString(params?.turnId)
      void appServer.completions.complete(threadId, turnId).catch(() => console.error('Failed to persist completion list'))
    }
    if (['turn/started', 'turn/completed', 'turn/cancelled', 'error', 'thread/status/changed'].includes(notification.method)) {
      void appServer.interruptions.observe(notification.method, notification.params).catch(() => console.error('Failed to persist conversation problem indicators'))
    }
    quotaResume.observe(notification)
    if (notification.method === 'account/rateLimits/updated') void appServer.observeAccountQuota(notification.params).catch(() => undefined)
    automationEngine.notification(notification)
    threadGoalReader.observe(notification)
    threadCompactionGate.observe(notification)
    processActivity.observe(notification)
  })
  const created: SharedBridgeState = {
    unsubscribeQuota,
    quotaResume,
    disposed: false,
    owners: 0,
    disposal: null,
    automationEngine,
    threadGoalReader,
    threadCompactionGate,
    processActivity,
    version: SHARED_BRIDGE_VERSION,
    appServer,
    terminalManager,
    methodCatalog,
    backendQueueProcessor,
    telegramBridge: new TelegramThreadBridge(appServer, {
      notificationDirectory: join(getCodexHomeDir(), 'telegram-notifications'),
      onChatSeen: (chatId) => {
        void rememberTelegramChatId(chatId).catch(() => {})
      },
    }),
  }
  globalScope[SHARED_BRIDGE_KEY] = created
  return created
}

export function createCodexBridgeMiddleware(): CodexBridgeMiddleware {
  const sharedState = getSharedBridgeState()
  sharedState.owners++
  const { appServer, terminalManager, methodCatalog, telegramBridge, backendQueueProcessor, automationEngine, threadGoalReader, threadCompactionGate, quotaResume } = sharedState
  const directoryPlugins = new DirectoryPluginCache(join(getCodexHomeDir(), 'cache', 'plugin-catalog'), params => appServer.rpc('plugin/list', params))
  const directoryMcps = new DirectoryMcpReader((method, params) => appServer.rpc(method, params))
  const backgroundTerminals = new BackgroundTerminalReader((method, params) => appServer.rpc(method, params), () => backendQueueProcessor.isIdentityChanging())
  const history = new ThreadHistory(
    (method, params) => callRpcWithArchiveRecovery(appServer, method, params),
    async () => (await methodCatalog.snapshot()).features,
  )
  const ignoredQuotaErrors = appServer.ignoredErrors
  const sidebarThreadStatus = new SidebarThreadStatusReader(async (method, params) => {
    const result = asRecord(await appServer.rpc(method, params))
    const turns = Array.isArray(result?.data) ? result.data : null
    if (!turns) throw new Error('Invalid final turn metadata')
    const turn = asRecord(turns[0])
    // Only enrich an already terminal failure. A recovered/completed turn must
    // never become a quota interruption because of an earlier retry error.
    if (turn && ['failed', 'interrupted'].includes(String(turn.status)) && !turn.error) {
      const merged = asRecord(mergeStreamTurnErrorsIntoThreadResult(appServer, { thread: { id: params.threadId, turns } }))
      const enriched = asRecord(merged?.thread)?.turns as { id?: string; status?: string; error?: unknown }[]
      if (enriched?.[0]) await appServer.interruptions.record(String(params.threadId), enriched[0])
      return { data: enriched }
    }
    if (turn) await appServer.interruptions.record(String(params.threadId), turn)
    return result
  }, Date.now, 8000, (threadId, turnId) => ignoredQuotaErrors.has(threadId, turnId))
  const unsubscribeHistory = appServer.onNotification(({ method, params }) => {
    const value = asRecord(params)
    const threadId = readNonEmptyString(value?.threadId) || readNonEmptyString(value?.thread_id) || readNonEmptyString(asRecord(value?.thread)?.id)
    if (threadId) {
      if (method === 'thread/quotaErrorIgnored/changed') {
        sidebarThreadStatus.invalidate(threadId)
        return
      }
      history.invalidate(threadId)
      if (['turn/started', 'turn/completed', 'turn/cancelled', 'thread/status/changed'].includes(method)) sidebarThreadStatus.invalidate(threadId)
    }
  })
  const search = new ThreadSearch({
    list: async cursor => {
      const raw = await callRpcWithArchiveRecovery(appServer, 'thread/list', { archived: false, limit: 100, sortKey: 'updated_at', modelProviders: [], cursor })
      const result = asRecord(await mergeImportedThreadsIntoThreadListResult(raw, { cursor }))
      return { data: Array.isArray(result?.data) ? result.data : [], nextCursor: readNonEmptyString(result?.nextCursor) || null }
    },
    body: async thread => {
      const page = await history.page(thread.id, { metadata: { thread }, limit: SEARCH_BODY_TURN_LIMIT })
      return { text: extractThreadSearchText(page.result), truncated: page.hasMoreOlder }
    },
    titles: async () => (await readMergedThreadTitleCache()).titles,
    version: async thread => {
      const path = readNonEmptyString(thread.path)
      if (!path || !isAbsolute(path)) return ''
      const info = await stat(path, { bigint: true }).catch(() => null)
      return info ? `${info.ino}:${info.size}:${info.mtimeNs}` : ''
    },
  })
  const unsubscribeSearch = appServer.onNotification(({ method, params }) => {
    if (!changesThreadSearch(method)) return
    const value = asRecord(params)
    const threadId = readNonEmptyString(value?.threadId) || readNonEmptyString(value?.thread_id) || readNonEmptyString(asRecord(value?.thread)?.id)
    search.invalidate(threadId || undefined)
  })
  void mutateTelegramBridgeConfig(async () => {
    const config = await readTelegramBridgeConfig()
    telegramBridge.configureNotifications(config.notificationsEnabled)
    telegramBridge.configureQuietHours(config)
    if (!config.botToken) return
    telegramBridge.configureToken(config.botToken)
    telegramBridge.configureAllowedUserIds(config.allowedUserIds)
    telegramBridge.start()
  }).catch(() => {})

  const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const requestStartNs = process.hrtime.bigint()
    const rawUrl = req.url ?? ''
    const parsedRequestUrl = rawUrl ? new URL(rawUrl, 'http://localhost') : null
    const requestPath = parsedRequestUrl?.pathname ?? ''
    const requestMethod = req.method ?? 'UNKNOWN'
    const rawContentLength = Array.isArray(req.headers['content-length'])
      ? req.headers['content-length'][0]
      : req.headers['content-length']
    const parsedContentLength = rawContentLength ? Number.parseInt(rawContentLength, 10) : NaN
    let requestBodyBytes: number | null = Number.isFinite(parsedContentLength) && parsedContentLength >= 0
      ? parsedContentLength
      : null
    let responseBodyBytes = 0
    let rpcMethod: string | null = null
    let releaseProviderChange: (() => void) | undefined
    const originalWrite = res.write.bind(res)
    const originalEnd = res.end.bind(res)
    res.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
      const resolvedEncoding = typeof encoding === 'string' ? encoding as BufferEncoding : undefined
      responseBodyBytes += getChunkByteLength(chunk, resolvedEncoding)
      return originalWrite(chunk as never, encoding as never, cb as never)
    }) as typeof res.write
    res.end = ((chunk?: unknown, encoding?: unknown, cb?: unknown) => {
      const resolvedEncoding = typeof encoding === 'string' ? encoding as BufferEncoding : undefined
      responseBodyBytes += getChunkByteLength(chunk, resolvedEncoding)
      return originalEnd(chunk as never, encoding as never, cb as never)
    }) as typeof res.end
    let didLog = false
    const logApiRequestDuration = () => {
      if (!API_PERF_LOGGING_ENABLED || didLog || !requestPath.startsWith('/codex-api/')) return
      const durationMs = Number((process.hrtime.bigint() - requestStartNs) / 1_000_000n)
      const requestBytes = requestBodyBytes ?? 0
      const bodyMbValue = (requestBytes + responseBodyBytes) / MB_DIVISOR
      const shouldLog = durationMs > API_PERF_MS_THRESHOLD || bodyMbValue > API_PERF_BODY_MB_THRESHOLD
      if (!shouldLog) return
      didLog = true
      const rpcPart = rpcMethod ? `, rpcMethod=${rpcMethod}` : ''
      console.info(`[codex-api-perf] ${requestMethod} ${requestPath} -> ${res.statusCode} (${durationMs}ms, bodyMB=${bodyMbValue.toFixed(1)}${rpcPart})`)
    }
    res.once('finish', logApiRequestDuration)
    res.once('close', logApiRequestDuration)

    try {
      if (!req.url) {
        next()
        return
      }

      const url = new URL(req.url, 'http://localhost')
      if (req.method === 'POST' && url.pathname === '/codex-api/webui-branding') {
        try {
          const input = asRecord(await readJsonBody(req)) || {}
          setJson(res, 200, { data: await getWebUiBrandingStore().save(input) })
        } catch (error) {
          setJson(res, 400, { error: error instanceof Error ? error.message : '保存失败' })
        }
        return
      }
      const connections = getCustomConnectionStore()
      await connections.ready
      const runtimeConnection = /^\/codex-api\/custom-connections\/runtime\/([a-f0-9]{64})\/(\d+)\/v1\/responses$/.exec(url.pathname)
      if (runtimeConnection && req.method === 'POST') {
        const connection = connections.get(runtimeConnection[1])
        if (!isLoopbackRemoteAddress(req.socket.remoteAddress) || !connection || connection.wireApi !== 'responses' || connection.revision !== Number(runtimeConnection[2]) || req.headers.authorization !== `Bearer ${connection.runtimeToken}`) {
          setJson(res, 409, { error: '连接配置已变化，请重新发送' })
          return
        }
        handleCustomEndpointProxyRequest(req, res, { baseUrl: connection.baseUrl, bearerToken: connection.apiKey, wireApi: connection.wireApi, sanitizeRequest: payload => {
          const value = { ...payload }
          const model = connection.models.find(row => row.id === value.model)
          if (!model?.efforts?.length) { delete value.reasoning; delete value.reasoning_effort }
          if (!model?.serviceTiers?.length) delete value.service_tier
          return value
        } })
        return
      }
      if (url.pathname === '/codex-api/custom-connections' && req.method === 'GET') {
        setJson(res, 200, { data: connections.snapshot() })
        return
      }
      if (url.pathname.startsWith('/codex-api/custom-connections') && req.method === 'POST') {
        const input = asRecord(await readJsonBody(req)) || {}
        try {
          if (url.pathname.endsWith('/test')) {
            setJson(res, 200, { data: await connections.test(input as any) })
            return
          }
          const id = readNonEmptyString(input.storageId)
          // Adding a saved configuration does not change execution identity or auth.
          // Keep provider admission checks for selection and existing connections.
          const isNewConnection = url.pathname === '/codex-api/custom-connections' && !id
          if (!isNewConnection) releaseProviderChange = backendQueueProcessor.beginProviderChange()
          if (!url.pathname.endsWith('/select') && id && getAccountAuthCoordinator().executions.snapshot().some(entry => entry.storageId === id && entry.busy)) throw new Error('连接正在使用，请等待任务完成')
          if (url.pathname.endsWith('/select')) await connections.select(id || null)
          else if (url.pathname.endsWith('/remove')) await connections.remove(id)
          else await connections.save(input as any, String(input.testToken || ''))
          setJson(res, 200, { data: connections.snapshot() })
        } catch (error) { setJson(res, 400, { error: getErrorMessage(error, '连接配置无效') }) }
        return
      }
      if (url.pathname === '/codex-api/accounts/models' && req.method === 'GET') {
        const id = url.searchParams.get('storageId')
        const custom = id ? connections.get(id) : connections.active()
        if (custom) {
          setJson(res, 200, { data: customConnectionModels({ ...custom, hasApiKey: true }), source: 'custom' })
          return
        }
      }
      if (url.pathname === '/codex-api/zen-proxy/v1/responses' && req.method === 'POST') {
        if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
          setJson(res, 403, { error: 'Zen proxy is only available from localhost' })
          return
        }
        const statePath = join(getCodexHomeDir(), FREE_MODE_STATE_FILE)
        let bearerToken = ''
        let wireApi: 'responses' | 'chat' = 'responses'
        try {
          const state = ensureDefaultFreeModeStateForMissingAuthSync(statePath)
          bearerToken = state?.apiKey ?? ''
          if (state) {
            wireApi = state.wireApi === 'responses' ? 'responses' : 'chat'
          }
        } catch { /* use empty */ }
        handleZenProxyRequest(req, res, bearerToken, wireApi)
        return
      }

      if (url.pathname === '/codex-api/openrouter-proxy/v1/responses' && req.method === 'POST') {
        const statePath = join(getCodexHomeDir(), FREE_MODE_STATE_FILE)
        let bearerToken = ''
        let wireApi: 'responses' | 'chat' = 'responses'
        try {
          const state = ensureDefaultFreeModeStateForMissingAuthSync(statePath)
          bearerToken = state?.apiKey ?? ''
          wireApi = state?.wireApi === 'chat' ? 'chat' : 'responses'
        } catch { /* use empty */ }
        handleOpenRouterProxyRequest(req, res, bearerToken, wireApi)
        return
      }

      if (url.pathname === '/codex-api/custom-proxy/v1/responses' && req.method === 'POST') {
        const statePath = join(getCodexHomeDir(), FREE_MODE_STATE_FILE)
        let bearerToken = ''
        let wireApi: 'responses' | 'chat' = 'responses'
        let baseUrl = ''
        try {
          const state = ensureDefaultFreeModeStateForMissingAuthSync(statePath)
          bearerToken = state?.apiKey ?? ''
          wireApi = state?.wireApi === 'chat' ? 'chat' : 'responses'
          baseUrl = state?.customBaseUrl ?? ''
        } catch { /* use empty */ }
        handleCustomEndpointProxyRequest(req, res, { baseUrl, bearerToken, wireApi })
        return
      }

      if (url.pathname.startsWith('/codex-api/free-mode')) {
        if (req.method === 'POST') {
          releaseProviderChange = backendQueueProcessor.beginProviderChange()
          const quiescence = await appServer.getRuntimeQuiescenceSnapshot()
          if (!quiescence.idle) {
            const error = quiescence.backgroundThreadIds?.length
              ? '请先处理 Codex 后台终端，再切换供应方或密钥。'
              : '请先结束当前任务并处理队列，再切换供应方或密钥'
            setJson(res, 409, { error })
            return
          }
        }
        const statePath = join(getCodexHomeDir(), FREE_MODE_STATE_FILE)

        function readFreeModeState(): FreeModeState {
          return ensureDefaultFreeModeStateForMissingAuthSync(statePath)
            ?? { enabled: false, apiKey: null, model: FREE_MODE_DEFAULT_MODEL }
        }

        if (req.method === 'POST' && url.pathname === '/codex-api/free-mode') {
          try {
            const body = await readJsonBody(req) as Record<string, unknown> | null
            const enable = Boolean(body?.enable)

            if (enable) {
              const apiKey = getRandomFreeKey()
              if (!apiKey) {
                setJson(res, 500, { error: 'No free keys available' })
                return
              }

              const prev = readFreeModeState()
              const prevKeys = prev.providerKeys ?? {}
              if (prev.provider && prev.apiKey) {
                prevKeys[prev.provider] = prev.apiKey
              }
              const state: FreeModeState = {
                enabled: true,
                apiKey,
                model: FREE_MODE_DEFAULT_MODEL,
                provider: 'openrouter',
                wireApi: prev.wireApi === 'chat' ? 'chat' : 'responses',
                providerKeys: prevKeys,
              }
              await writeFreeModeStateFile(statePath, state)
              appServer.dispose()
              const freeModels = await getFreeModels()
              setJson(res, 200, {
                ok: true,
                enabled: true,
                model: FREE_MODE_DEFAULT_MODEL,
                keyCount: getFreeKeyCount(),
                models: freeModels,
              })
            } else {
              const prev = readFreeModeState()
              const prevKeys = prev.providerKeys ?? {}
              if (prev.provider && prev.apiKey) {
                prevKeys[prev.provider] = prev.apiKey
              }
              const state: FreeModeState = {
                enabled: false,
                apiKey: null,
                model: FREE_MODE_DEFAULT_MODEL,
                wireApi: prev.wireApi === 'chat' ? 'chat' : 'responses',
                providerKeys: prevKeys,
              }
              await writeFreeModeStateFile(statePath, state)
              appServer.dispose()
              setJson(res, 200, { ok: true, enabled: false })
            }
          } catch (error) {
            setJson(res, 500, { error: getErrorMessage(error, 'Failed to toggle free mode') })
          }
          return
        }

        if (req.method === 'GET' && url.pathname === '/codex-api/free-mode/status') {
          try {
            const state = readFreeModeState()
            const maskedKey = state.apiKey && state.customKey
              ? state.apiKey.substring(0, 12) + '...' + state.apiKey.substring(state.apiKey.length - 4)
              : null
            let models = getCachedFreeModels()
            let currentModel = state.enabled ? state.model : null
            let wireApi = state.wireApi ?? null
            if (state.provider === OPENCODE_ZEN_PROVIDER_ID) {
              currentModel = state.enabled ? (state.model?.trim() || OPENCODE_ZEN_DEFAULT_MODEL) : null
              try {
                const zenModels = filterOpenCodeZenModelsForAuthState(
                  sortOpenCodeZenModelIds(await fetchOpenCodeZenModelIds(state.apiKey)),
                  state.apiKey,
                )
                if (zenModels.length > 0) {
                  models = zenModels
                } else {
                  models = [
                    OPENCODE_ZEN_DEFAULT_MODEL,
                    'minimax-m2.5-free',
                    'nemotron-3-super-free',
                    'trinity-large-preview-free',
                  ]
                }
              } catch {
                models = [
                  OPENCODE_ZEN_DEFAULT_MODEL,
                  'minimax-m2.5-free',
                  'nemotron-3-super-free',
                  'trinity-large-preview-free',
                ]
              }
              wireApi = 'responses'
            } else {
              refreshFreeModelsInBackground()
            }
            setJson(res, 200, {
              enabled: state.enabled,
              hasCodexAuth: hasUsableCodexAuthSync(),
              keyCount: getFreeKeyCount(),
              models,
              currentModel,
              customKey: Boolean(state.customKey),
              maskedKey,
              provider: state.provider ?? 'openrouter',
              customBaseUrl: state.customBaseUrl ?? null,
              wireApi,
            })
          } catch (error) {
            setJson(res, 500, { error: getErrorMessage(error, 'Failed to read free mode status') })
          }
          return
        }

        if (req.method === 'POST' && url.pathname === '/codex-api/free-mode/rotate-key') {
          try {
            const apiKey = getRandomFreeKey()
            if (!apiKey) {
              setJson(res, 500, { error: 'No free keys available' })
              return
            }
            const current = readFreeModeState()
            const state: FreeModeState = { ...current, apiKey, customKey: false }
            await writeFreeModeStateFile(statePath, state)
            appServer.dispose()
            setJson(res, 200, { ok: true })
          } catch (error) {
            setJson(res, 500, { error: getErrorMessage(error, 'Failed to rotate key') })
          }
          return
        }

        if (req.method === 'POST' && url.pathname === '/codex-api/free-mode/custom-key') {
          try {
            const body = await readJsonBody(req) as Record<string, unknown> | null
            const key = typeof body?.key === 'string' ? body.key.trim() : ''
            const current = readFreeModeState()

            if (key.length > 0) {
              const state: FreeModeState = {
                ...current,
                enabled: true,
                apiKey: key,
                customKey: true,
                provider: 'openrouter',
                wireApi: current.wireApi === 'chat' ? 'chat' : 'responses',
              }
              await writeFreeModeStateFile(statePath, state)
              appServer.dispose()
              setJson(res, 200, { ok: true, customKey: true })
            } else {
              const communityKey = getRandomFreeKey()
              const state: FreeModeState = {
                ...current,
                apiKey: communityKey,
                customKey: false,
                provider: 'openrouter',
                wireApi: current.wireApi === 'chat' ? 'chat' : 'responses',
              }
              await writeFreeModeStateFile(statePath, state)
              appServer.dispose()
              setJson(res, 200, { ok: true, customKey: false })
            }
          } catch (error) {
            setJson(res, 500, { error: getErrorMessage(error, 'Failed to set custom key') })
          }
          return
        }

        if (req.method === 'POST' && url.pathname === '/codex-api/free-mode/custom-provider') {
          try {
            const body = await readJsonBody(req) as Record<string, unknown> | null
            const baseUrl = typeof body?.baseUrl === 'string' ? body.baseUrl.trim() : ''
            const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : ''
            const wireApi = body?.wireApi === 'chat' ? 'chat' as const : 'responses' as const
            const providerType = body?.provider === 'opencode-zen'
              ? 'opencode-zen' as const
              : body?.provider === 'openrouter'
                ? 'openrouter' as const
                : 'custom' as const
            if (providerType === 'custom' && !baseUrl) {
              setJson(res, 400, { error: 'baseUrl is required' })
              return
            }
            const current = readFreeModeState()
            const prevKeys = current.providerKeys ?? {}
            if (current.provider && current.apiKey) {
              prevKeys[current.provider] = current.apiKey
            }
            const resolvedKey = apiKey || prevKeys[providerType] || ''
            if (resolvedKey) {
              prevKeys[providerType] = resolvedKey
            }
            const currentModel = (current.model ?? '').trim()
            const resolvedModel = providerType === 'openrouter'
              ? (currentModel.includes('/') ? currentModel : FREE_MODE_DEFAULT_MODEL)
              : providerType === 'custom'
                ? await fetchCustomEndpointDefaultModel(baseUrl, resolvedKey)
                : OPENCODE_ZEN_DEFAULT_MODEL
            const state: FreeModeState = {
              enabled: true,
              apiKey: resolvedKey,
              model: resolvedModel,
              customKey: providerType === 'openrouter'
                ? shouldMarkOpenRouterKeyAsCustom(current, apiKey)
                : true,
              provider: providerType,
              customBaseUrl: providerType === 'custom' ? baseUrl : undefined,
              wireApi,
              providerKeys: prevKeys,
            }
            await writeFreeModeStateFile(statePath, state)
            appServer.dispose()
            setJson(res, 200, { ok: true })
          } catch (error) {
            setJson(res, 500, { error: getErrorMessage(error, 'Failed to set custom provider') })
          }
          return
        }

        next()
        return
      }

      if (url.pathname === '/codex-api/accounts/switch' && req.method === 'POST' && connections.active()) {
        releaseProviderChange = backendQueueProcessor.beginProviderChange()
        const previous = connections.active()!.storageId
        await connections.select(null)
        try {
          await handleAccountRoutes(req, res, url, { appServer })
          if (res.statusCode >= 400) await connections.select(previous)
        } catch (error) { await connections.select(previous); throw error }
        return
      }
      if (await handleAccountRoutes(req, res, url, { appServer })) {
        return
      }

      if (await handleSkillsRoutes(req, res, url, { appServer, readJsonBody })) {
        return
      }

      if (await handleReviewRoutes(req, res, url, { readJsonBody })) {
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/thread-terminal/status') {
        setJson(res, 200, terminalManager.getAvailability())
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/thread-terminal/quick-commands') {
        const cwd = url.searchParams.get('cwd')?.trim() ?? ''
        if (!cwd) {
          setJson(res, 400, { error: 'Missing cwd' })
          return
        }
        try {
          setJson(res, 200, { commands: await listTerminalQuickCommands(cwd) })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to load terminal quick commands') })
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/thread-terminal/attach') {
        const availability = terminalManager.getAvailability()
        if (!availability.available) {
          setJson(res, 503, { error: availability.reason || 'Integrated terminal is unavailable on this host' })
          return
        }
        const body = asRecord(await readJsonBody(req))
        const threadId = readNonEmptyString(body?.threadId)
        const cwd = readNonEmptyString(body?.cwd)
        if (!threadId || !cwd) {
          setJson(res, 400, { error: 'Missing threadId or cwd' })
          return
        }
        const session = terminalManager.attach({
          threadId,
          cwd,
          sessionId: readNonEmptyString(body?.sessionId) || undefined,
          cols: typeof body?.cols === 'number' ? body.cols : undefined,
          rows: typeof body?.rows === 'number' ? body.rows : undefined,
          newSession: body?.newSession === true,
        })
        setJson(res, 200, { session })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/thread-terminal/input') {
        const availability = terminalManager.getAvailability()
        if (!availability.available) {
          setJson(res, 503, { error: availability.reason || 'Integrated terminal is unavailable on this host' })
          return
        }
        const body = asRecord(await readJsonBody(req))
        const sessionId = readNonEmptyString(body?.sessionId)
        const data = typeof body?.data === 'string' ? body.data : ''
        if (!sessionId) {
          setJson(res, 400, { error: 'Missing sessionId' })
          return
        }
        terminalManager.write(sessionId, data)
        setJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/thread-terminal/resize') {
        const availability = terminalManager.getAvailability()
        if (!availability.available) {
          setJson(res, 503, { error: availability.reason || 'Integrated terminal is unavailable on this host' })
          return
        }
        const body = asRecord(await readJsonBody(req))
        const sessionId = readNonEmptyString(body?.sessionId)
        if (!sessionId) {
          setJson(res, 400, { error: 'Missing sessionId' })
          return
        }
        terminalManager.resize(sessionId, body?.cols, body?.rows)
        setJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/thread-terminal/close') {
        const availability = terminalManager.getAvailability()
        if (!availability.available) {
          setJson(res, 503, { error: availability.reason || 'Integrated terminal is unavailable on this host' })
          return
        }
        const body = asRecord(await readJsonBody(req))
        const sessionId = readNonEmptyString(body?.sessionId)
        if (!sessionId) {
          setJson(res, 400, { error: 'Missing sessionId' })
          return
        }
        terminalManager.close(sessionId)
        setJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/thread-terminal-snapshot') {
        const threadId = url.searchParams.get('threadId')?.trim() ?? ''
        if (!threadId) {
          setJson(res, 400, { error: 'Missing threadId' })
          return
        }
        setJson(res, 200, { session: terminalManager.getSnapshotForThread(threadId) })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/upload-file') {
        handleFileUpload(req, res)
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/rpc') {
        const payload = await readJsonBody(req)
        const body = asRecord(payload) as RpcProxyRequest | null
        if (payload !== null && payload !== undefined) {
          requestBodyBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
        }
        rpcMethod = body?.method && typeof body.method === 'string' ? body.method : null

	        if (!body || typeof body.method !== 'string' || body.method.length === 0) {
	          setJson(res, 400, { error: 'Invalid body: expected { method, params? }' })
	          return
	        }

	        if (body.method === 'generate-thread-title') {
	          setJson(res, 200, { result: { title: '' } })
	          return
	        }

	        if (body.method === 'account/rateLimits/read' && !(await hasUsableCodexAuth())) {
	          setJson(res, 200, { result: null })
	          return
	        }

        let rpcResult: unknown
        try {
          const params = asRecord(body.params) ?? {}
          if (['config/batchWrite', 'config/value/write', 'config/mcpServer/reload', 'plugin/install', 'plugin/uninstall'].includes(body.method)) directoryMcps.invalidate()
          if (body.method === 'turn/start' || body.method === 'turn/steer') throw new Error('发送接口已更新，请刷新页面后重试')
          if (body.method === 'thread/rollback') await history.assertRollbackAllowed(readNonEmptyString(params.threadId))
          if (body.method === 'plugin/list') {
            rpcResult = await directoryPlugins.read(params)
          } else if (body.method === 'thread/compact/start') {
            rpcResult = await threadCompactionGate.start(readNonEmptyString(params.threadId), params.repeatUnknown === true)
          } else if (body.method === 'thread/resume' || (body.method === 'thread/read' && params.includeTurns === true)) {
            rpcResult = await history.initial(body.method, params)
          } else {
            rpcResult = await callRpcWithArchiveRecovery(appServer, body.method, body.params ?? null)
          }
          if (['turn/start', 'turn/steer', 'thread/rollback', 'thread/archive', 'thread/unarchive', 'thread/name/set'].includes(body.method)) {
            const threadId = readNonEmptyString(params.threadId)
            if (threadId) {
              history.invalidate(threadId)
              search.invalidate(threadId)
            }
          }
        } catch (error) {
	          if (body.method === 'account/rateLimits/read' && isUnauthenticatedRateLimitError(error)) {
	            setJson(res, 200, { result: null })
	            return
	          }
		          if (body.method === 'thread/read' && isEmptyThreadReadError(error)) {
		            const params = asRecord(body.params)
		            const threadId = typeof params?.threadId === 'string' ? params.threadId.trim() : ''
		            const snapshot = threadId ? appServer.getLastThreadReadSnapshot(threadId) : null
		            if (snapshot) {
		              setJson(res, 200, { result: snapshot })
		              return
		            }
		          }
          if (body.method === 'thread/read' && isThreadMaterializationPendingError(error)) {
            const params = asRecord(body.params)
            const threadId = typeof params?.threadId === 'string' ? params.threadId.trim() : ''
            if (threadId) {
              setJson(res, 200, {
                result: {
                  thread: {
                    id: threadId,
                    turns: [],
                    status: { type: 'inProgress' },
                  },
                },
              })
              return
            }
          }
		          throw error
		        }
        const trimmedResult = trimThreadTurnsInRpcResult(body.method, rpcResult)
        const errorMergedResult = THREAD_METHODS_WITH_TURNS.has(body.method)
          ? mergeStreamTurnErrorsIntoThreadResult(appServer, trimmedResult)
          : trimmedResult
        const listMergedResult = body.method === 'thread/list'
          ? mergeImportedThreadsIntoThreadListResult(errorMergedResult, body.params)
          : errorMergedResult
        const sanitizedResult = await sanitizeThreadTurnsInlinePayloads(body.method, listMergedResult)
        const result = THREAD_METHODS_WITH_TURNS.has(body.method)
          ? await mergeSessionSkillInputsIntoThreadResult(sanitizedResult)
          : sanitizedResult

	        if (THREAD_METHODS_WITH_THREAD_SNAPSHOT.has(body.method)) {
	          const rpcRecord = asRecord(result)
	          const rpcThread = asRecord(rpcRecord?.thread)
	          const rpcThreadId = typeof rpcThread?.id === 'string' ? rpcThread.id : ''
          if (rpcThreadId) {
            appServer.storeThreadReadSnapshot(rpcThreadId, result)
          }
        }

        setJson(res, 200, { result })
        return
      }

      if (url.pathname.startsWith('/codex-api/process-activity/')) {
        const body = req.method === 'POST' ? asRecord(await readJsonBody(req)) : null
        const threadId = readNonEmptyString(body?.threadId) || url.searchParams.get('threadId')?.trim() || ''
        if (!threadId || threadId.length > 200) {
          setJson(res, 400, { error: '缺少有效会话 ID' })
          return
        }
        if (req.method === 'GET' && url.pathname.endsWith('/hooks')) {
          const snapshot = await sharedState.processActivity.snapshot(threadId)
          setJson(res, 200, { data: { ...snapshot, runs: snapshot.runs.map(run => ({ ...run, entries: run.entries.slice(0, 1).map(entry => ({ ...entry, text: entry.text.slice(0, 160) })) })) } })
          return
        }
        if (req.method === 'GET' && url.pathname.endsWith('/hook-detail')) {
          const snapshot = await sharedState.processActivity.snapshot(threadId)
          const run = snapshot.runs.find(run => hookRunKey(run) === url.searchParams.get('runKey'))
          setJson(res, run ? 200 : 404, run ? { data: run } : { error: 'Hook 记录已不在保留范围内' })
          return
        }
        if (req.method === 'GET' && url.pathname.endsWith('/hook-config')) {
          const cwd = url.searchParams.get('cwd')?.trim() || ''
          if (!cwd) throw new Error('缺少会话目录')
          setJson(res, 200, { data: readHookConfiguration(await appServer.rpc('hooks/list', { cwds: [cwd] }), cwd) })
          return
        }
        if (req.method === 'GET' && url.pathname.endsWith('/terminals')) {
          setJson(res, 200, { data: await backgroundTerminals.list(threadId) })
          return
        }
        if (req.method === 'POST' && url.pathname.endsWith('/terminate')) {
          const processId = readNonEmptyString(body?.processId)
          const itemId = readNonEmptyString(body?.itemId)
          if (!processId || !itemId) throw new Error('缺少进程或命令项 ID')
          setJson(res, 200, { data: await backgroundTerminals.terminate(threadId, processId, itemId) })
          return
        }
        if (req.method === 'GET' && url.pathname.endsWith('/output')) {
          const itemId = url.searchParams.get('itemId')?.trim() || ''
          if (!itemId) throw new Error('缺少命令项 ID')
          let output = sharedState.processActivity.output(threadId, itemId)
          if (!output?.text) {
            const page = await history.page(threadId, { limit: 10 })
            const thread = asRecord(asRecord(page.result)?.thread)
            const turns = thread?.turns
            if (Array.isArray(turns)) {
              for (const turn of turns) {
                const items = asRecord(turn)?.items
                if (!Array.isArray(items)) continue
                const item = items.find(item => asRecord(item)?.id === itemId)
                const saved = item ? readCommandOutput(item, 'history') : null
                if (saved?.text || !output) output = saved || output
              }
            }
            const command = sharedState.processActivity.command(threadId, itemId)
            const path = readNonEmptyString(thread?.path)
            if (!output?.text && command && path) {
              const text = await readCommandToolOutput(path, command)
              if (text) output = { itemId, text, status: output?.status || 'unknown', exitCode: output?.exitCode ?? null, truncated: true, source: 'toolResult' }
            }
          }
          setJson(res, 200, { data: output || { itemId, text: '', status: 'unknown', exitCode: null, truncated: false, source: 'unavailable' } })
          return
        }
        setJson(res, 404, { error: '未知进程操作' })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/directory/mcps') {
        try {
          const data = await directoryMcps.read(url.searchParams.get('threadId')?.trim() || '', url.searchParams.get('full') === 'true')
          setJson(res, 200, { data })
        } catch (error) {
          setJson(res, 502, { error: getErrorMessage(error, 'MCP 状态读取失败') })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/task-excerpt') {
        const threadId = url.searchParams.get('threadId')?.trim() || ''
        if (!threadId) {
          setJson(res, 400, { error: '缺少任务 ID' })
          return
        }
        try {
          const page = await history.page(threadId, { limit: 10 })
          setJson(res, 200, { data: extractTaskExcerpt(asRecord(page.result)?.thread, page.hasMoreOlder) })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, '任务摘录读取失败。') })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/thread-turn-page') {
        try {
          const threadId = url.searchParams.get('threadId')?.trim() ?? ''
          const beforeTurnId = url.searchParams.get('beforeTurnId')?.trim() ?? ''
          const limitRaw = url.searchParams.get('limit')?.trim() ?? String(THREAD_RESPONSE_TURN_LIMIT)
          const limit = Math.max(1, Math.min(50, Number.parseInt(limitRaw, 10) || THREAD_RESPONSE_TURN_LIMIT))
          if (!threadId) {
            setJson(res, 400, { error: 'Missing threadId' })
            return
          }

          const page = await history.page(threadId, {
            beforeTurnId,
            cursor: url.searchParams.get('cursor') || undefined,
            source: url.searchParams.get('source') || undefined,
            limit,
          })
          const withErrors = mergeStreamTurnErrorsIntoThreadResult(appServer, page.result)
          const sanitized = await sanitizeThreadTurnsInlinePayloads('thread/read', withErrors)
          const result = await mergeSessionSkillInputsIntoThreadResult(sanitized)
          setJson(res, 200, { ...page, result, startTurnIndex: 0 })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to load earlier thread messages') })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/thread-turn-items') {
        const threadId = url.searchParams.get('threadId')?.trim() ?? ''
        const turnId = url.searchParams.get('turnId')?.trim() ?? ''
        if (!threadId || !turnId) {
          setJson(res, 400, { error: 'Missing threadId or turnId' })
          return
        }
        const result = await history.turn(threadId, turnId)
        const sanitized = await sanitizeThreadTurnsInlinePayloads('thread/read', result)
        setJson(res, 200, { result: await mergeSessionSkillInputsIntoThreadResult(sanitized) })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/thread-fork-at-turn') {
        const params = asRecord(await readJsonBody(req))
        const threadId = readNonEmptyString(params?.threadId)
        const lastTurnId = readNonEmptyString(params?.lastTurnId)
        if (!threadId || !lastTurnId) {
          setJson(res, 400, { error: 'Missing threadId or lastTurnId' })
          return
        }
        const result = await history.fork(threadId, lastTurnId)
        search.invalidate()
        setJson(res, 200, { result })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/thread-file-change-fallback') {
        const threadId = url.searchParams.get('threadId')?.trim() ?? ''
        if (!threadId) {
          setJson(res, 400, { error: 'Missing threadId' })
          return
        }

        const threadReadResult = await appServer.rpc('thread/read', {
          threadId,
          includeTurns: true,
        })
        const threadReadRecord = asRecord(threadReadResult)
        const threadRecord = asRecord(threadReadRecord?.thread)
        const sessionPath = readNonEmptyString(threadRecord?.path)
        if (!sessionPath || !isAbsolute(sessionPath)) {
          setJson(res, 200, { data: [] })
          return
        }

        try {
          const sessionLogRaw = await readFile(sessionPath, 'utf8')
          setJson(res, 200, { data: buildSessionFileChangeFallback(threadReadResult, sessionLogRaw) })
        } catch {
          setJson(res, 200, { data: [] })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/thread-stream-events') {
        const threadId = url.searchParams.get('threadId')?.trim() ?? ''
        const limitRaw = url.searchParams.get('limit')?.trim() ?? '80'
        const limit = Math.max(1, Math.min(400, Number.parseInt(limitRaw, 10) || 80))
        if (!threadId) {
          setJson(res, 400, { error: 'Missing threadId' })
          return
        }
        const events = appServer.getStreamEvents(threadId, limit)
        setJson(res, 200, { events })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/thread-live-state') {
        const threadId = url.searchParams.get('threadId')?.trim() ?? ''
        if (!threadId) {
          setJson(res, 400, { error: 'Missing threadId' })
          return
        }

        try {
          const threadReadResult = mergeStreamTurnErrorsIntoThreadResult(appServer, await appServer.rpc('thread/read', {
            threadId,
            includeTurns: true,
          }))
          const sanitized = await sanitizeThreadTurnsInlinePayloads('thread/read', threadReadResult)
          appServer.storeThreadReadSnapshot(threadId, sanitized)

          const record = asRecord(sanitized)
          const thread = asRecord(record?.thread)
          const rawTurns = Array.isArray(thread?.turns) ? thread.turns : []

          const sessionPath = readNonEmptyString(thread?.path)
          let sessionSize = 0
          if (sessionPath && isAbsolute(sessionPath)) {
            try {
              const s = await stat(sessionPath)
              sessionSize = s.size
            } catch { /* missing */ }
          }

          const cached = appServer.getCachedLiveState(threadId, rawTurns.length, sessionSize)
          if (cached) {
            setJson(res, 200, cached)
            return
          }

          let turns = appServer.mergeItemsIntoTurns(threadId, rawTurns)

          if (sessionPath && isAbsolute(sessionPath) && sessionSize > 0) {
            try {
              const sessionLogRaw = await readFile(sessionPath, 'utf8')
              turns = mergeSessionCommandsIntoTurns(turns, sessionLogRaw)
            } catch {
              // Session log not available — continue without command recovery
            }
          }

          const lastTurn = turns.length > 0 ? asRecord(turns[turns.length - 1]) : null
          const isInProgress = lastTurn?.status === 'inProgress'

          const responseData = {
            threadId,
            conversationState: {
              turns,
            },
            ownerClientId: null,
            liveStateError: null,
            isInProgress,
          }

          if (!isInProgress) {
            appServer.cacheLiveState(threadId, responseData, rawTurns.length, sessionSize)
          }

          setJson(res, 200, responseData)
        } catch (error) {
          if (isThreadMaterializationPendingError(error)) {
            setJson(res, 200, {
              threadId,
              conversationState: { turns: [] },
              ownerClientId: null,
              liveStateError: null,
              isInProgress: true,
            })
            return
          }

          const snapshot = appServer.getLastThreadReadSnapshot(threadId)
          if (snapshot) {
            const record = asRecord(snapshot)
            const thread = asRecord(record?.thread)
            const rawTurns = Array.isArray(thread?.turns) ? thread.turns : []
            const turns = appServer.mergeItemsIntoTurns(threadId, rawTurns)
            setJson(res, 200, {
              threadId,
              conversationState: { turns },
              ownerClientId: null,
              liveStateError: {
                kind: 'readFailed',
                message: getErrorMessage(error, 'thread/read failed'),
              },
              isInProgress: false,
            })
          } else {
            setJson(res, 200, {
              threadId,
              conversationState: null,
              ownerClientId: null,
              liveStateError: {
                kind: 'readFailed',
                message: getErrorMessage(error, 'thread/read failed'),
              },
              isInProgress: false,
            })
          }
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/thread/rollback-files') {
        try {
          const body = asRecord(await readJsonBody(req))
          const threadId = readNonEmptyString(body?.threadId)
          const turnId = readNonEmptyString(body?.turnId)
          const cwd = readNonEmptyString(body?.cwd)
          const action = readNonEmptyString(body?.action) === 'redo' ? 'redo' : 'undo'
          const scope = readNonEmptyString(body?.scope) === 'single_turn' ? 'single_turn' : 'turn_and_later'
          const patchIds = Array.isArray(body?.patchIds)
            ? new Set(body.patchIds.filter((value): value is string => typeof value === 'string' && value.length > 0))
            : undefined
          if (!threadId || !turnId || !cwd) {
            setJson(res, 400, { error: 'Missing threadId, turnId, or cwd' })
            return
          }

          // Combined history rollback must be supported before any workspace file is changed.
          if (scope === 'turn_and_later') await history.assertRollbackAllowed(threadId)
          const threadReadResult = await appServer.rpc('thread/read', { threadId, includeTurns: true })
          const record = asRecord(threadReadResult)
          const thread = asRecord(record?.thread)
          const turns = Array.isArray(thread?.turns) ? thread.turns : []
          const sessionPath = readNonEmptyString(thread?.path)

          if (!sessionPath || !isAbsolute(sessionPath)) {
            setJson(res, 200, { reverted: 0, errors: [], message: 'No session log available' })
            return
          }

          let foundTurnIndex = -1
          const turnIdsToRevert = new Set<string>()
          for (let i = 0; i < turns.length; i++) {
            const turnRecord = asRecord(turns[i])
            const id = readNonEmptyString(turnRecord?.id)
            if (id === turnId) {
              foundTurnIndex = i
            }
            if (foundTurnIndex >= 0 && id) {
              turnIdsToRevert.add(id)
              if (scope === 'single_turn') break
            }
          }

          if (turnIdsToRevert.size === 0) {
            setJson(res, 200, { reverted: 0, errors: [], message: 'No turns to revert' })
            return
          }

          let sessionLogRaw: string
          try {
            sessionLogRaw = await readFile(sessionPath, 'utf8')
          } catch {
            setJson(res, 200, { reverted: 0, errors: ['Could not read session log'], message: 'Session log unreadable' })
            return
          }

          const turnInfos = collectFileChangesForTurns(sessionLogRaw, turnIdsToRevert, cwd)
          if (turnInfos.size === 0) {
            setJson(res, 200, { changed: 0, errors: [], message: action === 'redo' ? 'No file changes to redo' : 'No file changes to revert' })
            return
          }

          if (action === 'redo') {
            const result = await applyTurnFileChanges(cwd, turnInfos, patchIds)
            setJson(res, 200, { ...result, changed: result.applied, message: `Reapplied ${result.applied} file change(s)` })
            return
          }

          const result = await revertTurnFileChanges(cwd, turnInfos, patchIds)
          setJson(res, 200, { ...result, changed: result.reverted, message: `Reverted ${result.reverted} file change(s)` })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to revert file changes') })
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/transcribe') {
        const auth = await readCodexAuth()
        if (!auth) {
          setJson(res, 401, { error: 'No auth token available for transcription' })
          return
        }

        const rawBody = await readRawBody(req)
        const incomingCt = req.headers['content-type'] ?? 'application/octet-stream'
        const upstream = await proxyTranscribe(rawBody, incomingCt, auth.accessToken, auth.accountId)

        res.statusCode = upstream.status
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(upstream.body)
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/connector-logo') {
        const src = url.searchParams.get('src')?.trim() ?? ''
        if (!src) {
          setJson(res, 400, { error: 'Missing src' })
          return
        }
        try {
          const logo = await fetchConnectorLogo(src)
          res.statusCode = 200
          res.setHeader('Content-Type', logo.contentType)
          res.setHeader('Cache-Control', 'private, max-age=3600')
          res.end(logo.body)
        } catch (error) {
          setJson(res, 502, { error: getErrorMessage(error, 'Failed to fetch connector logo') })
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/server-requests/respond') {
        const payload = await readJsonBody(req)
        await appServer.respondToServerRequest(payload)
        setJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/server-requests/pending') {
        setJson(res, 200, { data: appServer.listPendingServerRequests(), authRecovery: appServer.authRecovery.snapshot() })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/meta/capabilities') {
        setJson(res, 200, { data: { appVersion, ...(await methodCatalog.snapshot()) } })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/meta/methods') {
        const methods = await methodCatalog.listMethods()
        setJson(res, 200, { data: methods })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/meta/notifications') {
        const methods = await methodCatalog.listNotificationMethods()
        setJson(res, 200, { data: methods })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/provider-models') {
        try {
          const custom = connections.active()
          if (custom) {
            setJson(res, 200, { data: customConnectionModels({ ...custom, hasApiKey: true }), source: 'custom', exclusive: true })
            return
          }
          const requestedProvider = url.searchParams.get('provider')?.trim() ?? ''
          if (requestedProvider) {
            setJson(res, 200, {
              ...(await readProviderModelIdsForProvider(appServer, requestedProvider)),
              exclusive: true,
            })
            return
          }
          const fmState = ensureDefaultFreeModeStateForMissingAuthSync(join(getCodexHomeDir(), FREE_MODE_STATE_FILE))
          if (fmState?.enabled) {
            if (fmState.provider === 'opencode-zen') {
              try {
                const modelIds = filterOpenCodeZenModelsForAuthState(
                  sortOpenCodeZenModelIds(await fetchOpenCodeZenModelIds(fmState.apiKey)),
                  fmState.apiKey,
                )
                if (modelIds.length > 0) {
                  setJson(res, 200, { data: modelIds, exclusive: true, source: 'opencode-zen' })
                  return
                }
              } catch {
                // OpenCode Zen model fetch failed
              }
              setJson(res, 200, { data: ['big-pickle', 'minimax-m2.5-free', 'nemotron-3-super-free', 'trinity-large-preview-free'], exclusive: true, source: 'opencode-zen' })
              return
            }
            if (fmState.provider === 'custom' && fmState.customBaseUrl) {
              try {
                const modelsUrl = fmState.customBaseUrl.replace(/\/+$/, '') + '/models'
                const headers: Record<string, string> = {}
                if (fmState.apiKey && fmState.apiKey !== 'dummy') {
                  headers['Authorization'] = `Bearer ${fmState.apiKey}`
                }
                const resp = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(8000) })
                if (resp.ok) {
                  const json = await resp.json() as unknown
                  const ids = normalizeProviderModelsData(json)
                  const currentModel = fmState.model?.trim() ?? ''
                  const orderedIds = currentModel && ids.includes(currentModel)
                    ? [currentModel, ...ids.filter((id) => id !== currentModel)]
                    : ids
                  setJson(res, 200, { data: orderedIds, exclusive: true, source: 'custom' })
                  return
                }
              } catch {
                // Custom endpoint model fetch failed — return empty list
              }
              setJson(res, 200, { data: [], exclusive: true, source: 'custom' })
              return
            }
            const freeModels = await getFreeModels()
            setJson(res, 200, { data: freeModels, exclusive: true })
            return
          }
        } catch {
          // No free-mode state — proceed normally
        }
        const data = await readProviderBackedModelIds(appServer)
        setJson(res, 200, data)
        return
      }

      if (url.pathname === '/codex-api/thread-completions') {
        if (req.method === 'GET') {
          setJson(res, 200, { data: await appServer.completions.read() })
          return
        }
        if (req.method === 'POST') {
          const payload = asRecord(await readJsonBody(req))
          await appServer.completions.acknowledge(readNonEmptyString(payload?.threadId), readNonEmptyString(payload?.token))
          setJson(res, 200, { ok: true })
          return
        }
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/workspace-roots-state') {
        const state = await readWorkspaceRootsState()
        setJson(res, 200, { data: state })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/thread-queue-state') {
        const state = await backendQueueProcessor.readState()
        setJson(res, 200, { data: state })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/home-directory') {
        setJson(res, 200, { data: { path: homedir() } })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/worktree/create') {
        const payload = asRecord(await readJsonBody(req))
        const rawSourceCwd = typeof payload?.sourceCwd === 'string' ? payload.sourceCwd.trim() : ''
        const baseBranch = typeof payload?.baseBranch === 'string' ? payload.baseBranch.trim() : ''
        if (!rawSourceCwd) {
          setJson(res, 400, { error: 'Missing sourceCwd' })
          return
        }

        const sourceCwd = isAbsolute(rawSourceCwd) ? rawSourceCwd : resolve(rawSourceCwd)
        try {
          const sourceInfo = await stat(sourceCwd)
          if (!sourceInfo.isDirectory()) {
            setJson(res, 400, { error: 'sourceCwd is not a directory' })
            return
          }
        } catch {
          setJson(res, 404, { error: 'sourceCwd does not exist' })
          return
        }

        try {
          let gitRoot = ''
          try {
            gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd: sourceCwd })
          } catch (error) {
            if (!isNotGitRepositoryError(error)) throw error
            await runCommand('git', ['init'], { cwd: sourceCwd })
            gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd: sourceCwd })
          }
          const repoName = basename(gitRoot) || 'repo'
          const worktreesRoot = join(getCodexHomeDir(), 'worktrees')
          await mkdir(worktreesRoot, { recursive: true })

          // Match Codex desktop layout so project grouping resolves to repo name:
          // ~/.codex/worktrees/<id>/<repoName>
          let worktreeId = ''
          let worktreeParent = ''
          let worktreeCwd = ''
          for (let attempt = 0; attempt < 12; attempt += 1) {
            const candidate = randomBytes(2).toString('hex')
            const parent = join(worktreesRoot, candidate)
            try {
              await stat(parent)
              continue
            } catch {
              worktreeId = candidate
              worktreeParent = parent
              worktreeCwd = join(parent, repoName)
              break
            }
          }
          if (!worktreeId || !worktreeParent || !worktreeCwd) {
            throw new Error('Failed to allocate a unique worktree id')
          }
          const startPoint = baseBranch || 'HEAD'

          await mkdir(worktreeParent, { recursive: true })
          try {
            await runCommand('git', ['worktree', 'add', '--detach', worktreeCwd, startPoint], { cwd: gitRoot })
          } catch (error) {
            if (!isMissingHeadError(error)) throw error
            await ensureRepoHasInitialCommit(gitRoot)
            await runCommand('git', ['worktree', 'add', '--detach', worktreeCwd, startPoint], { cwd: gitRoot })
          }
          try {
            await persistWorkspaceRoot(worktreeCwd)
          } catch (error) {
            await rollbackCreatedWorktree(gitRoot, worktreeCwd, worktreeParent)
            throw error
          }

          setJson(res, 200, {
            data: {
              cwd: worktreeCwd,
              branch: null,
              gitRoot,
            },
          })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to create worktree') })
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/worktree/create-permanent') {
        const payload = asRecord(await readJsonBody(req))
        const rawSourceCwd = typeof payload?.sourceCwd === 'string' ? payload.sourceCwd.trim() : ''
        const rawWorktreeName = typeof payload?.worktreeName === 'string' ? payload.worktreeName.trim() : ''
        if (!rawSourceCwd) {
          setJson(res, 400, { error: 'Missing sourceCwd' })
          return
        }
        if (!rawWorktreeName) {
          setJson(res, 400, { error: 'Missing worktreeName' })
          return
        }
        if (rawWorktreeName.includes('/') || rawWorktreeName.includes('\\') || rawWorktreeName === '.' || rawWorktreeName === '..') {
          setJson(res, 400, { error: 'Worktree name must be a single folder name' })
          return
        }

        const sourceCwd = isAbsolute(rawSourceCwd) ? rawSourceCwd : resolve(rawSourceCwd)
        try {
          const sourceInfo = await stat(sourceCwd)
          if (!sourceInfo.isDirectory()) {
            setJson(res, 400, { error: 'sourceCwd is not a directory' })
            return
          }
        } catch {
          setJson(res, 404, { error: 'sourceCwd does not exist' })
          return
        }

        try {
          let gitRoot = ''
          try {
            gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd: sourceCwd })
          } catch (error) {
            if (!isNotGitRepositoryError(error)) throw error
            await runCommand('git', ['init'], { cwd: sourceCwd })
            gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd: sourceCwd })
          }
          const worktreeCwd = join(dirname(gitRoot), rawWorktreeName)
          try {
            await stat(worktreeCwd)
            setJson(res, 409, { error: 'Worktree folder already exists' })
            return
          } catch {
            // Expected for a new worktree path.
          }

          const branchName = await allocatePermanentWorktreeBranchName(gitRoot, rawWorktreeName)
          try {
            await runCommand('git', ['worktree', 'add', '-b', branchName, worktreeCwd, 'HEAD'], { cwd: gitRoot })
          } catch (error) {
            if (!isMissingHeadError(error)) throw error
            await ensureRepoHasInitialCommit(gitRoot)
            await runCommand('git', ['worktree', 'add', '-b', branchName, worktreeCwd, 'HEAD'], { cwd: gitRoot })
          }
          try {
            await persistWorkspaceRoot(worktreeCwd)
          } catch (error) {
            await rollbackCreatedWorktree(gitRoot, worktreeCwd, undefined, branchName)
            throw error
          }

          setJson(res, 200, {
            data: {
              cwd: worktreeCwd,
              branch: branchName,
              gitRoot,
            },
          })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to create worktree') })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/worktree/branches') {
        const rawSourceCwd = (url.searchParams.get('sourceCwd') ?? '').trim()
        if (!rawSourceCwd) {
          setJson(res, 400, { error: 'Missing sourceCwd' })
          return
        }
        const sourceCwd = isAbsolute(rawSourceCwd) ? rawSourceCwd : resolve(rawSourceCwd)
        try {
          const sourceInfo = await stat(sourceCwd)
          if (!sourceInfo.isDirectory()) {
            setJson(res, 400, { error: 'sourceCwd is not a directory' })
            return
          }
        } catch {
          setJson(res, 404, { error: 'sourceCwd does not exist' })
          return
        }

        try {
          let gitRoot = ''
          try {
            gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd: sourceCwd })
          } catch (error) {
            if (!isNotGitRepositoryError(error)) throw error
            setJson(res, 200, { data: [] })
            return
          }
          const output = await runCommandCapture(
            'git',
            ['for-each-ref', '--format=%(committerdate:unix)\t%(refname)', 'refs/heads', 'refs/remotes'],
            { cwd: gitRoot },
          )
          const branchActivityByName = new Map<string, number>()
          for (const line of output.split('\n')) {
            const [rawTimestamp = '', rawRefName = ''] = line.split('\t')
            const normalized = normalizeBranchRefName(rawRefName)
            if (!normalized || normalized === 'origin/HEAD') continue
            const parsedTimestamp = Number.parseInt(rawTimestamp.trim(), 10)
            const timestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : 0
            const current = branchActivityByName.get(normalized) ?? Number.MIN_SAFE_INTEGER
            if (timestamp > current) {
              branchActivityByName.set(normalized, timestamp)
            }
          }

          const branches = Array.from(branchActivityByName.entries())
            .map(([value]) => ({ value, label: value }))
            .sort((a, b) => {
              const aActivity = branchActivityByName.get(a.value) ?? 0
              const bActivity = branchActivityByName.get(b.value) ?? 0
              if (bActivity !== aActivity) return bActivity - aActivity
              return a.value.localeCompare(b.value)
            })
          setJson(res, 200, { data: branches })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to list branches') })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/git/branches') {
        const rawCwd = (url.searchParams.get('cwd') ?? '').trim()
        if (!rawCwd) {
          setJson(res, 400, { error: 'Missing cwd' })
          return
        }
        const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd)
        try {
          const cwdInfo = await stat(cwd)
          if (!cwdInfo.isDirectory()) {
            setJson(res, 400, { error: 'cwd is not a directory' })
            return
          }
        } catch {
          setJson(res, 404, { error: 'cwd does not exist' })
          return
        }

        try {
          let gitRoot = ''
          try {
            gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd })
          } catch (error) {
            if (!isNotGitRepositoryError(error)) throw error
            setJson(res, 200, {
              data: {
                currentBranch: null,
                options: [],
              },
            })
            return
          }

          const state = await readGitHeaderState(gitRoot)
          const currentBranch = state.currentBranch
          const output = await runCommandCapture(
            'git',
            ['for-each-ref', '--format=%(committerdate:unix)\t%(refname)\t%(objectname)', 'refs/heads', 'refs/remotes'],
            { cwd: gitRoot },
          )
          const branchActivityByName = new Map<string, { timestamp: number; isRemote: boolean }>()
          for (const line of output.split('\n')) {
            const [rawTimestamp = '', rawRefName = ''] = line.split('\t')
            const normalized = normalizeBranchRefName(rawRefName)
            if (!normalized || normalized === 'origin/HEAD') continue
            const parsedTimestamp = Number.parseInt(rawTimestamp.trim(), 10)
            const timestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : 0
            const isRemote = rawRefName.trim().startsWith('refs/remotes/')
            const current = branchActivityByName.get(normalized)
            if (!current || timestamp > current.timestamp) {
              branchActivityByName.set(normalized, { timestamp, isRemote })
            }
          }
          if (currentBranch && !branchActivityByName.has(currentBranch)) {
            branchActivityByName.set(currentBranch, { timestamp: Number.MAX_SAFE_INTEGER, isRemote: false })
          }
          const options = Array.from(branchActivityByName.entries())
            .map(([value, metadata]) => ({
              value,
              label: value,
              isCurrent: value === currentBranch,
              isRemote: metadata.isRemote,
            }))
            .sort((a, b) => {
              const aActivity = branchActivityByName.get(a.value)?.timestamp ?? 0
              const bActivity = branchActivityByName.get(b.value)?.timestamp ?? 0
              if (bActivity !== aActivity) return bActivity - aActivity
              return a.value.localeCompare(b.value)
            })
          setJson(res, 200, {
            data: {
              ...state,
              options,
            },
          })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to read Git branches') })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/git/repository-status') {
        const rawCwd = (url.searchParams.get('cwd') ?? '').trim()
        if (!rawCwd) {
          setJson(res, 400, { error: 'Missing cwd' })
          return
        }
        const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd)
        try {
          const cwdInfo = await stat(cwd)
          if (!cwdInfo.isDirectory()) {
            setJson(res, 400, { error: 'cwd is not a directory' })
            return
          }
        } catch {
          setJson(res, 404, { error: 'cwd does not exist' })
          return
        }

        try {
          const gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd })
          setJson(res, 200, {
            data: {
              isGitRepo: true,
              gitRoot,
            },
          })
        } catch (error) {
          if (!isNotGitRepositoryError(error)) {
            setJson(res, 500, { error: getErrorMessage(error, 'Failed to read Git repository status') })
            return
          }
          setJson(res, 200, {
            data: {
              isGitRepo: false,
              gitRoot: '',
            },
          })
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/git/checkout') {
        const payload = await readJsonBody(req)
        const record = asRecord(payload)
        if (!record) {
          setJson(res, 400, { error: 'Invalid body: expected object' })
          return
        }
        const rawCwd = readNonEmptyString(record.cwd)
        const targetBranch = readNonEmptyString(record.branch)
        if (!rawCwd) {
          setJson(res, 400, { error: 'Missing cwd' })
          return
        }
        if (!targetBranch) {
          setJson(res, 400, { error: 'Missing branch' })
          return
        }
        const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd)
        try {
          const cwdInfo = await stat(cwd)
          if (!cwdInfo.isDirectory()) {
            setJson(res, 400, { error: 'cwd is not a directory' })
            return
          }
        } catch {
          setJson(res, 404, { error: 'cwd does not exist' })
          return
        }
        try {
          const gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd })
          await assertNoTrackedGitChanges(gitRoot)
          await assertLocalGitBranch(gitRoot, targetBranch)
          await checkoutGitBranchWithWorktreeRecovery(gitRoot, targetBranch)
          setJson(res, 200, { data: await readGitHeaderState(gitRoot) })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to switch branch') })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/git/branch-commits') {
        const rawCwd = (url.searchParams.get('cwd') ?? '').trim()
        const branch = (url.searchParams.get('branch') ?? '').trim()
        const includeResetHistory = url.searchParams.get('includeResetHistory') !== 'false'
        if (!rawCwd) {
          setJson(res, 400, { error: 'Missing cwd' })
          return
        }
        if (!branch) {
          setJson(res, 400, { error: 'Missing branch' })
          return
        }
        const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd)
        try {
          const gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd })
          await runCommandCapture('git', ['rev-parse', '--verify', `${branch}^{commit}`], { cwd: gitRoot })
          let resetHistoryRefs: string[] = []
          if (includeResetHistory) {
            const resetHistoryRefPrefix = `refs/codex/header-git-reset-history/${branch}/`
            const resetHistoryRefsRaw = await runCommandCapture(
              'git',
              ['for-each-ref', '--sort=-creatordate', '--format=%(refname)', resetHistoryRefPrefix],
              { cwd: gitRoot },
            ).catch(() => '')
            resetHistoryRefs = resetHistoryRefsRaw
              .split('\n')
              .map((entry) => entry.trim())
              .filter(Boolean)
              .slice(0, HEADER_GIT_RESET_HISTORY_REF_LIMIT)
          }
          const output = await runCommandCapture(
            'git',
            ['log', '-n', '50', '--date=short', '--format=%H%x09%h%x09%cd%x09%s', branch, ...resetHistoryRefs],
            { cwd: gitRoot },
          )
          const commits = output.split('\n').flatMap((line) => {
            const [sha = '', shortSha = '', date = '', ...subjectParts] = line.split('\t')
            const subject = subjectParts.join('\t').trim()
            return sha.trim() && shortSha.trim()
              ? [{ sha: sha.trim(), shortSha: shortSha.trim(), date: date.trim(), subject: subject || shortSha.trim() }]
              : []
          })
          setJson(res, 200, { data: commits })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to load branch commits') })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/git/commit-files') {
        const rawCwd = (url.searchParams.get('cwd') ?? '').trim()
        const sha = (url.searchParams.get('sha') ?? '').trim()
        if (!rawCwd) {
          setJson(res, 400, { error: 'Missing cwd' })
          return
        }
        if (!sha) {
          setJson(res, 400, { error: 'Missing sha' })
          return
        }
        const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd)
        try {
          const gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd })
          await runCommandCapture('git', ['rev-parse', '--verify', `${sha}^{commit}`], { cwd: gitRoot })
          const output = await runCommandCaptureRaw(
            'git',
            ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-M', '-z', sha],
            { cwd: gitRoot },
          )
          const numstatOutput = await runCommandCaptureRaw(
            'git',
            ['diff-tree', '--root', '--no-commit-id', '--numstat', '-r', '-M', '-z', sha],
            { cwd: gitRoot },
          )
          const splitNumstatRecord = (record: string): { addedRaw: string; removedRaw: string; path: string } | null => {
            const firstTab = record.indexOf('\t')
            if (firstTab < 0) return null
            const secondTab = record.indexOf('\t', firstTab + 1)
            if (secondTab < 0) return null
            return {
              addedRaw: record.slice(0, firstTab),
              removedRaw: record.slice(firstTab + 1, secondTab),
              path: record.slice(secondTab + 1),
            }
          }
          const lineCountsByPath = new Map<string, { addedLineCount: number | null; removedLineCount: number | null }>()
          const numstatRecords = splitGitPathList(numstatOutput)
          for (let index = 0; index < numstatRecords.length; index += 1) {
            const record = splitNumstatRecord(numstatRecords[index] ?? '')
            if (!record) continue
            const { addedRaw, removedRaw } = record
            const path = record.path || numstatRecords[index + 2] || numstatRecords[index + 1] || ''
            if (!record.path) index += 2
            if (!path) continue
            const addedLineCount = /^\d+$/.test(addedRaw) ? Number(addedRaw) : null
            const removedLineCount = /^\d+$/.test(removedRaw) ? Number(removedRaw) : null
            lineCountsByPath.set(path, { addedLineCount, removedLineCount })
          }
          const nameStatusRecords = splitGitPathList(output)
          const files: Array<{
            path: string
            previousPath: string | null
            status: string
            label: string
            addedLineCount: number | null
            removedLineCount: number | null
          }> = []
          for (let index = 0; index < nameStatusRecords.length; index += 1) {
            const status = nameStatusRecords[index] ?? ''
            if (!status) continue
            const statusKind = status.charAt(0)
            const isRenameOrCopy = statusKind === 'R' || statusKind === 'C'
            const previousPath = isRenameOrCopy ? nameStatusRecords[index + 1] || null : null
            const path = isRenameOrCopy ? nameStatusRecords[index + 2] || '' : nameStatusRecords[index + 1] || ''
            index += isRenameOrCopy ? 2 : 1
            if (!path) continue
            const label = statusKind === 'A'
              ? 'Added'
              : statusKind === 'D'
                ? 'Deleted'
                : statusKind === 'R'
                  ? 'Renamed'
                  : statusKind === 'C'
                    ? 'Copied'
                    : statusKind === 'M'
                      ? 'Modified'
                      : status
            const lineCounts = lineCountsByPath.get(path) ?? { addedLineCount: null, removedLineCount: null }
            files.push({ path, previousPath, status, label, ...lineCounts })
          }
          setJson(res, 200, { data: files })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to load commit files') })
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/git/reset-to-commit') {
        const payload = await readJsonBody(req)
        const record = asRecord(payload)
        if (!record) {
          setJson(res, 400, { error: 'Invalid body: expected object' })
          return
        }
        const rawCwd = readNonEmptyString(record.cwd)
        const branch = readNonEmptyString(record.branch)
        const sha = readNonEmptyString(record.sha)
        if (!rawCwd) {
          setJson(res, 400, { error: 'Missing cwd' })
          return
        }
        if (!branch) {
          setJson(res, 400, { error: 'Missing branch' })
          return
        }
        if (!sha) {
          setJson(res, 400, { error: 'Missing commit' })
          return
        }
        const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd)
        try {
          const gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd })
          await assertNoTrackedGitChanges(gitRoot)
          await assertLocalGitBranch(gitRoot, branch)
          const currentBranch = (await runCommandCapture('git', ['branch', '--show-current'], { cwd: gitRoot })).trim()
          if (currentBranch && currentBranch !== branch) {
            await checkoutGitBranchWithWorktreeRecovery(gitRoot, branch)
          } else if (!currentBranch) {
            await checkoutGitBranchWithWorktreeRecovery(gitRoot, branch)
          }
          const previousTip = await runCommandCapture('git', ['rev-parse', 'HEAD'], { cwd: gitRoot })
          const targetSha = await runCommandCapture('git', ['rev-parse', '--verify', `${sha}^{commit}`], { cwd: gitRoot })
          await runCommand('git', ['update-ref', toHeaderGitResetHistoryRef(branch, previousTip.trim()), previousTip.trim()], { cwd: gitRoot })
          await pruneHeaderGitResetHistoryRefs(gitRoot, branch)
          await withPreservedUntrackedFilesForGitTarget(gitRoot, targetSha.trim(), async () => {
            await runCommand('git', ['reset', '--hard', targetSha.trim()], { cwd: gitRoot })
          })
          setJson(res, 200, { data: await readGitHeaderState(gitRoot) })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to reset branch to commit') })
        }
        return
      }



      if (req.method === 'PUT' && url.pathname === '/codex-api/workspace-roots-state') {
        const payload = await readJsonBody(req)
        const record = asRecord(payload)
        if (!record) {
          setJson(res, 400, { error: 'Invalid body: expected object' })
          return
        }
        await updateWorkspaceRootsState((existingState) => ({
          order: normalizeStringArray(record.order),
          labels: normalizeStringRecord(record.labels),
          active: normalizeStringArray(record.active),
          projectOrder: Array.isArray(record.projectOrder)
            ? normalizeStringArray(record.projectOrder)
            : existingState.projectOrder,
          remoteProjects: existingState.remoteProjects,
        }))
        setJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/delivery-context') {
        setJson(res, 200, { data: { contextId: await backendQueueProcessor.deliveryContext() } })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/delivery-status') {
        setJson(res, 200, { data: await backendQueueProcessor.readDeliveryStatuses(
          url.searchParams.get('threadId') || '', (url.searchParams.get('ids') || '').split(',').filter(Boolean),
        ) })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/delivery') {
        try {
          const result = await backendQueueProcessor.submit(await readJsonBody(req))
          setJson(res, 200, { data: result })
        } catch (error) {
          setJson(res, 409, { error: getErrorMessage(error, '提交消息失败') })
        }
        return
      }

      if (req.method === 'PUT' && url.pathname === '/codex-api/thread-queue-state') {
        setJson(res, 409, { error: '队列接口已更新，请刷新页面后重试' })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/thread-queue-state') {
        const operation = await readJsonBody(req)
        try {
          const result = await backendQueueProcessor.mutate(operation)
          setJson(res, 200, { data: result })
        } catch (error) {
          setJson(res, 409, { error: error instanceof Error ? error.message : '队列保存失败' })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/project-files') {
        const project = await getVirtualProjectStore().get(url.searchParams.get('id') ?? '')
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(await createDirectoryListingHtml(project.label, { entries: project.cwds.map(cwd => ({ name: basename(cwd), path: cwd })) }))
        return
      }

      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/codex-api/project-zip') {
        const rawCwd = (url.searchParams.get('cwd') ?? '').trim()
        if (isVirtualProjectId(rawCwd)) {
          const project = await getVirtualProjectStore().get(rawCwd)
          const roots = await Promise.all(project.cwds.map(async (cwd, index) => ({ root: await resolveAllowedProjectZipCwd(cwd), prefix: `files/${String(index + 1).padStart(6, '0')}/` })))
          const entries = req.method === 'HEAD' ? [] : await collectProjectChatZipEntries(project)
          setProjectZipHeaders(res, toProjectZipFileName(project.label))
          if (req.method !== 'HEAD') await streamProjectZip('', res, entries, roots)
          res.end()
          return
        }
        if (!rawCwd) {
          setJson(res, 400, { error: 'Missing cwd' })
          return
        }
        let cwd = ''
        try {
          cwd = await resolveAllowedProjectZipCwd(rawCwd)
        } catch (error) {
          const message = getErrorMessage(error, 'Failed to validate project')
          if (message === 'cwd is not a directory') {
            setJson(res, 400, { error: message })
          } else if (getErrorCode(error) === 'ENOENT') {
            setJson(res, 404, { error: 'cwd does not exist' })
          } else {
            setJson(res, 403, { error: message })
          }
          return
        }

        try {
          setProjectZipHeaders(res, toProjectZipFileName(cwd))
          if (req.method === 'HEAD') {
            res.end()
            return
          }
          const chatEntries = await collectProjectChatZipEntries(cwd)
          await streamProjectZip(cwd, res, chatEntries)
          res.end()
        } catch (error) {
          if (!res.headersSent) {
            setJson(res, 500, { error: getErrorMessage(error, 'Failed to export project') })
          } else {
            res.destroy(error instanceof Error ? error : new Error('Failed to export project'))
          }
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/project-import') {
        const rawParent = (url.searchParams.get('parent') ?? '').trim()
        if (!rawParent) {
          setJson(res, 400, { error: 'Missing parent' })
          return
        }
        const parent = isAbsolute(rawParent) ? rawParent : resolve(rawParent)
        try {
          const parentInfo = await stat(parent)
          if (!parentInfo.isDirectory()) {
            setJson(res, 400, { error: 'Destination folder is not a directory' })
            return
          }
        } catch {
          setJson(res, 404, { error: 'Destination folder does not exist' })
          return
        }

        try {
          const buffer = await readRawBody(req)
          if (buffer.length === 0) {
            setJson(res, 400, { error: 'Missing project ZIP' })
            return
          }
          const result = await importProjectZip(buffer, parent)
          search.invalidate()
          setJson(res, 200, { data: { path: result.projectPath, importedSessions: result.importedSessions } })
        } catch (error) {
          setJson(res, 400, { error: getErrorMessage(error, 'Failed to import project') })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/project-directories') {
        const root = url.searchParams.get('path') ?? ''
        if (isVirtualProjectId(root)) {
          setJson(res, 200, { data: [] })
          return
        }
        if (!isAbsolute(root)) {
          setJson(res, 400, { error: '工作目录必须填写绝对路径' })
          return
        }
        try {
          setJson(res, 200, { data: await readProjectDirectories(root) })
        } catch (error) {
          setJson(res, 400, { error: getErrorMessage(error, '读取项目工作目录失败') })
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/project-membership') {
        const payload = asRecord(await readJsonBody(req))
        const cwd = typeof payload?.cwd === 'string' ? payload.cwd : ''
        const projectId = typeof payload?.projectId === 'string' ? payload.projectId : null
        await getVirtualProjectStore().assign(cwd, projectId)
        setJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'DELETE' && url.pathname === '/codex-api/project-root') {
        const id = url.searchParams.get('id') ?? ''
        if (!isVirtualProjectId(id)) { setJson(res, 400, { error: 'Invalid project' }); return }
        await getVirtualProjectStore().remove(id)
        await updateWorkspaceRootsState(state => ({ ...state, projectOrder: state.projectOrder.filter(item => item !== id) }))
        setJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/project-root') {
        const payload = asRecord(await readJsonBody(req))
        const rawPath = typeof payload?.path === 'string' ? payload.path.trim() : ''
        const createIfMissing = payload?.createIfMissing === true
        const label = typeof payload?.label === 'string' ? payload.label : ''
        if (!rawPath || isVirtualProjectId(rawPath)) {
          const project = await getVirtualProjectStore().save(rawPath || undefined, label)
          await updateWorkspaceRootsState(state => ({ ...state, projectOrder: prependUniqueString(project.id, state.projectOrder) }))
          setJson(res, 200, { data: { path: project.id } })
          return
        }

        const normalizedPath = isAbsolute(rawPath) ? rawPath : resolve(rawPath)
        let pathExists = true
        try {
          const info = await stat(normalizedPath)
          if (!info.isDirectory()) {
            setJson(res, 400, { error: 'Path exists but is not a directory' })
            return
          }
        } catch {
          pathExists = false
        }

        if (!pathExists && createIfMissing) {
          await mkdir(normalizedPath, { recursive: true })
        } else if (!pathExists) {
          setJson(res, 404, { error: 'Directory does not exist' })
          return
        }

        if (payload && Object.hasOwn(payload, 'directories')) {
          try {
            await queueWorkspaceRootsMutation(() => saveProjectDirectories(normalizedPath, payload.directories))
          } catch (error) {
            setJson(res, 400, { error: getErrorMessage(error, '保存项目工作目录失败') })
            return
          }
        }
        await persistWorkspaceRoot(normalizedPath, label)
        setJson(res, 200, { data: { path: normalizedPath } })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/local-directory') {
        const payload = asRecord(await readJsonBody(req))
        const rawPath = typeof payload?.path === 'string' ? payload.path.trim() : ''
        if (!rawPath) {
          setJson(res, 400, { error: 'Missing path' })
          return
        }

        const normalizedPath = isAbsolute(rawPath) ? rawPath : resolve(rawPath)
        try {
          const info = await stat(normalizedPath)
          if (!info.isDirectory()) {
            setJson(res, 400, { error: 'Path exists but is not a directory' })
            return
          }
        } catch {
          await mkdir(normalizedPath, { recursive: true })
        }

        setJson(res, 200, { data: { path: normalizedPath } })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/github-clone') {
        const payload = asRecord(await readJsonBody(req))
        const repoUrl = typeof payload?.url === 'string' ? payload.url.trim() : ''
        const basePath = typeof payload?.basePath === 'string' ? payload.basePath.trim() : ''
        try {
          const clonedPath = await cloneGithubRepositoryIntoBase(repoUrl, basePath)
          setJson(res, 200, { data: { path: clonedPath } })
        } catch (error) {
          setJson(res, 400, { error: error instanceof Error ? error.message : 'Failed to clone GitHub repository' })
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/projectless-thread-cwd') {
        const payload = asRecord(await readJsonBody(req))
        const prompt = typeof payload?.prompt === 'string' ? payload.prompt : null
        try {
          const projectId = typeof payload?.projectId === 'string' ? payload.projectId : ''
          const directory = projectId ? await createProjectConversationDirectory(prompt, projectId) : await createProjectlessThreadDirectory(prompt)
          setJson(res, 200, { data: directory })
        } catch (error) {
          setJson(res, 500, { error: error instanceof Error ? error.message : 'Failed to create new chat folder' })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/project-root-suggestion') {
        const basePath = url.searchParams.get('basePath')?.trim() ?? ''
        if (!basePath) {
          setJson(res, 400, { error: 'Missing basePath' })
          return
        }
        const normalizedBasePath = isAbsolute(basePath) ? basePath : resolve(basePath)
        try {
          const baseInfo = await stat(normalizedBasePath)
          if (!baseInfo.isDirectory()) {
            setJson(res, 400, { error: 'basePath is not a directory' })
            return
          }
        } catch {
          setJson(res, 404, { error: 'basePath does not exist' })
          return
        }

        let index = 1
        while (index < 100000) {
          const candidateName = `New Project (${String(index)})`
          const candidatePath = join(normalizedBasePath, candidateName)
          try {
            await stat(candidatePath)
            index += 1
            continue
          } catch {
            setJson(res, 200, { data: { name: candidateName, path: candidatePath } })
            return
          }
        }

        setJson(res, 500, { error: 'Failed to compute project name suggestion' })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/composer-file-search') {
        const payload = asRecord(await readJsonBody(req))
        const rawCwd = typeof payload?.cwd === 'string' ? payload.cwd.trim() : ''
        const query = typeof payload?.query === 'string' ? payload.query.trim() : ''
        const limitRaw = typeof payload?.limit === 'number' ? payload.limit : 20
        const limit = Math.max(1, Math.min(100, Math.floor(limitRaw)))
        if (!rawCwd) {
          setJson(res, 400, { error: 'Missing cwd' })
          return
        }
        const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd)
        try {
          const info = await stat(cwd)
          if (!info.isDirectory()) {
            setJson(res, 400, { error: 'cwd is not a directory' })
            return
          }
        } catch {
          setJson(res, 404, { error: 'cwd does not exist' })
          return
        }

        try {
          const files = await listFilesWithRipgrep(cwd)
          const scored = files
            .map((path) => ({ path, score: scoreFileCandidate(path, query) }))
            .filter((row) => query.length === 0 || row.score < 10)
            .sort((a, b) => (a.score - b.score) || a.path.localeCompare(b.path))
            .slice(0, limit)
            .map((row) => ({ path: row.path }))
          setJson(res, 200, { data: scored })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to search files') })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/prompts') {
        setJson(res, 200, { data: await listComposerPrompts() })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/prompts') {
        const payload = asRecord(await readJsonBody(req))
        const name = typeof payload?.name === 'string' ? payload.name.trim() : ''
        const content = typeof payload?.content === 'string' ? payload.content : ''
        if (!name || !content.trim()) {
          setJson(res, 400, { error: 'Prompt name and content are required' })
          return
        }
        try {
          const prompt = await createComposerPromptFile(name, content)
          setJson(res, 200, { data: prompt })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to create prompt') })
        }
        return
      }

      if (req.method === 'DELETE' && url.pathname === '/codex-api/prompts') {
        const promptPath = url.searchParams.get('path')?.trim() ?? ''
        if (!promptPath) {
          setJson(res, 400, { error: 'Missing path' })
          return
        }
        try {
          const removed = await removeComposerPromptFile(promptPath)
          setJson(res, 200, { data: { removed } })
        } catch (error) {
          setJson(res, 400, { error: getErrorMessage(error, 'Failed to remove prompt') })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/thread-titles') {
        const cache = await readMergedThreadTitleCache()
        setJson(res, 200, { data: cache })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/thread-pins') {
        const threadIds = await readPinnedThreadIds()
        setJson(res, 200, { data: { threadIds } })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/preferences/first-launch-plugins-card') {
        const dismissed = await readFirstLaunchPluginsCardDismissed()
        setJson(res, 200, { data: { dismissed } })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/runtime/activity') {
        setJson(res, 200, { data: appServer.liveActivity() })
        return
      }
      if (req.method === 'GET' && url.pathname === '/codex-api/automation-runtime') {
        await automationEngine.readyPromise
        setJson(res, 200, { data: automationEngine.snapshot() })
        return
      }
      if (req.method === 'GET' && url.pathname === '/codex-api/automation-runs') {
        setJson(res, 200, await automationEngine.historyPage(url.searchParams.get('automationId') ?? '', url.searchParams.get('cursor'), Number(url.searchParams.get('limit') || 5)))
        return
      }
      if (req.method === 'POST' && url.pathname === '/codex-api/automation-runtime/drain') {
        const payload = asRecord(await readJsonBody(req))
        setJson(res, 200, { data: await automationEngine.drain(payload?.draining !== false) })
        return
      }
      if (req.method === 'POST' && ['/codex-api/thread-automation/run', '/codex-api/project-automation/run', '/codex-api/automation-run/retry'].includes(url.pathname)) {
        const payload = asRecord(await readJsonBody(req))
        const run = await automationEngine.manual(String(payload?.automationId ?? ''), String(payload?.threadId ?? payload?.projectName ?? payload?.target ?? ''), String(payload?.requestId ?? ''), typeof payload?.retryOf === 'string' ? payload.retryOf : undefined)
        setJson(res, 200, { data: { queued: run.status === 'queued', run } })
        void automationEngine.tick()
        return
      }
      if (url.pathname === '/codex-api/thread-quota-resume' && ['GET', 'POST'].includes(req.method || '')) {
        if (req.method === 'POST') {
          const input = asRecord(await readJsonBody(req))
          if (typeof input?.threadId !== 'string' || typeof input.enabled !== 'boolean') {
            setJson(res, 400, { error: '续跑标记参数无效' })
            return
          }
          await quotaResume.set(input.threadId, input.enabled)
        }
        setJson(res, 200, { data: await quotaResume.snapshot() })
        return
      }
      if (req.method === 'GET' && url.pathname === '/codex-api/thread-interruptions') {
        setJson(res, 200, { data: await appServer.interruptions.snapshot() })
        return
      }
      if (url.pathname === '/codex-api/ignored-quota-errors' && ['GET', 'POST'].includes(req.method || '')) {
        const input = req.method === 'POST' ? asRecord(await readJsonBody(req)) : null
        const threadId = readNonEmptyString(input?.threadId) || url.searchParams.get('threadId') || ''
        if (!/^[a-zA-Z0-9-]{1,200}$/.test(threadId) || (req.method === 'POST' && (typeof input?.ignored !== 'boolean' || !/^[a-zA-Z0-9-]{1,200}$/.test(readNonEmptyString(input?.turnId))))) {
          setJson(res, 400, { error: '忽略标记参数无效' })
          return
        }
        if (req.method === 'POST') {
          await ignoredQuotaErrors.set(threadId, readNonEmptyString(input?.turnId), input!.ignored as boolean)
          await appServer.interruptions.publish(threadId)
          appServer.notifyQuotaErrorIgnored(threadId)
        }
        setJson(res, 200, { data: await ignoredQuotaErrors.list(threadId) })
        return
      }
      if (req.method === 'POST' && url.pathname === '/codex-api/sidebar-thread-status') {
        const payload = asRecord(await readJsonBody(req))
        if (!Array.isArray(payload?.threadIds) || payload.threadIds.length > 100 || payload.threadIds.some(id => typeof id !== 'string' || !id || id.length > 200)) {
          setJson(res, 400, { error: '每次最多读取 100 个会话状态' })
          return
        }
        const rawVersions = asRecord(payload.versions)
        const versions = Object.fromEntries((payload.threadIds as string[]).map(id => [id, readNonEmptyString(rawVersions?.[id]).slice(0, 80)]))
        setJson(res, 200, { data: await sidebarThreadStatus.snapshot(payload.threadIds as string[], versions) })
        return
      }
      if (req.method === 'POST' && url.pathname === '/codex-api/thread-goals') {
        const payload = asRecord(await readJsonBody(req))
        if (!Array.isArray(payload?.threadIds) || payload.threadIds.length > 100 || payload.threadIds.some(id => typeof id !== 'string' || !id || id.length > 100)) {
          setJson(res, 400, { error: '每次最多读取 100 个会话目标' }); return
        }
        const refreshId = typeof payload.refreshId === 'string' && payload.threadIds.includes(payload.refreshId) ? payload.refreshId : ''
        setJson(res, 200, { data: await threadGoalReader.snapshot(payload.threadIds as string[], refreshId) }); return
      }
      if (req.method === 'GET' && url.pathname === '/codex-api/thread-automations') {
        const automationsByThreadId = await listThreadHeartbeatAutomations()
        setJson(res, 200, { data: toAutomationApiMap(automationsByThreadId) })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/project-automations') {
        const automationsByProjectName = await listProjectCronAutomations()
        setJson(res, 200, { data: toAutomationApiMap(automationsByProjectName) })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/thread-automation') {
        const threadId = url.searchParams.get('threadId')?.trim() ?? ''
        const automationId = url.searchParams.get('automationId')?.trim() ?? ''
        if (!threadId) {
          setJson(res, 400, { error: 'Missing threadId' })
          return
        }
        const automation = automationId
          ? await readThreadHeartbeatAutomation(threadId, automationId)
          : await readThreadHeartbeatAutomations(threadId)
        setJson(res, 200, { data: toAutomationApiData(automation) })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/project-automation') {
        const projectName = url.searchParams.get('projectName')?.trim() ?? ''
        const automationId = url.searchParams.get('automationId')?.trim() ?? ''
        if (!projectName) {
          setJson(res, 400, { error: 'Missing projectName' })
          return
        }
        const automation = automationId
          ? await readProjectCronAutomation(projectName, automationId)
          : await readProjectCronAutomations(projectName)
        setJson(res, 200, { data: toAutomationApiData(automation) })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/thread-search') {
        const payload = asRecord(await readJsonBody(req))
        const query = typeof payload?.query === 'string' ? payload.query.trim() : ''
        const limitRaw = typeof payload?.limit === 'number' ? payload.limit : 200
        const limit = Math.max(1, Math.min(1000, Math.floor(limitRaw)))
        if (!query) {
          setJson(res, 200, { data: { threadIds: [], indexedThreadCount: 0 } })
          return
        }

        const controller = new AbortController()
        const cancel = () => { if (!res.writableEnded) controller.abort() }
        res.on('close', cancel)
        try {
          const data = await search.search(query, limit, controller.signal, payload?.mode === 'body' ? 'body' : 'title')
          if (!controller.signal.aborted) setJson(res, 200, { data })
        } catch (cause) {
          if (!controller.signal.aborted) throw cause
        } finally {
          res.off('close', cancel)
        }
        return
      }

      if (req.method === 'PUT' && url.pathname === '/codex-api/thread-titles') {
        const payload = asRecord(await readJsonBody(req))
        const id = typeof payload?.id === 'string' ? payload.id : ''
        const title = typeof payload?.title === 'string' ? payload.title : ''
        if (!id) {
          setJson(res, 400, { error: 'Missing id' })
          return
        }
        const cache = await readThreadTitleCache()
        const next = title ? updateThreadTitleCache(cache, id, title) : removeFromThreadTitleCache(cache, id)
        await writeThreadTitleCache(next)
        search.invalidate(id)
        setJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'PUT' && url.pathname === '/codex-api/thread-pins') {
        const payload = asRecord(await readJsonBody(req))
        const threadIds = normalizePinnedThreadIds(payload?.threadIds)
        await writePinnedThreadIds(threadIds)
        setJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'PUT' && url.pathname === '/codex-api/preferences/first-launch-plugins-card') {
        const payload = asRecord(await readJsonBody(req))
        const dismissed = payload?.dismissed === true
        await writeFirstLaunchPluginsCardDismissed(dismissed)
        setJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'PUT' && url.pathname === '/codex-api/thread-automation') {
        const payload = asRecord(await readJsonBody(req))
        const threadId = typeof payload?.threadId === 'string' ? payload.threadId.trim() : ''
        const id = typeof payload?.id === 'string' ? payload.id.trim() : ''
        const name = typeof payload?.name === 'string' ? payload.name.trim() : ''
        const prompt = typeof payload?.prompt === 'string' ? payload.prompt.trim() : ''
        const rrule = typeof payload?.rrule === 'string' ? payload.rrule.trim() : ''
        const status = payload?.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE'
        if (!threadId || !name || !prompt || !rrule) {
          setJson(res, 400, { error: 'threadId, name, prompt, and rrule are required' })
          return
        }
        await automationEngine.readyPromise
        if (!automationEngine.snapshot().ready) throw new Error(automationEngine.snapshot().error ?? '调度器尚未就绪')
        const timezone = validateAutomationTimezone(typeof payload?.timezone === 'string' ? payload.timezone : automationEngine.snapshot().definitions.find((row) => row.id === id)?.timezone ?? automationEngine.timezone)
        createAutomationSchedule(rrule, timezone, Date.now())
        const automation = await writeThreadHeartbeatAutomation({ threadId, id, name, prompt, rrule, status, model: payload?.model, reasoningEffort: payload?.reasoningEffort, serviceTier: payload?.serviceTier, accountStorageId: payload?.accountStorageId, protected: payload?.protected, timezone })
        await automationEngine.refresh(automation.id, timezone)
        setJson(res, 200, { data: toAutomationApiRecord(automationEngine.decorate(automation)) })
        return
      }

      if (req.method === 'PUT' && url.pathname === '/codex-api/project-automation') {
        const payload = asRecord(await readJsonBody(req))
        const projectName = typeof payload?.projectName === 'string' ? payload.projectName.trim() : ''
        const id = typeof payload?.id === 'string' ? payload.id.trim() : ''
        const name = typeof payload?.name === 'string' ? payload.name.trim() : ''
        const prompt = typeof payload?.prompt === 'string' ? payload.prompt.trim() : ''
        const rrule = typeof payload?.rrule === 'string' ? payload.rrule.trim() : ''
        const status = payload?.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE'
        if (!projectName || !name || !prompt || !rrule) {
          setJson(res, 400, { error: 'projectName, name, prompt, and rrule are required' })
          return
        }
        if (!isAbsoluteLikePath(projectName) && !isVirtualProjectId(projectName)) {
          setJson(res, 400, { error: 'Project automation cwd must be an absolute path' })
          return
        }
        await automationEngine.readyPromise
        if (!automationEngine.snapshot().ready) throw new Error(automationEngine.snapshot().error ?? '调度器尚未就绪')
        const timezone = validateAutomationTimezone(typeof payload?.timezone === 'string' ? payload.timezone : automationEngine.snapshot().definitions.find((row) => row.id === id)?.timezone ?? automationEngine.timezone)
        createAutomationSchedule(rrule, timezone, Date.now())
        const automation = await writeProjectCronAutomation({ projectName, id, name, prompt, rrule, status, model: payload?.model, reasoningEffort: payload?.reasoningEffort, serviceTier: payload?.serviceTier, accountStorageId: payload?.accountStorageId, protected: payload?.protected, timezone })
        await automationEngine.refresh(automation.id, timezone)
        setJson(res, 200, { data: toAutomationApiRecord(automationEngine.decorate(automation)) })
        return
      }

      if (req.method === 'DELETE' && url.pathname === '/codex-api/thread-automation') {
        const threadId = url.searchParams.get('threadId')?.trim() ?? ''
        const automationId = url.searchParams.get('automationId')?.trim() ?? ''
        if (!threadId) {
          setJson(res, 400, { error: 'Missing threadId' })
          return
        }
        const removed = await deleteThreadHeartbeatAutomation(threadId, automationId)
        await automationEngine.refresh()
        setJson(res, 200, { data: { removed } })
        return
      }

      if (req.method === 'DELETE' && url.pathname === '/codex-api/project-automation') {
        const projectName = url.searchParams.get('projectName')?.trim() ?? ''
        const automationId = url.searchParams.get('automationId')?.trim() ?? ''
        if (!projectName) {
          setJson(res, 400, { error: 'Missing projectName' })
          return
        }
        const removed = await deleteProjectCronAutomation(projectName, automationId)
        await automationEngine.refresh()
        setJson(res, 200, { data: { removed } })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/telegram/configure-bot') {
        const payload = asRecord(await readJsonBody(req))
        const botToken = typeof payload?.botToken === 'string' ? payload.botToken.trim() : ''
        const rawAllowedUserIds = Array.isArray(payload?.allowedUserIds) ? payload.allowedUserIds : []
        if (!botToken) {
          setJson(res, 400, { error: 'Missing botToken' })
          return
        }
        const config = normalizeTelegramBridgeConfig({
          botToken,
          allowedUserIds: rawAllowedUserIds,
          notificationsEnabled: payload?.notificationsEnabled,
          quietEnabled: payload?.quietEnabled,
          quietStart: payload?.quietStart,
          quietEnd: payload?.quietEnd,
          timezone: payload?.timezone,
        })
        if (config.allowedUserIds.length === 0) {
          setJson(res, 400, { error: 'At least one allowed Telegram user ID is required' })
          return
        }

        await mutateTelegramBridgeConfig(async () => {
          const existingConfig = await readTelegramBridgeConfig()
          // Older clients omit the switch; preserve an existing explicit choice.
          if (typeof payload?.notificationsEnabled !== 'boolean' && existingConfig.botToken) {
            config.notificationsEnabled = existingConfig.notificationsEnabled
          }
          for (const key of ['quietEnabled', 'quietStart', 'quietEnd', 'timezone'] as const) {
            if (payload?.[key] === undefined) Object.assign(config, { [key]: existingConfig[key] })
          }
          await writeTelegramBridgeConfig({ ...config, chatIds: existingConfig.chatIds })
          telegramBridge.configureNotifications(config.notificationsEnabled)
          telegramBridge.configureQuietHours(config)
          telegramBridge.configureToken(config.botToken)
          telegramBridge.configureAllowedUserIds(config.allowedUserIds)
          telegramBridge.start()
        })
        setJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/telegram/notification-preferences') {
        const payload = asRecord(await readJsonBody(req)) || {}
        try {
          await mutateTelegramBridgeConfig(async () => {
          const current = await readTelegramBridgeConfig()
          const settings = validateQuietHours({
            timezone: payload.timezone === undefined ? current.timezone : payload.timezone as string,
            quietEnabled: payload.quietEnabled === undefined ? current.quietEnabled : payload.quietEnabled as boolean,
            quietStart: payload.quietStart === undefined ? current.quietStart : payload.quietStart as string,
            quietEnd: payload.quietEnd === undefined ? current.quietEnd : payload.quietEnd as string,
          })
          await writeTelegramBridgeConfig({ ...current, ...settings })
          telegramBridge.configureQuietHours(settings)
          })
          setJson(res, 200, { ok: true })
        } catch (error) {
          setJson(res, 400, { error: error instanceof Error ? error.message : '保存失败' })
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/telegram/test') {
        const config = await readTelegramBridgeConfig()
        const payload = asRecord(await readJsonBody(req))
        if (!config.notificationsEnabled) {
          setJson(res, 400, { error: payload?.language === 'zh-CN' ? 'Telegram通知已关闭。' : 'Telegram notifications are disabled.' })
          return
        }
        const allowAll = config.allowedUserIds.includes('*')
        const chatIds = [...new Set([...config.chatIds.filter(id => allowAll || config.allowedUserIds.includes(id)), ...config.allowedUserIds.filter((id): id is number => typeof id === 'number')])].slice(0, 50)
        if (!config.botToken || !chatIds.length) {
          setJson(res, 400, { error: '请先保存Telegram设置，并与机器人开始会话。' })
          return
        }
        try {
          await telegramBridge.sendTestNotification(chatIds, payload?.language === 'zh-CN' ? 'CodexApp 测试通知' : 'CodexApp test notification')
          setJson(res, 200, { ok: true })
        } catch {
          setJson(res, 502, { error: '测试通知发送失败。' })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/telegram/config') {
        const config = await readTelegramBridgeConfig()
        setJson(res, 200, {
          data: {
            botToken: config.botToken,
            notificationsEnabled: config.notificationsEnabled,
            quietEnabled: config.quietEnabled,
            quietStart: config.quietStart,
            quietEnd: config.quietEnd,
            timezone: config.timezone,
            allowedUserIds: config.allowedUserIds,
          },
        })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/telegram/status') {
        setJson(res, 200, { data: telegramBridge.getStatus() })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/events') {
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
        res.setHeader('Cache-Control', 'no-cache, no-transform')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('X-Accel-Buffering', 'no')

        const unsubscribe = middleware.subscribeNotifications((notification: { method: string; params: unknown; atIso: string }) => {
          if (res.writableEnded || res.destroyed) return
          res.write(`data: ${JSON.stringify(notification)}\n\n`)
        })

        res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`)
        const keepAlive = setInterval(() => {
          res.write(': ping\n\n')
        }, 15000)

        const close = () => {
          clearInterval(keepAlive)
          unsubscribe()
          if (!res.writableEnded) {
            res.end()
          }
        }

        req.on('close', close)
        req.on('aborted', close)
        return
      }

      next()
    } catch (error) {
      const message = getErrorMessage(error, 'Unknown bridge error')
      setJson(res, 502, { error: message })
    } finally {
      releaseProviderChange?.()
    }
  }

  let middlewareDisposal: Promise<void> | null = null
  middleware.dispose = () => {
    if (middlewareDisposal) return middlewareDisposal
    directoryPlugins.dispose()
    unsubscribeSearch()
    search.invalidate()
    unsubscribeHistory()
    history.clear()
    sharedState.owners--
    middlewareDisposal = sharedState.owners === 0 ? disposeSharedBridgeState(sharedState) : Promise.resolve()
    return middlewareDisposal
  }
  middleware.subscribeNotifications = (
    listener: (value: { method: string; params: unknown; atIso: string }) => void,
  ) => {
    const unsubscribeAppServer = appServer.onNotification((notification: { method: string; params: unknown }) => {
      listener({
        ...notification,
        atIso: new Date().toISOString(),
      })
    })
    const unsubscribeTerminal = terminalManager.subscribe((notification) => {
      listener({
        ...notification,
        atIso: new Date().toISOString(),
      })
    })
    const unsubscribeAutomation = automationEngine.subscribe(() => listener({ method: 'automation/changed', params: null, atIso: new Date().toISOString() }))
    return () => {
      unsubscribeAutomation()
      unsubscribeAppServer()
      unsubscribeTerminal()
    }
  }

  return middleware
}
