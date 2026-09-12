import type { UiThread } from './types/codex'

export type SidebarThreadFilter = 'all' | 'active' | 'unread' | 'interrupted'

export function matchesSidebarThreadFilter(thread: UiThread, filter: SidebarThreadFilter, retainedUnreadId: string, interrupted: Record<string, boolean | null>): boolean {
  if (filter === 'active') return thread.inProgress
  if (filter === 'unread') return thread.unread || thread.id === retainedUnreadId
  if (filter === 'interrupted') return !thread.inProgress && interrupted[thread.id] === true
  return true
}

export function isFinalQuotaInterruption(value: unknown): boolean {
  const turn = value as { status?: string; error?: unknown } | null
  if (!turn || !['failed', 'interrupted'].includes(turn.status || '')) return false
  // Inspect the final turn's error only, never user text or older turns.
  return /usage.?limit|quota|rate.?limit|\b429\b|额度|限额/iu.test(JSON.stringify(turn.error ?? ''))
}
