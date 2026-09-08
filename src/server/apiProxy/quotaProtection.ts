import type { StoredAccountEntry } from '../accountAuthStore.js'
import { ProxyError } from './store.js'
export function assertQuotaAvailable(account: StoredAccountEntry, percent: number, privileged: boolean): void {
  if (percent <= 0 || privileged) return
  if (account.quotaStatus !== 'ready' || !account.quotaSnapshot) throw new ProxyError('protected_quota_unknown', '账号额度暂不可确认，无法使用受保护账号。', 503)
  const windows = [account.quotaSnapshot.primary, account.quotaSnapshot.secondary].filter(Boolean)
  const weekly = windows.find(window => window!.windowMinutes === 10080)
  if (!weekly) throw new ProxyError('protected_quota_unknown', '无法确认账号周限额，请刷新账号。', 503)
  if (100 - weekly.usedPercent <= percent || windows.some(window => window!.windowMinutes === 300 && 100 - window!.usedPercent <= Math.min(100, percent * 2))) {
    throw new ProxyError('account_quota_protected', '该账号剩余额度已保留给受保护任务。', 429)
  }
}
