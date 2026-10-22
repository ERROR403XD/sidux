import type { ThreadListResponse, ThreadReadResponse, ThreadResumeResponse } from './appServerDtos'
import { normalizeCodexApiError } from './codexErrors'
import { callRpc } from './rpcGateway'
import {
  normalizeThreadGroupsV2,
  normalizeThreadMessagesV2,
  normalizeThreadSummaryV2,
  readActiveTurnIdFromResponse,
  readThreadInProgressFromResponse,
} from './normalizers/v2'
import { normalizeThreadMessagesWithCompaction, readThreadTurnStartIndex } from './threadPayload'
import {
  normalizeThreadModelFromPayload,
  normalizeThreadModelProviderFromPayload,
} from './threadModel'
import type { UiMessage, UiProjectGroup, UiThread } from '../types/codex'

type ThreadTurnIndexById = Record<string, number>

const INITIAL_THREAD_LIST_LIMIT = 50
const BACKGROUND_THREAD_LIST_LIMIT = 100
const RESUME_THREAD_COALESCE_TTL_MS = 30_000
const recentResumeThreadById = new Map<string, Promise<ResumedThread>>()

export type ThreadGroupsPage = {
  groups: UiProjectGroup[]
  nextCursor: string | null
}

export type ThreadHistoryPosition = { nextCursor: string | null; source: 'native' | 'legacy' }

export type ThreadTurnPage = {
  messages: UiMessage[]
  inProgress: boolean
  activeTurnId: string
  hasMoreOlder: boolean
  historyPosition?: ThreadHistoryPosition
  startTurnIndex: number
  turnIndexByTurnId: ThreadTurnIndexById
}

export type ThreadReadDetail = {
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

export type ResumedThread = ThreadReadDetail

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
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

function readHistoryPosition(payload: unknown): ThreadHistoryPosition {
  const history = asRecord(asRecord(payload)?.threadHistory)
  return { nextCursor: typeof history?.nextCursor === 'string' ? history.nextCursor : null, source: history?.source === 'native' ? 'native' : 'legacy' }
}

function readHasMoreHistory(payload: ThreadReadResponse): boolean {
  return asRecord(asRecord(payload)?.threadHistory)?.hasMoreOlder === true || readThreadTurnStartIndex(payload) > 0
}


function readLoadedThreadSummary(payload: ThreadReadResponse): UiThread | undefined {
  const thread = payload.thread
  if (!thread || typeof thread.cwd !== 'string' || !Number.isFinite(thread.createdAt) || !Number.isFinite(thread.updatedAt)) return undefined
  return normalizeThreadSummaryV2(payload)
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

async function getThreadDetailV2(threadId: string): Promise<ThreadReadDetail> {
  const payload = await callRpc<ThreadReadResponse>('thread/read', {
    threadId,
    includeTurns: true,
  })
  const startTurnIndex = readThreadTurnStartIndex(payload)
  return {
    thread: readLoadedThreadSummary(payload),
    model: normalizeThreadModelFromPayload(payload),
    modelProvider: normalizeThreadModelProviderFromPayload(payload),
    messages: normalizeThreadMessagesV2(payload, startTurnIndex),
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

export async function getThreadDetail(threadId: string): Promise<ThreadReadDetail> {
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

export function invalidateThreadResumeCache(threadId?: string): void {
  if (threadId) recentResumeThreadById.delete(threadId)
  else recentResumeThreadById.clear()
}

export async function resumeThread(threadId: string): Promise<ResumedThread> {
  const existing = recentResumeThreadById.get(threadId)
  if (existing) return existing

  const promise = (async () => {
    const payload = await callRpc<ThreadResumeResponse>('thread/resume', { threadId })
    const startTurnIndex = readThreadTurnStartIndex(payload)
    return {
      thread: readLoadedThreadSummary(payload),
      model: normalizeThreadModelFromPayload(payload),
      modelProvider: normalizeThreadModelProviderFromPayload(payload),
      messages: normalizeThreadMessagesV2(payload, startTurnIndex),
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

export async function getThreadTurnMessages(threadId: string, turnId: string): Promise<UiMessage[]> {
  const response = await fetch(`/codex-api/thread-turn-items?${new URLSearchParams({ threadId, turnId })}`)
  const payload = await response.json() as { result?: ThreadReadResponse; error?: string }
  if (!response.ok || !payload.result) throw new Error(payload.error || '无法读取历史回合。')
  return normalizeThreadMessagesWithCompaction(payload.result)
}

export async function rollbackThread(threadId: string, numTurns: number): Promise<UiMessage[]> {
  const payload = await callRpc<ThreadReadResponse>('thread/rollback', { threadId, numTurns })
  return normalizeThreadMessagesWithCompaction(payload, readThreadTurnStartIndex(payload))
}
