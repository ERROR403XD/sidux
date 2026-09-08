import { onBeforeUnmount, type Ref } from 'vue'
import { normalizeAccountEntry, subscribeCodexNotifications } from '../api/codexGateway'
import type { UiAccountEntry } from '../types/codex'

export function useAccountQuotaUpdates(accounts: Ref<UiAccountEntry[]>) {
  const unsubscribe = subscribeCodexNotifications(notification => {
    if (notification.method !== 'codexapp/accountQuota/updated') return
    const params = notification.params as { account?: unknown }
    const updated = normalizeAccountEntry(params?.account)
    if (!updated) return
    accounts.value = accounts.value.map(account => account.storageId === updated.storageId
      ? { ...updated, isActive: account.isActive, canSwitch: account.canSwitch, actionRequired: account.actionRequired }
      : account)
  })
  onBeforeUnmount(unsubscribe)
}
