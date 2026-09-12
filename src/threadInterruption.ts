import { isFinalQuotaInterruption } from './sidebarThreadFilter'

export type ThreadInterruption = { turnId: string; kind: 'error' | 'quota' }
export type ThreadInterruptionSnapshot = Record<string, ThreadInterruption[]>

export function classifyThreadInterruption(turn: { status?: string; error?: unknown } | undefined): ThreadInterruption['kind'] | null {
  if (!turn || !['failed', 'interrupted'].includes(turn.status || '')) return null
  if (isFinalQuotaInterruption(turn)) return 'quota'
  if (turn.status === 'failed' || turn.error) return 'error'
  return null // An ordinary user interrupt is not a failure.
}

export function threadInterruptionDot(issues?: ThreadInterruption[]): ThreadInterruption['kind'] | undefined {
  return issues?.some(issue => issue.kind === 'quota') ? 'quota' : issues?.length ? 'error' : undefined
}
