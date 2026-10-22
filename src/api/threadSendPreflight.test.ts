import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rpcCall } from './codexRpcClient'
import { startThreadTurn } from './threadCommandGateway'
import { invalidateModelCatalog } from './modelCatalog'
import { prepareWebDelivery, readPendingWebDeliveries, rememberWebDelivery, type WebSubmission } from './deliveryOutbox'

vi.mock('./codexRpcClient', () => ({ rpcCall: vi.fn() }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function setup() {
  let current = true
  const saved = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    get length() { return saved.size }, key: (index: number) => [...saved.keys()][index] ?? null,
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key),
  })
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/provider-models')) return new Response(JSON.stringify({ data: [] }))
    if (url.endsWith('/delivery-context')) return new Response(JSON.stringify({ data: { contextId: 'account-original' } }))
    const body = JSON.parse(init!.body as string)
    return new Response(JSON.stringify({ data: { id: body.message.id, status: 'accepted', turnId: 'accepted-turn' } }))
  })
  vi.stubGlobal('fetch', fetch)
  const options = { id: 'd-preflight', canPrepare: () => current }
  const send = (model: 'model' | 'resolve' = 'model') => startThreadTurn('thread', 'prompt', [], model === 'resolve' ? undefined : model, undefined, [], [], 'default', null, 'immediate', options)
  return { fetch, saved, options, send, invalidate: () => { current = false } }
}

beforeEach(() => { vi.resetAllMocks(); invalidateModelCatalog() })
afterEach(() => vi.unstubAllGlobals())

describe('thread send preparation context', () => {
  it('does not acquire a new account snapshot after collaboration config completes in an obsolete context', async () => {
    const test = setup()
    const config = deferred<unknown>()
    vi.mocked(rpcCall).mockReturnValueOnce(config.promise)
    const sending = test.send('resolve')
    const settled = sending.catch(cause => cause)
    test.invalidate()
    config.resolve({ config: { model: 'configured' } })
    expect(await settled).toBeInstanceOf(Error)
    expect(test.fetch).not.toHaveBeenCalled()
    expect(readPendingWebDeliveries()).toEqual([])
  })

  it('does not fall back to another model lookup after an obsolete config failure', async () => {
    const test = setup()
    const config = deferred<unknown>()
    vi.mocked(rpcCall).mockReturnValueOnce(config.promise).mockResolvedValue({ data: [{ id: 'fallback', model: 'fallback' }] })
    const sending = test.send('resolve')
    const settled = sending.catch(cause => cause)
    test.invalidate()
    config.reject(new Error('old config failure'))
    expect(await settled).toBeInstanceOf(Error)
    expect(rpcCall).toHaveBeenCalledTimes(1)
    expect(test.fetch).not.toHaveBeenCalled()
  })

  it('does not start account preparation after a shared model catalog resolves in an obsolete context', async () => {
    const test = setup()
    const catalog = deferred<unknown>()
    vi.mocked(rpcCall).mockResolvedValueOnce({ config: {} }).mockReturnValueOnce(catalog.promise)
    const settled = test.send('resolve').catch(cause => cause)
    await vi.waitFor(() => expect(rpcCall).toHaveBeenCalledTimes(2))
    test.invalidate()
    catalog.resolve({ data: [{ id: 'fallback', model: 'fallback' }] })
    expect(await settled).toBeInstanceOf(Error)
    expect(test.fetch.mock.calls.map(([url]) => url)).toEqual(['/codex-api/provider-models'])
    expect(readPendingWebDeliveries()).toEqual([])
  })

  it('does not remember or post an old intent using a newly acquired account context', async () => {
    const test = setup()
    const context = deferred<Response>()
    test.fetch.mockReturnValueOnce(context.promise)
    const sending = test.send()
    const settled = sending.catch(cause => cause)
    await vi.waitFor(() => expect(test.fetch).toHaveBeenCalledOnce())
    test.invalidate()
    context.resolve(new Response(JSON.stringify({ data: { contextId: 'account-current' } })))
    expect(await settled).toBeInstanceOf(Error)
    expect(test.fetch).toHaveBeenCalledTimes(1)
    expect(readPendingWebDeliveries()).toEqual([])
  })

  it('checks context again after parsing an awaited account response body', async () => {
    const test = setup()
    const json = deferred<unknown>()
    test.fetch.mockResolvedValueOnce({ ok: true, json: () => json.promise } as Response)
    const sending = test.send()
    const settled = sending.catch(cause => cause)
    await vi.waitFor(() => expect(test.fetch).toHaveBeenCalledOnce())
    test.invalidate()
    json.resolve({ data: { contextId: 'account-current' } })
    expect(await settled).toBeInstanceOf(Error)
    expect(test.fetch).toHaveBeenCalledTimes(1)
    expect(test.saved.size).toBe(0)
  })

  it('continues the remembered request if its display observer invalidates context after persistence', async () => {
    const test = setup()
    const options = { ...test.options, onPrepared: test.invalidate }
    expect(await startThreadTurn('thread', 'prompt', [], 'model', undefined, [], [], 'default', null, 'immediate', options)).toBe('accepted-turn')
    expect(test.fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(test.fetch.mock.calls[1][1]!.body as string).expectedContextId).toBe('account-original')
    expect(readPendingWebDeliveries()).toEqual([])
  })

  it('does not cancel an already posted remembered request or change its account snapshot', async () => {
    const test = setup()
    const response = deferred<Response>()
    test.fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ data: { contextId: 'account-original' } }))).mockReturnValueOnce(response.promise)
    const sending = test.send()
    await vi.waitFor(() => expect(test.fetch).toHaveBeenCalledTimes(2))
    expect(readPendingWebDeliveries()).toHaveLength(1)
    test.invalidate()
    response.resolve(new Response(JSON.stringify({ data: { id: test.options.id, status: 'accepted', turnId: 'accepted-turn' } })))
    expect(await sending).toBe('accepted-turn')
    expect(JSON.parse(test.fetch.mock.calls[1][1]!.body as string).expectedContextId).toBe('account-original')
    expect(readPendingWebDeliveries()).toEqual([])
  })

  it('preserves an existing remembered record when a stale caller starts preparation', async () => {
    const test = setup()
    const body: WebSubmission = { protocol: 2, threadId: 'thread', expectedContextId: 'account-original', message: { id: 'd-previous', text: 'prompt', imageUrls: [], skills: [], fileAttachments: [], collaborationMode: 'default' } }
    const previous = rememberWebDelivery('delivery', body)
    test.invalidate()
    const guardedPrepare = prepareWebDelivery as (endpoint: 'delivery', body: WebSubmission, canPrepare?: () => boolean) => ReturnType<typeof prepareWebDelivery>
    await expect(guardedPrepare('delivery', body, test.options.canPrepare)).rejects.toThrow()
    expect(readPendingWebDeliveries()).toEqual([previous])
    expect(test.fetch).not.toHaveBeenCalled()
  })
})
