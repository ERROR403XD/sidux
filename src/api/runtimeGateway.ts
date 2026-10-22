import { fetchRpcMethodCatalog, fetchRpcNotificationCatalog, type RpcNotification, subscribeRpcNotifications, respondServerRequest, fetchPendingServerRequests } from './codexRpcClient'

export async function getMethodCatalog(): Promise<string[]> {
  return fetchRpcMethodCatalog()
}

export async function getNotificationCatalog(): Promise<string[]> {
  return fetchRpcNotificationCatalog()
}

export function subscribeCodexNotifications(onNotification: (value: RpcNotification) => void): () => void {
  return subscribeRpcNotifications(onNotification)
}

export async function replyToServerRequest(
  id: number,
  payload: { result?: unknown; error?: { code?: number; message: string } },
): Promise<void> {
  await respondServerRequest({
    id,
    ...payload,
  })
}

export async function getPendingServerRequests(onAuthRecovery?: (states: import('../authRecovery').AuthRecoveryState[]) => void): Promise<unknown[]> {
  return fetchPendingServerRequests(onAuthRecovery)
}
