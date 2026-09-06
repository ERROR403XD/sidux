import type { UiMessage } from './types/codex'

export type CompactionProgress = {
  status: 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown'
  startedAtMs?: number
  completedAtMs?: number
  durationMs?: number
  error?: string
}
export const compactionLabels = {
  running: '正在压缩上下文…', completed: '上下文压缩完成', failed: '上下文压缩失败',
  interrupted: '上下文压缩已中断', unknown: '上下文压缩结果未确认',
}
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' ? value as Record<string, any> : {}
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

export function compactionMessage(id: string, progress: CompactionProgress, turnId?: string): UiMessage {
  return { id, role: 'system', text: compactionLabels[progress.status], messageType: 'contextCompaction', compaction: progress, turnId }
}

export function compactionFromTurn(value: unknown): UiMessage[] {
  const turn = object(value)
  if (typeof turn.id !== 'string') return []
  const items = Array.isArray(turn.items) ? turn.items.map(object) : []
  const compactions = items.filter(item => item.type === 'contextCompaction' && typeof item.id === 'string')
  const error = typeof turn.error?.message === 'string' ? turn.error.message : ''
  // 0.153.4 persists this native task error even when the failed compaction has no item.
  if (!compactions.length && turn.status === 'failed' && /^Error running (?:remote )?compact task:/i.test(error)) {
    compactions.push({ id: `${turn.id}-compaction`, type: 'contextCompaction' })
  }
  return compactions.map(item => {
    // A persisted compaction item is completion evidence. Failed native compactions
    // do not persist an item; a later turn error must not undo an earlier compaction.
    const hasPersistedItem = items.some(row => row.id === item.id)
    const status: CompactionProgress['status'] = hasPersistedItem ? 'completed' : 'failed'
    const isStandalone = items.every(row => row.type === 'contextCompaction')
    return compactionMessage(item.id, {
      status,
      ...(isStandalone ? { durationMs: number(turn.durationMs) } : {}),
      ...(status === 'failed' ? { error: error.slice(0, 3000) } : {}),
    }, turn.id)
  })
}

export function updateCompactionMessages(messages: UiMessage[], method: string, value: unknown): UiMessage[] | null {
  const params = object(value)
  const item = object(params.item)
  const turn = object(params.turn)
  const turnId = typeof params.turnId === 'string' ? params.turnId : turn.id
  if ((method === 'item/started' || method === 'item/completed') && item.type === 'contextCompaction' && typeof item.id === 'string') {
    const previous = messages.find(message => message.id === item.id)
    if (method === 'item/started' && previous?.compaction && previous.compaction.status !== 'running') return null
    const startedAtMs = previous?.compaction?.startedAtMs ?? number(params.startedAtMs)
    const completedAtMs = number(params.completedAtMs)
    const progress: CompactionProgress = {
      status: method === 'item/started' ? 'running' : 'completed', startedAtMs, completedAtMs,
      ...(startedAtMs != null && completedAtMs != null ? { durationMs: Math.max(0, completedAtMs - startedAtMs) } : {}),
    }
    const next = compactionMessage(item.id, progress, turnId)
    return previous ? messages.map(message => message.id === item.id ? next : message) : [...messages, next]
  }
  if (!turnId || !['turn/completed', 'turn/cancelled', 'error'].includes(method)) return null
  const matching = messages.filter(message => message.turnId === turnId && message.compaction?.status === 'running')
  if (!matching.length) return null
  if (method === 'error' && params.willRetry === true) return null
  const error = object(method === 'error' ? params.error : turn.error).message
  const status: CompactionProgress['status'] = method === 'error' || turn.status === 'failed' ? 'failed'
    : method === 'turn/cancelled' || turn.status === 'interrupted' ? 'interrupted' : 'unknown'
  return messages.map(message => matching.includes(message) ? compactionMessage(message.id, {
    ...message.compaction, status,
    ...(typeof error === 'string' ? { error: error.slice(0, 3000) } : {}),
  }, turnId) : message)
}
