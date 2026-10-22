import type { StoredAccountEntry } from '../accountAuthStore.js'
import type { ProxyKey } from './store.js'

type UsageWindow = '5h' | '1d' | '7d'
type UsageLimit = { window: UsageWindow; limit: number; used: number; remaining: number; reset_at?: string }
export type CachedAccountUsage = { rate_limits: UsageLimit[]; unit: 'percent'; updated_at?: string; stale?: boolean }
type PercentPeriod = { used_percent: number; remaining_percent: number; reset_at?: string }
export type PercentAccountUsage = CachedAccountUsage & { periods: Partial<Record<'five_hour' | 'daily' | 'weekly', PercentPeriod>> }
const windows = new Map<number, UsageWindow>([[300, '5h'], [1440, '1d'], [10080, '7d']])
const periodNames = { '5h': 'five_hour', '1d': 'daily', '7d': 'weekly' } as const

/** Named fields for Magpie's generic percentage expressions, outside its USD-only Sub2API path. */
export function percentAccountUsage(usage: CachedAccountUsage): PercentAccountUsage {
  const periods: PercentAccountUsage['periods'] = {}
  for (const limit of usage.rate_limits) {
    periods[periodNames[limit.window]] = { used_percent: limit.used, remaining_percent: limit.remaining,
      ...(limit.reset_at ? { reset_at: limit.reset_at } : {}) }
  }
  return { ...usage, periods }
}

/** Sub2API-shaped percentages, using only the bound account's last successful snapshot. */
export function cachedAccountUsage(key: ProxyKey | undefined, account: StoredAccountEntry | undefined, now = Date.now()): CachedAccountUsage {
  const result: CachedAccountUsage = { rate_limits: [], unit: 'percent' }
  if (!key?.accountStorageId || key.aggregateRoute?.enabled || account?.storageId !== key.accountStorageId) return result
  if (!account.quotaSnapshot || !account.quotaUpdatedAtIso) return result
  const updatedAt = Date.parse(account.quotaUpdatedAtIso)
  if (!Number.isFinite(updatedAt) || updatedAt > now) return result
  result.updated_at = new Date(updatedAt).toISOString()
  result.stale = now - updatedAt > 300_000 || account.quotaStatus !== 'ready'
  const limits = new Map<UsageWindow, UsageLimit>()
  for (const value of [account.quotaSnapshot.primary, account.quotaSnapshot.secondary]) {
    if (!value || !Number.isFinite(value.usedPercent) || value.usedPercent < 0 || value.usedPercent > 100) continue
    const window = value.windowMinutes === null ? undefined : windows.get(value.windowMinutes)
    if (!window || limits.has(window)) continue
    let resetAt: string | undefined
    if (value.resetsAt !== null) {
      const resetMs = value.resetsAt * 1000
      if (!Number.isSafeInteger(value.resetsAt) || value.resetsAt > 253402300799 || resetMs <= now) continue
      resetAt = new Date(resetMs).toISOString()
    } else if (value.usedPercent !== 0) {
      // An active window needs its actual reset time; never invent a calendar boundary.
      continue
    }
    limits.set(window, { window, limit: 100, used: value.usedPercent, remaining: 100 - value.usedPercent,
      ...(resetAt ? { reset_at: resetAt } : {}) })
  }
  result.rate_limits = [...windows.values()].flatMap(window => limits.has(window) ? [limits.get(window)!] : [])
  return result
}
