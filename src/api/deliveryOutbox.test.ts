import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDeliveryId } from '../delivery'
import { prepareWebDelivery, readPendingWebDeliveries, rememberWebDelivery, submitRememberedDelivery, type WebSubmission } from './deliveryOutbox'

let saved: Map<string, string>
beforeEach(() => {
  saved = new Map()
  vi.stubGlobal('localStorage', {
    get length() { return saved.size },
    key: (i: number) => [...saved.keys()][i] ?? null,
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  })
})
afterEach(() => vi.unstubAllGlobals())
const body = (): WebSubmission => ({ protocol: 2, threadId: 'fixture', mode: 'immediate', params: { threadId: 'fixture', input: [{ type: 'text', text: 'fixture' }], model: 'saved-model' }, message: { id: createDeliveryId(), text: 'fixture', imageUrls: [], skills: [], fileAttachments: [], collaborationMode: 'default', model: 'saved-model' } })

describe('browser delivery outbox', () => {
  it('captures the account before submission and reuses that snapshot on a later retry', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { contextId: 'original-account' } })))
    vi.stubGlobal('fetch', fetch)
    const first = await prepareWebDelivery('delivery', body())
    expect(first.body.expectedContextId).toBe('original-account')
    const retry = await prepareWebDelivery('delivery', body())
    expect(retry).toEqual(first)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('retains the exact request across a lost response and reload, then clears only after acknowledgement', async () => {
    const original = rememberWebDelivery('delivery', body())
    const fetch = vi.fn().mockRejectedValueOnce(new Error('network disconnected'))
    vi.stubGlobal('fetch', fetch)
    await expect(submitRememberedDelivery(original)).rejects.toThrow('network')
    const restored = readPendingWebDeliveries('fixture')[0]
    expect(restored).toEqual(original)
    expect(rememberWebDelivery('delivery', body()).id).toBe(original.id)
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: original.id, status: 'accepted', turnId: 'native' } })))
    await submitRememberedDelivery(restored)
    expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body)
    expect(readPendingWebDeliveries()).toEqual([])
  })

  it('blocks a different intent until the previous submission is resolved', () => {
    rememberWebDelivery('delivery', body())
    const changed = body()
    changed.message.text = 'another intent'
    expect(() => rememberWebDelivery('delivery', changed)).toThrow('核对提交')
    expect(readPendingWebDeliveries()).toHaveLength(1)
  })

  it('does not send when persistence fails and retains malformed or error responses', async () => {
    vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => { throw new Error('quota') })
    expect(() => rememberWebDelivery('delivery', body())).toThrow('尚未提交')
    const pending = rememberWebDelivery('delivery', body())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{}')).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'fixture rejection' }), { status: 409 })))
    await expect(submitRememberedDelivery(pending)).rejects.toThrow('有效')
    await expect(submitRememberedDelivery(pending)).rejects.toThrow('fixture rejection')
    expect(readPendingWebDeliveries()[0].id).toBe(pending.id)
  })

  it('coalesces duplicate same-ID requests while an HTTP response is pending', async () => {
    const pending = rememberWebDelivery('delivery', body())
    let resolve!: (value: Response) => void
    const fetch = vi.fn(() => new Promise<Response>(done => { resolve = done }))
    vi.stubGlobal('fetch', fetch)
    const first = submitRememberedDelivery(pending)
    const second = submitRememberedDelivery(pending)
    expect(fetch).toHaveBeenCalledTimes(1)
    resolve(new Response(JSON.stringify({ data: { id: pending.id, status: 'unknown' } })))
    expect(await first).toEqual(await second)
    expect(readPendingWebDeliveries()).toEqual([])
  })
})
