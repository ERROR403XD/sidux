import type { AccountAuthCoordinator } from './accountAuthCoordinator.js'
import type { ActivationCheck } from './accountActivationScheduler.js'

export function isActivationAccountBusy(coordinator: AccountAuthCoordinator, id: string): boolean {
  return coordinator.blocksApiAccount(id) || coordinator.isAccountRefreshInProgress(id)
    || coordinator.executions.snapshot().some(entry => entry.storageId === id && entry.busy && entry.kind !== 'activation')
}

export async function checkActivationAccount(coordinator: AccountAuthCoordinator, id: string, refresh: boolean): Promise<ActivationCheck> {
  const denied = (reason: string): ActivationCheck => ({ allowed: false, reason, stamp: '' })
  if (isActivationAccountBusy(coordinator, id)) return denied('账号正在使用或凭据正在变更，本次跳过')
  const startedAt = Date.now()
  if (refresh) {
    try {
      const refreshed = await coordinator.refreshAccount(id)
      // Backoff can return a cached entry. Never activate from an old quota snapshot.
      if (refreshed.quotaStatus !== 'ready' || !refreshed.quotaUpdatedAtIso
        || Date.parse(refreshed.quotaUpdatedAtIso) < startedAt
        || !Number.isFinite(Date.parse(refreshed.quotaUpdatedAtIso))) {
        return denied('未取得最新额度，本次跳过')
      }
    } catch {
      return denied('额度读取失败，本次跳过')
    }
  }
  const state = await coordinator.store.readState()
  const account = state.accounts.find(row => row.storageId === id)
  if (!account) return denied('账号已移除')
  if (isActivationAccountBusy(coordinator, id)) return denied('账号正在使用或凭据正在变更，本次跳过')
  if (!['ready', 'stale'].includes(account.authStatus)) return denied('账号认证状态不可用')
  if (account.quotaStatus !== 'ready' || !account.quotaSnapshot) return denied('额度状态不可用，本次跳过')
  const windows = [account.quotaSnapshot.primary, account.quotaSnapshot.secondary].filter(window => window?.windowMinutes === 300)
  if (!windows.length) return denied('无 5 小时限额，无需激活')
  if (windows.some(window => window!.usedPercent !== 0)) return denied('5 小时剩余额度不是 100%，无需激活')
  return { allowed: true, reason: '', stamp: JSON.stringify([id, account.credentialRevision]) }
}
