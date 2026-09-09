import type { StoredAccountEntry } from '../accountAuthStore.js'
import { ProxyError } from './store.js'
export function assertQuotaAvailable(account: StoredAccountEntry, percent: number, privileged: boolean): void {
  if (percent <= 0 || privileged) return
  if (account.quotaStatus !== 'ready' || !account.quotaSnapshot) throw new ProxyError('protected_quota_unknown', '账号额度暂不可确认，无法使用受保护账号。', 503)
  const windows = [account.quotaSnapshot.primary, account.quotaSnapshot.secondary].filter(Boolean)
  const weekly = windows.find(window => window!.windowMinutes === 10080)
    || windows.find(window => (window!.windowMinutes || 0) >= 28 * 1440)
  if (!weekly) throw new ProxyError('protected_quota_unknown', '无法确认账号长期限额，请刷新账号。', 503)
  // Compare used quota directly to avoid cancellation at decimal reserve boundaries.
  if (weekly.usedPercent >= 100 - percent || windows.some(window => window!.windowMinutes === 300 && window!.usedPercent >= 100 - Math.min(100, percent * 2))) {
    throw new ProxyError('account_quota_protected', '该账号剩余额度已保留给受保护任务。', 429)
  }
}
