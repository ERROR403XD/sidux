import { type ThreadQueueState, normalizeThreadQueueState, type ThreadQueueOperation, type ThreadQueueResult } from '../threadQueue'
import { prepareWebDelivery, submitRememberedDelivery, type DeliveryPreparationGuard } from './deliveryOutbox'

export async function getThreadQueueState(): Promise<ThreadQueueState> {
  const response = await fetch('/codex-api/thread-queue-state')
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error((payload as { error?: string })?.error || '无法读取发送队列，请稍后重试')
  }
  const envelope =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}
  return normalizeThreadQueueState(envelope.data)
}

export async function getDeliveryStatuses(threadId: string, ids: string[]): Promise<Array<{ id: string; status: 'accepted' | 'cancelled'; turnId?: string }>> {
  const response = await fetch(`/codex-api/delivery-status?${new URLSearchParams({ threadId, ids: ids.join(',') })}`, { signal: AbortSignal.timeout(5000) })
  const payload = await response.json()
  if (!response.ok || !Array.isArray(payload.data)) throw new Error('无法读取发送回执')
  return payload.data.filter((row: { id?: string; status?: string; turnId?: string }) => typeof row?.id === 'string'
    && ids.includes(row.id) && (row.status === 'cancelled' || (row.status === 'accepted' && typeof row.turnId === 'string' && row.turnId.trim())))
}

export async function mutateThreadQueueState(operation: ThreadQueueOperation, options?: { canPrepare?: DeliveryPreparationGuard }): Promise<ThreadQueueResult> {
  let payload
  if (operation.type === 'add') {
    const pending = await prepareWebDelivery('thread-queue-state', { ...operation, protocol: 2 }, options?.canPrepare)
    payload = await submitRememberedDelivery(pending)
  } else {
    const response = await fetch('/codex-api/thread-queue-state', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...operation, protocol: 2 }),
    })
    payload = await response.json()
    if (!response.ok) throw new Error(payload.error || '队列保存失败，请重试')
  }
  return { state: normalizeThreadQueueState(payload.data?.state), removed: payload.data?.removed, delivered: payload.data?.delivered }
}
