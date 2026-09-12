import { ref } from 'vue'
import { compactionFromTurn, updateCompactionMessages, type CompactionProgress } from '../compaction'
import { rpcCall, type RpcNotification } from './codexRpcClient'
import type { UiMessage } from '../types/codex'

export type CompactionRequest = {
  threadId: string
  beforeTurnId: string
  requestedAtMs: number
  status: CompactionProgress['status'] | 'requested'
  turnId?: string
  itemId?: string
  progress?: CompactionProgress
  error?: string
}
const STORAGE_KEY = 'codexapp.compaction.v1'
export const compactionRequests = ref<Record<string, CompactionRequest>>({})
let restored = false
const operations = new Map<string, Promise<void>>()
export const isCompactionPending = (record?: CompactionRequest): boolean => !!record && ['requested', 'running', 'unknown'].includes(record.status)

export function restoreCompactionRequests() {
  if (restored || typeof window === 'undefined') return
  restored = true
  try {
    const records = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) || '{}') as Record<string, CompactionRequest>
    for (const [id, record] of Object.entries(records).slice(0, 20)) {
      if (record?.threadId !== id || typeof record.beforeTurnId !== 'string' || !Number.isFinite(record.requestedAtMs)
        || !['requested', 'running', 'unknown', 'completed', 'failed', 'interrupted'].includes(record.status)) continue
      compactionRequests.value[id] = { ...record, ...(isCompactionPending(record) ? { status: 'unknown' as const } : {}) }
    }
  } catch {
    // A new request still requires a successful persistence check before sending.
  }
}

function save(record: CompactionRequest, required = false) {
  const next = { ...compactionRequests.value, [record.threadId]: record }
  for (const id of Object.keys(next)) {
    if (Object.keys(next).length <= 20) break
    if (id !== record.threadId && !isCompactionPending(next[id])) delete next[id]
  }
  if (Object.keys(next).length > 20) throw new Error('待确认的压缩请求过多，请先检查已有请求。')
  try {
    const text = JSON.stringify(next)
    window.sessionStorage.setItem(STORAGE_KEY, text)
    if (window.sessionStorage.getItem(STORAGE_KEY) !== text) throw new Error('storage did not retain the request')
  } catch {
    if (required) throw new Error('无法保存压缩请求状态，请检查浏览器存储后重试。')
  }
  compactionRequests.value = next
}

async function recentHistory(threadId: string, limit: number): Promise<Record<string, any>> {
  const response = await fetch(`/codex-api/thread-turn-page?${new URLSearchParams({ threadId, limit: String(limit) })}`)
  const payload = await response.json()
  if (!response.ok || !payload.result?.thread || !Array.isArray(payload.result.thread.turns)) {
    throw new Error(payload.error || '无法读取压缩状态，请稍后重试。')
  }
  return payload.result.thread
}

export function observeCompactionHistory(value: unknown) {
  restoreCompactionRequests()
  const thread = (value as { thread?: Record<string, any> } | null)?.thread
  if (!thread || typeof thread.id !== 'string' || !Array.isArray(thread.turns)) return
  const current = compactionRequests.value[thread.id]
  if (!current || !isCompactionPending(current)) return
  const baseline = thread.turns.findIndex((turn: any) => turn.id === current.beforeTurnId)
  const candidates = current.turnId
    ? thread.turns.filter((turn: any) => turn.id === current.turnId)
    : baseline >= 0 ? thread.turns.slice(baseline + 1) : current.beforeTurnId ? [] : thread.turns
  for (const turn of candidates) {
    const messages = compactionFromTurn(turn)
    const latest = messages.at(-1)
    if (latest?.compaction) {
      save({ ...current, turnId: turn.id, itemId: latest.id, status: latest.compaction.status, progress: latest.compaction, error: latest.compaction.error })
      return
    }
    if (current.turnId === turn.id && ['failed', 'interrupted'].includes(turn.status)) {
      const status = turn.status as 'failed' | 'interrupted'
      save({ ...current, status, progress: { status, error: turn.error?.message }, error: turn.error?.message })
      return
    }
  }
}

export function restoreTrackedCompactionMessage(messages: UiMessage[], value: unknown, baseTurnIndex = 0): UiMessage[] {
  const thread = (value as { thread?: Record<string, any> } | null)?.thread
  const current = thread && compactionRequests.value[thread.id]
  if (!current?.turnId || !Array.isArray(thread?.turns) || messages.some(message => message.compaction && message.turnId === current.turnId)) return messages
  const turn = thread.turns.find((turn: any) => turn.id === current.turnId)
  if (!turn || turn.status !== 'interrupted') return messages
  const turnIndex = baseTurnIndex + thread.turns.indexOf(turn)
  const next: UiMessage = { id: current.itemId || `${current.turnId}-compaction`, turnId: current.turnId, turnIndex,
    role: 'system', messageType: 'contextCompaction', text: '上下文压缩已中断', compaction: { status: 'interrupted' } }
  const followingIndex = messages.findIndex(message => typeof message.turnIndex === 'number' && message.turnIndex > turnIndex)
  if (followingIndex < 0) return [...messages, next]
  return [...messages.slice(0, followingIndex), next, ...messages.slice(followingIndex)]
}

export function observeCompactionNotification(notification: RpcNotification) {
  const params = notification.params as Record<string, any> | null
  if (!params?.threadId) return
  const current = compactionRequests.value[params.threadId]
  if (!current || !isCompactionPending(current)) return
  const turnId = params.turnId || params.turn?.id
  if (turnId === current.beforeTurnId || (current.turnId && turnId !== current.turnId)) return
  const messages: UiMessage[] = current.itemId && current.progress ? [{ id: current.itemId, role: 'system', text: '', turnId: current.turnId, compaction: current.progress }] : []
  const next = updateCompactionMessages(messages, notification.method, notification.params)?.at(-1)
  if (next?.compaction) save({ ...current, turnId: next.turnId, itemId: next.id, status: next.compaction.status, progress: next.compaction, error: next.compaction.error })
}

export async function checkThreadCompaction(threadId: string): Promise<void> {
  if (operations.has(threadId)) return operations.get(threadId)
  const operation = (async () => {
    const thread = await recentHistory(threadId, 20)
    observeCompactionHistory({ thread })
    const current = compactionRequests.value[threadId]
    if (isCompactionPending(current) && thread.status?.type !== 'active') {
      save({ ...current, status: 'unknown', error: '未找到本次压缩的完整结果。' })
    }
  })()
  operations.set(threadId, operation)
  try { await operation } finally { operations.delete(threadId) }
}

export async function compactThread(threadId: string, repeatUnknown = false): Promise<void> {
  restoreCompactionRequests()
  if (operations.has(threadId)) return operations.get(threadId)
  const current = compactionRequests.value[threadId]
  if (isCompactionPending(current) && !(repeatUnknown && current.status === 'unknown')) throw new Error('已有压缩请求，请先检查结果。')
  const operation = (async () => {
    const thread = await recentHistory(threadId, 1)
    if (thread.status?.type === 'active' || thread.turns.some((turn: any) => turn.status === 'inProgress')) throw new Error('任务运行中，暂不能压缩。')
    const record: CompactionRequest = { threadId, beforeTurnId: thread.turns.at(-1)?.id || '', requestedAtMs: Date.now(), status: 'requested' }
    save(record, true)
    try {
      await rpcCall('thread/compact/start', { threadId, ...(repeatUnknown ? { repeatUnknown: true } : {}) })
    } catch (cause) {
      const latest = compactionRequests.value[threadId]
      if (latest?.status === 'requested') save({ ...latest, status: 'unknown', error: cause instanceof Error ? cause.message : '压缩请求结果未确认' })
      throw cause
    }
  })()
  operations.set(threadId, operation)
  try { await operation } finally { operations.delete(threadId) }
}
