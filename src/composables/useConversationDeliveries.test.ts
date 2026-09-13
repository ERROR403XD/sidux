import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversationDeliveries } from './useConversationDeliveries'
import { readConversationDeliveryCache, saveConversationDelivery } from '../api/conversationDeliveryCache'
import { rememberWebDelivery, submitRememberedDelivery } from '../api/deliveryOutbox'
import type { StoredQueuedMessage } from '../threadQueue'

const message = (id = 'd-1'): StoredQueuedMessage => ({ id, text: 'keep going', imageUrls: ['image'], skills: [{ name: 'skill', path: '/skill' }], fileAttachments: [{ label: 'file', path: '/file', fsPath: '/file' }], collaborationMode: 'default' })
beforeEach(() => {
  for (const name of ['localStorage', 'sessionStorage']) {
    const values = new Map<string, string>()
    vi.stubGlobal(name, {
      get length() { return values.size }, key: (i: number) => [...values.keys()][i],
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key),
    })
  }
})
afterEach(() => vi.unstubAllGlobals())

describe('conversation delivery presentation', () => {
  it.each(['queued', 'sending', 'unknown', 'failed', 'editing'] as const)('restores %s content, attachments and identity after reload without submitting', status => {
    const tracker = useConversationDeliveries()
    tracker.syncQueue({ a: [{ ...message(), delivery: { status, mode: 'steer', revision: 3, createdAt: 1, updatedAt: 2 } }] })
    const reloaded = useConversationDeliveries()
    expect(reloaded.project('a', [])[0]).toMatchObject({ text: 'keep going', clientUserMessageId: 'd-1', images: ['image'], skills: message().skills, fileAttachments: message().fileAttachments, deliveryState: { status } })
    expect(reloaded.project('b', [])).toEqual([])
    reloaded.syncQueue({})
    expect(reloaded.project('a', [])).toHaveLength(1)
  })

  it('bridges the acknowledgement/outbox/history gap across reload and rejects an older queue snapshot', async () => {
    const pending = rememberWebDelivery('delivery', { protocol: 2, threadId: 'a', mode: 'steer', message: message() })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { id: pending.id, status: 'accepted', turnId: 't' } }))))
    await submitRememberedDelivery(pending)
    const reloaded = useConversationDeliveries()
    reloaded.syncQueue({ a: [{ ...message(), delivery: { status: 'sending', mode: 'steer', revision: 2, createdAt: 1, updatedAt: 2 } }] })
    expect(reloaded.project('a', [])[0]).toMatchObject({ turnId: 't', deliveryState: { status: 'accepted' } })
    const native = { id: 'native', role: 'user' as const, text: 'keep going', turnId: 't', clientUserMessageId: pending.id }
    reloaded.observe('a', [native])
    expect(reloaded.project('a', [native])).toEqual([native])
    expect(readConversationDeliveryCache()).toEqual([])
    // A late acknowledgement cannot resurrect its cache after native evidence.
    saveConversationDelivery({ id: pending.id, threadId: 'a', message: message(), status: 'accepted', turnId: 't', createdAt: 1 })
    reloaded.refresh()
    expect(readConversationDeliveryCache()).toEqual([])
  })

  it('does not mistake equal prompts for acknowledgement and preserves both equal deliveries', () => {
    const tracker = useConversationDeliveries()
    for (const id of ['one', 'two']) tracker.begin('a', message(id))
    const native = { id: 'native', role: 'user' as const, text: 'keep going', turnId: 't', clientUserMessageId: 'one' }
    tracker.observe('a', [native])
    expect(tracker.project('a', [native])).toHaveLength(2)
    expect(tracker.project('a', [native])[1].clientUserMessageId).toBe('two')
    expect(tracker.project('a', [{ ...native, clientUserMessageId: undefined }])).toHaveLength(2)
  })

  it('uses confirmed turn ordinals when a history snapshot omits the client ID', () => {
    const tracker = useConversationDeliveries()
    tracker.begin('a', message())
    tracker.patch('d-1', { status: 'accepted', turnId: 't', userMessageOrdinal: 1 })
    const earlier = { id: 'old', role: 'user' as const, text: 'keep going', turnId: 't', userMessageOrdinal: 0 }
    tracker.observe('a', [earlier])
    expect(tracker.rows.value).toHaveLength(1)
    tracker.observe('a', [{ ...earlier, id: 'new', userMessageOrdinal: 1 }])
    expect(tracker.rows.value).toHaveLength(0)
  })

  it('preserves the turn position through a reload during queue-to-steer and an acknowledgement gap', async () => {
    const tracker = useConversationDeliveries()
    tracker.begin('a', message(), 2, true, 'original-turn')
    const restored = useConversationDeliveries()
    expect(restored.rows.value[0].status).toBe('unknown')
    restored.patch('d-1', { status: 'accepted', turnId: 'original-turn' })
    expect(restored.rows.value[0].userMessageOrdinal).toBe(2)
    const history = [{ id: 'original', role: 'assistant' as const, text: 'original reply', turnId: 'original-turn' }, { id: 'later', role: 'assistant' as const, text: 'later reply', turnId: 'later-turn' }]
    expect(restored.project('a', history).map(row => row.id)).toEqual(['original', 'delivery-user:d-1', 'later'])
    restored.observe('a', [{ id: 'native', role: 'user', text: message().text, turnId: 'original-turn', userMessageOrdinal: 2 }])
    expect(restored.rows.value).toEqual([])
  })

  it('restores acknowledged content from tab storage when persistent storage is full without resending', async () => {
    const pending = rememberWebDelivery('delivery', { protocol: 2, threadId: 'a', mode: 'steer', message: message() })
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('storage full') })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { id: pending.id, status: 'accepted', turnId: 't' } }))))
    expect((await submitRememberedDelivery(pending)).data.status).toBe('accepted')
    expect(fetch).toHaveBeenCalledTimes(1)
    const reloaded = useConversationDeliveries()
    expect(reloaded.project('a', [])[0]).toMatchObject({ text: 'keep going', deliveryState: { status: 'accepted' } })
    expect(sessionStorage.length).toBe(1)
    const native = { id: 'native', role: 'user' as const, text: 'keep going', turnId: 't', clientUserMessageId: pending.id }
    reloaded.observe('a', [native])
    expect(readConversationDeliveryCache()).toEqual([])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps uncertainty after a lost response and after an empty server snapshot', async () => {
    const pending = rememberWebDelivery('delivery', { protocol: 2, threadId: 'a', mode: 'steer', message: message() })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('disconnected')))
    await expect(submitRememberedDelivery(pending)).rejects.toThrow('disconnected')
    const tracker = useConversationDeliveries()
    tracker.refresh()
    tracker.syncQueue({})
    expect(tracker.project('a', [])[0].deliveryState?.status).toBe('unknown')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('retains cancellation, ignores stale revisions, and never exposes ordinary queued messages as sent', () => {
    const tracker = useConversationDeliveries()
    tracker.syncQueue({ a: [{ ...message(), delivery: { status: 'queued', mode: 'queue', revision: 1, createdAt: 1, updatedAt: 1 } }] })
    expect(tracker.rows.value).toEqual([])
    tracker.syncQueue({ a: [{ ...message(), delivery: { status: 'failed', mode: 'steer', revision: 3, createdAt: 1, updatedAt: 3 } }] })
    tracker.syncQueue({ a: [{ ...message(), delivery: { status: 'sending', mode: 'steer', revision: 2, createdAt: 1, updatedAt: 2 } }] })
    expect(tracker.rows.value[0].status).toBe('failed')
    tracker.patch('d-1', { status: 'cancelled' })
    expect(useConversationDeliveries().project('a', [])[0].deliveryState?.status).toBe('cancelled')
  })

  it('promotes a fallback receipt when storage recovers and never downgrades it with stale data', () => {
    localStorage.setItem('preference-fixture', 'unchanged')
    const blocked = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('full') })
    const accepted = { id: 'd-1', threadId: 'a', message: message(), createdAt: 1, status: 'accepted' as const, turnId: 't', revision: 4 }
    saveConversationDelivery(accepted)
    expect(sessionStorage.length).toBe(1)
    blocked.mockRestore()
    saveConversationDelivery({ ...accepted, status: 'sending', revision: 2 })
    expect(sessionStorage.length).toBe(0)
    expect(localStorage.getItem('preference-fixture')).toBe('unchanged')
    expect(readConversationDeliveryCache()[0]).toMatchObject({ status: 'accepted', revision: 4 })
  })

  it('keeps a valid acknowledgement successful if the browser denies both display stores', async () => {
    const pending = rememberWebDelivery('delivery', { protocol: 2, threadId: 'a', mode: 'steer', message: message() })
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { id: pending.id, status: 'accepted', turnId: 't' } }))))
    expect((await submitRememberedDelivery(pending)).data.status).toBe('accepted')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

})
