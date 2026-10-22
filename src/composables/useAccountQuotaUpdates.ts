import { normalizeAccountEntry } from '../api/accountGateway'
import { subscribeRpcNotifications } from '../api/codexRpcClient'
import type { UiAccountEntry } from '../types/codex'

export function subscribeAccountQuotaUpdates(onUpdated: (account: UiAccountEntry) => void): () => void {
  return subscribeRpcNotifications(notification => {
    if (notification.method !== 'codexapp/accountQuota/updated') return
    const params = notification.params as { account?: unknown }
    const updated = normalizeAccountEntry(params?.account)
    if (!updated) return
    onUpdated(updated)
  })
}
