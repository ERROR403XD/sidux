import { describe, expect, it, vi } from 'vitest'
import type { DeliveryRecord } from '../delivery'
import { inspectDelivery } from './deliveryHistory'

const delivery = { threadId: 'thread', message: { id: 'stable-client-id', text: 'same text' } } as DeliveryRecord
describe('native delivery evidence', () => {
  it('matches native clientId while ignoring unrelated user item IDs and identical text', async () => {
    const page = vi.fn(async () => ({ result: { thread: { turns: [
      { id: 'wrong', items: [{ type: 'userMessage', id: 'stable-client-id', clientId: 'another-request', content: [{ type: 'text', text: 'same text' }] }] },
      { id: 'right', items: [{ type: 'userMessage', id: 'native-generated-item', clientId: 'stable-client-id', content: [] }] },
    ] } }, nextCursor: 'more', hasMoreOlder: true, source: 'native' as const }))
    expect(await inspectDelivery({ page }, delivery)).toEqual({ turnId: 'right' })
    expect(page).toHaveBeenCalledExactlyOnceWith('thread', { limit: 50 })
  })

  it('leaves missing client IDs unconfirmed even when a turn looks complete', async () => {
    const page = vi.fn(async () => ({ result: { thread: { turns: [{ id: 'turn', status: 'completed', items: [{ type: 'userMessage', id: 'stable-client-id' }] }] } }, nextCursor: null, hasMoreOlder: false, source: 'legacy' as const }))
    expect(await inspectDelivery({ page }, delivery)).toEqual({})
  })
})
