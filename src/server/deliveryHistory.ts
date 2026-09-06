import type { DeliveryRecord } from '../delivery.js'
import type { ThreadHistory } from './threadHistory.js'

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}

export async function inspectDelivery(history: Pick<ThreadHistory, 'page'>, delivery: DeliveryRecord): Promise<{ turnId?: string }> {
  const page = await history.page(delivery.threadId, { limit: 50 })
  const thread = record(page.result.thread)
  const turns = Array.isArray(thread.turns) ? thread.turns : []
  for (const value of turns) {
    const turn = record(value)
    if (typeof turn.id !== 'string' || !turn.id || !Array.isArray(turn.items)) continue
    const matched = turn.items.some(value => {
      const item = record(value)
      return item.type === 'userMessage' && item.clientId === delivery.message.id
    })
    if (matched) return { turnId: turn.id }
  }
  // Missing evidence in a bounded page never authorizes another submission.
  return {}
}
