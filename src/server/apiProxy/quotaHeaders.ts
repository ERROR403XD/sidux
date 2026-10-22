import type { StoredAccountEntry } from '../accountAuthStore.js'
import type { ProxyKey } from './store.js'

/** Codex rate-limit headers describe a recent account snapshot, never token balances. */
export function accountQuotaHeaders(key: ProxyKey | undefined, account: StoredAccountEntry | undefined, now = Date.now()): Record<string, string> {
  const headers: Record<string, string> = {}
  if (!key?.accountStorageId || key.aggregateRoute?.enabled || account?.storageId !== key.accountStorageId) return headers
  if (account.quotaStatus !== 'ready' || !account.quotaSnapshot || !account.quotaUpdatedAtIso) return headers
  const updatedAt = Date.parse(account.quotaUpdatedAtIso)
  if (!Number.isFinite(updatedAt) || updatedAt > now || now - updatedAt > 300_000) return headers
  for (const name of ['primary', 'secondary'] as const) {
    const window = account.quotaSnapshot[name]
    if (!window || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100) continue
    if (window.resetsAt !== null && (!Number.isSafeInteger(window.resetsAt) || window.resetsAt * 1000 <= now)) continue
    const prefix = `x-codex-${name}`
    headers[`${prefix}-used-percent`] = String(window.usedPercent)
    if (window.windowMinutes !== null && Number.isSafeInteger(window.windowMinutes) && window.windowMinutes > 0) {
      headers[`${prefix}-window-minutes`] = String(window.windowMinutes)
    }
    if (window.resetsAt !== null) headers[`${prefix}-reset-at`] = String(window.resetsAt)
  }
  return headers
}
