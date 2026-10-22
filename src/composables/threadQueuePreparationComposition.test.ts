import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createThreadQueueController } from './threadQueueController'
import { readPendingWebDeliveries } from '../api/deliveryOutbox'
import type { ThreadQueueOperation } from '../threadQueue'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const flush = async () => { for (let index = 0; index < 24; index += 1) await Promise.resolve() }
const response = (data: unknown) => ({ ok: true, json: async () => ({ data }) })
const operation = (): ThreadQueueOperation => ({
  type: 'add', threadId: 'thread-a',
  message: { id: 'queue-preparation', text: 'Saved message', imageUrls: [], skills: [], fileAttachments: [], collaborationMode: 'default' },
})
const fetchMock = vi.fn()
const controllers: ReturnType<typeof createThreadQueueController>[] = []
function setup() {
  let revision = 0
  let selectedId = 'thread-a'
  const controller = createThreadQueueController({
    getAccountRevision: () => revision, getSelectedThreadId: () => selectedId,
    getPersistedMessages: () => [], getActiveTurnId: () => undefined,
    readNextUserMessageOrdinal: () => 0, getDeliveryRows: () => [],
    conversationDeliveries: { syncQueue: vi.fn(), begin: vi.fn(), patch: vi.fn(), observe: vi.fn() },
    appendOptimisticUserMessage: vi.fn(), markThreadHistoryDirty: vi.fn(), scheduleDelayedTurnSync: vi.fn(),
    setPageError: vi.fn(), notifyQueueError: vi.fn(), scheduleTimeout: vi.fn(), cancelTimeout: vi.fn(),
  })
  controllers.push(controller)
  return {
    controller,
    changeAccount: () => { revision += 1; controller.invalidateForAccountChange() },
    changeRevision: () => { revision += 1 },
    selectOther: () => { selectedId = 'thread-b' },
  }
}
const posts = () => fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')
beforeEach(() => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size },
  }
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('window', { localStorage: storage, dispatchEvent: vi.fn() })
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset().mockImplementation(async (_url, options) => options?.method === 'POST'
    ? response({ state: {} }) : response({ contextId: 'context-a' }))
})
afterEach(() => { controllers.splice(0).forEach(controller => controller.stop()); vi.unstubAllGlobals() })

describe('queue admission through real controller, lifecycle, gateway and outbox', () => {
  it('rejects preparation after account change while delivery-context headers are pending', async () => {
    const test = setup()
    const waiting = deferred<ReturnType<typeof response>>()
    fetchMock.mockReturnValueOnce(waiting.promise)
    const result = test.controller.commitQueueOperation(operation()).catch(cause => cause)
    await flush()
    test.changeAccount()
    waiting.resolve(response({ contextId: 'context-b' }))
    expect(await result).toBeInstanceOf(Error)
    expect(posts()).toHaveLength(0)
    expect(readPendingWebDeliveries()).toEqual([])
  })

  it.each(['account', 'stop-restart'])('rejects preparation after %s while the JSON body is pending', async kind => {
    const test = setup()
    const body = deferred<{ data: { contextId: string } }>()
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => body.promise })
    const result = test.controller.commitQueueOperation(operation()).catch(cause => cause)
    await flush()
    if (kind === 'account') test.changeAccount()
    else { test.controller.stop(); test.controller.start() }
    body.resolve({ data: { contextId: 'context-b' } })
    expect(await result).toBeInstanceOf(Error)
    expect(posts()).toHaveLength(0)
    expect(readPendingWebDeliveries()).toEqual([])
  })

  it('rejects an old unprepared add waiting behind an accepted mutation before starting its context request', async () => {
    const test = setup()
    const accepted = deferred<ReturnType<typeof response>>()
    fetchMock.mockReturnValueOnce(accepted.promise)
    const removal = test.controller.commitQueueOperation({ type: 'remove', threadId: 'thread-a', messageId: 'removed' })
    await flush()
    const adding = test.controller.commitQueueOperation(operation()).catch(cause => cause)
    test.changeAccount()
    accepted.resolve(response({ state: {} }))
    await removal
    expect(await adding).toBeInstanceOf(Error)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(readPendingWebDeliveries()).toEqual([])
  })

  it('rejects a new add admitted while stopped without starting IO or writing the outbox', async () => {
    const test = setup()
    test.controller.stop()
    const result = test.controller.commitQueueOperation(operation()).catch(cause => cause)
    expect(await result).toBeInstanceOf(Error)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(readPendingWebDeliveries()).toEqual([])
  })

  it('does not revive an add admitted while stopped when start runs before the mutation chain', async () => {
    const test = setup()
    test.controller.stop()
    const result = test.controller.commitQueueOperation(operation()).catch(cause => cause)
    test.controller.start()
    expect(await result).toBeInstanceOf(Error)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(readPendingWebDeliveries()).toEqual([])
  })

  it('checks the captured account revision even before peer lifecycle invalidation', async () => {
    const test = setup()
    const waiting = deferred<ReturnType<typeof response>>()
    fetchMock.mockReturnValueOnce(waiting.promise)
    const result = test.controller.commitQueueOperation(operation()).catch(cause => cause)
    await flush()
    test.changeRevision()
    waiting.resolve(response({ contextId: 'context-b' }))
    expect(await result).toBeInstanceOf(Error)
    expect(posts()).toHaveLength(0)
    expect(readPendingWebDeliveries()).toEqual([])
  })

  it('preserves a durably prepared intent and its original account context after account change', async () => {
    const test = setup()
    vi.mocked(window.dispatchEvent).mockImplementation(() => { test.changeAccount(); return true })
    await test.controller.commitQueueOperation(operation())
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(posts()).toHaveLength(1)
    expect(JSON.parse(posts()[0]![1].body)).toMatchObject({ threadId: 'thread-a', expectedContextId: 'context-a', message: { id: 'queue-preparation' } })
    expect(readPendingWebDeliveries()).toEqual([])
  })

  it('keeps a same-account intent bound to the original conversation when selection changes', async () => {
    const test = setup()
    const waiting = deferred<ReturnType<typeof response>>()
    fetchMock.mockReturnValueOnce(waiting.promise)
    const adding = test.controller.commitQueueOperation(operation())
    await flush()
    test.selectOther()
    waiting.resolve(response({ contextId: 'context-a' }))
    await adding
    expect(posts()).toHaveLength(1)
    expect(JSON.parse(posts()[0]![1].body).threadId).toBe('thread-a')
  })
})
