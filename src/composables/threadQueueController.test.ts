import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { StoredQueuedMessage, ThreadQueueResult, ThreadQueueState } from '../threadQueue'
import { createThreadQueueController } from './threadQueueController'
import { useConversationDeliveries } from './useConversationDeliveries'

const api = vi.hoisted(() => ({ read: vi.fn(), mutate: vi.fn(), receipts: vi.fn() }))
vi.mock('../api/threadQueueGateway', () => ({
  getThreadQueueState: api.read,
  mutateThreadQueueState: api.mutate,
  getDeliveryStatuses: api.receipts,
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function message(id = 'queue-message', mode: 'queue' | 'steer' = 'queue'): StoredQueuedMessage {
  return { id, text: id, imageUrls: ['image'], skills: [{ name: 'skill', path: '/skill' }],
    fileAttachments: [{ label: 'file', path: 'file', fsPath: '/file' }], collaborationMode: 'plan',
    model: 'fixture-model', effort: 'high', serviceTier: null,
    delivery: { mode, status: 'queued', revision: 3, createdAt: 1, updatedAt: 2 } }
}

function setup() {
  const selected = ref('thread')
  let account = 0
  const deliveries = useConversationDeliveries()
  const append = vi.fn()
  const dirty = vi.fn()
  const delayedSync = vi.fn()
  const pageError = vi.fn()
  const notify = vi.fn()
  const timers: Array<() => void> = []
  const cancel = vi.fn()
  const controller = createThreadQueueController({
    getAccountRevision: () => account,
    getSelectedThreadId: () => selected.value,
    getPersistedMessages: () => [],
    getActiveTurnId: () => 'source-turn',
    readNextUserMessageOrdinal: () => 2,
    getDeliveryRows: () => deliveries.rows.value,
    conversationDeliveries: { begin: deliveries.begin, patch: deliveries.patch, observe: deliveries.observe, syncQueue: deliveries.syncQueue },
    appendOptimisticUserMessage: append,
    markThreadHistoryDirty: dirty,
    scheduleDelayedTurnSync: delayedSync,
    setPageError: pageError,
    notifyQueueError: notify,
    scheduleTimeout: callback => { timers.push(callback); return timers.length },
    cancelTimeout: cancel,
  })
  return { controller, deliveries, selected, append, dirty, delayedSync, pageError, notify, timers, cancel,
    changeAccount: () => { account++; controller.invalidateForAccountChange() } }
}

beforeEach(() => {
  vi.resetAllMocks()
  const storage = new Map<string, string>()
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() { return storage.size },
  } })
  api.read.mockResolvedValue({})
  api.mutate.mockResolvedValue({ state: {} })
  api.receipts.mockResolvedValue([])
})
afterEach(() => vi.unstubAllGlobals())

describe('thread queue controller', () => {
  it('owns selected queue projections and preserves array identity without copies', async () => {
    const { controller, selected } = setup()
    api.read.mockResolvedValue({ thread: [message()], other: [message('other')] })
    await controller.refreshQueueState()
    expect(controller.getMessages('thread')).toBe(controller.selectedThreadQueuedMessages.value)
    selected.value = 'other'
    expect(controller.selectedThreadQueuedMessages.value.map(row => row.id)).toEqual(['other'])
    if (false) {
      // Public records and row fields cannot bypass the queue owner.
      // @ts-expect-error readonly array
      controller.selectedThreadQueuedMessages.value.push(message())
      // @ts-expect-error readonly row
      controller.getMessages('thread')[0]!.text = 'changed'
      // @ts-expect-error readonly attachment collection
      controller.getMessages('thread')[0]!.imageUrls.push('changed')
      // @ts-expect-error readonly skill fields
      controller.getMessages('thread')[0]!.skills[0]!.name = 'changed'
      // @ts-expect-error readonly computed
      controller.queueStateError.value = 'changed'
    }
  })

  it('loads persisted state once after success, retries failure and reloads after account change', async () => {
    const { controller, changeAccount } = setup()
    api.read.mockRejectedValueOnce(new Error('transient'))
    await controller.loadPersistedStateIfNeeded()
    await controller.loadPersistedStateIfNeeded()
    await controller.loadPersistedStateIfNeeded()
    expect(api.read).toHaveBeenCalledTimes(2)
    changeAccount()
    await controller.loadPersistedStateIfNeeded()
    expect(api.read).toHaveBeenCalledTimes(3)
  })

  it('serializes accepted writes across stop and blocks reads until the writes finish', async () => {
    const { controller } = setup()
    const first = deferred<ThreadQueueResult>()
    api.mutate.mockReturnValueOnce(first.promise)
    const operation = { type: 'remove' as const, threadId: 'thread', messageId: 'message' }
    const old = controller.commitQueueOperation(operation)
    await Promise.resolve()
    controller.stop()
    controller.start()
    const current = controller.commitQueueOperation(operation)
    const read = controller.refreshQueueState()
    await Promise.resolve()
    expect(api.mutate).toHaveBeenCalledTimes(1)
    expect(api.read).not.toHaveBeenCalled()
    first.resolve({ state: { old: [message()] } })
    await Promise.all([old, current, read])
    expect(api.mutate).toHaveBeenCalledTimes(2)
    expect(api.read).toHaveBeenCalledTimes(1)
    expect(controller.getMessages('old')).toEqual([])
  })

  it('uses queue revisions for remove and reorder and preserves removed content', async () => {
    const { controller } = setup()
    const row = message()
    api.read.mockResolvedValue({ thread: [row, message('target')] })
    await controller.refreshQueueState()
    api.mutate.mockResolvedValueOnce({ state: { thread: [row] } })
    await controller.reorderQueuedMessage(row.id, 'target')
    expect(api.mutate).toHaveBeenLastCalledWith({ type: 'move', threadId: 'thread', messageId: row.id, targetId: 'target', revision: 3 })
    api.mutate.mockResolvedValueOnce({ state: {}, removed: row })
    expect(await controller.removeQueuedMessage(row.id)).toEqual(row)
    expect(controller.selectedThreadQueuedMessages.value).toEqual([])
  })

  it('preserves the edit token, revision, attachments and already-editing fast path', async () => {
    const { controller } = setup()
    const row = message()
    api.read.mockResolvedValue({ thread: [row] })
    await controller.refreshQueueState()
    const editing = { ...row, delivery: { ...row.delivery!, status: 'editing' as const, revision: 4, editToken: 'token' } }
    api.mutate.mockResolvedValueOnce({ state: { thread: [editing] } })
    expect(await controller.beginQueuedMessageEdit(row.id)).toEqual(editing)
    expect(api.mutate.mock.calls[0]![0]).toMatchObject({ type: 'edit', revision: 3, editToken: expect.any(String) })
    await controller.beginQueuedMessageEdit(row.id)
    expect(api.mutate).toHaveBeenCalledTimes(1)
    const contents = { text: 'edited', imageUrls: row.imageUrls, skills: row.skills, fileAttachments: row.fileAttachments }
    await controller.updateQueuedMessage('thread', row.id, 4, 'token', contents)
    expect(api.mutate).toHaveBeenLastCalledWith({ type: 'update', threadId: 'thread', messageId: row.id,
      revision: 4, editToken: 'token', message: { ...contents, id: row.id, collaborationMode: 'default' } })
  })

  it.each(['source-turn', 'new-turn'])('settles steering exactly once in %s with the correct ordinal', async turnId => {
    const { controller, deliveries, dirty, delayedSync, append } = setup()
    const row = message()
    api.read.mockResolvedValue({ thread: [row] })
    await controller.refreshQueueState()
    api.mutate.mockResolvedValue({ state: {}, delivered: { id: row.id, turnId } })
    await controller.steerQueuedMessage(row.id)
    expect(deliveries.rows.value).toMatchObject([{ status: 'accepted', turnId, userMessageOrdinal: turnId === 'source-turn' ? 2 : 0 }])
    expect(append).not.toHaveBeenCalled()
    expect(dirty).toHaveBeenCalledTimes(1)
    expect(delayedSync).toHaveBeenCalledTimes(1)
  })

  it('appends a reconciled non-steering delivery through the history command', async () => {
    const { controller, append } = setup()
    const row = message()
    api.read.mockResolvedValue({ thread: [row] })
    await controller.refreshQueueState()
    api.mutate.mockResolvedValue({ state: {}, delivered: { id: row.id, turnId: 'new-turn' } })
    await controller.changeQueuedMessage(row.id, 'reconcile')
    expect(append).toHaveBeenCalledWith('thread', row.text, row.imageUrls, row.skills, row.fileAttachments,
      { id: row.id, turnId: 'new-turn', userMessageOrdinal: 0 })
  })

  it('shows current queue errors, limits notifications to selection and clears errors after success', async () => {
    const { controller, selected, pageError, notify } = setup()
    api.mutate.mockRejectedValueOnce(new Error('current mutation failure'))
    await controller.commitQueueOperation({ type: 'remove', threadId: 'thread', messageId: 'id' }).catch(() => {})
    expect(controller.selectedThreadQueueError.value).toBe('current mutation failure')
    expect(pageError).toHaveBeenCalledWith('current mutation failure')
    expect(notify).toHaveBeenCalledTimes(1)
    selected.value = 'other'
    api.mutate.mockRejectedValueOnce(new Error('background failure'))
    await controller.commitQueueOperation({ type: 'remove', threadId: 'thread', messageId: 'id' }).catch(() => {})
    expect(notify).toHaveBeenCalledTimes(1)
    selected.value = 'thread'
    await controller.commitQueueOperation({ type: 'remove', threadId: 'thread', messageId: 'id' })
    expect(controller.selectedThreadQueueError.value).toBe('')
    api.read.mockRejectedValueOnce(new Error('read failure'))
    await controller.refreshQueueState().catch(() => {})
    expect(controller.queueStateError.value).toBe('read failure')
    await controller.refreshQueueState()
    expect(controller.queueStateError.value).toBe('')
  })

  it.each(['stop', 'account'])('rejects old action results and releases state after %s', async kind => {
    const { controller, changeAccount, deliveries, delayedSync, pageError } = setup()
    const row = message()
    api.read.mockResolvedValue({ thread: [row] })
    await controller.refreshQueueState()
    const first = deferred<ThreadQueueResult>()
    api.mutate.mockReturnValueOnce(first.promise)
    const old = controller.steerQueuedMessage(row.id)
    await Promise.resolve()
    if (kind === 'stop') { controller.stop(); controller.start() }
    else changeAccount()
    expect(controller.selectedThreadQueuedMessages.value).toEqual([])
    first.resolve({ state: { thread: [row] }, delivered: { id: row.id, turnId: 'old' } })
    await old
    expect(controller.selectedThreadQueuedMessages.value).toEqual([])
    expect(deliveries.rows.value[0]?.status).toBe('submitting')
    expect(delayedSync).not.toHaveBeenCalled()
    expect(pageError).not.toHaveBeenCalled()
  })

  it.each(['stop', 'account'])('isolates receipt slots and late commits after %s', async kind => {
    const { controller, changeAccount, deliveries } = setup()
    const row = message('receipt', 'steer')
    api.read.mockResolvedValueOnce({ thread: [row] })
    await controller.refreshQueueState()
    const oldRead = deferred<Array<{ id: string; status: 'accepted' | 'cancelled'; turnId?: string }>>()
    const currentRead = deferred<Array<{ id: string; status: 'accepted' | 'cancelled'; turnId?: string }>>()
    api.receipts.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(currentRead.promise)
    api.read.mockResolvedValue({})
    await controller.refreshQueueState()
    const old = controller.refreshVisibleDeliveryReceipts()
    if (kind === 'stop') { controller.stop(); controller.start() }
    else changeAccount()
    const current = controller.refreshVisibleDeliveryReceipts()
    expect(api.receipts).toHaveBeenCalledTimes(2)
    oldRead.resolve([{ id: row.id, status: 'cancelled' }])
    await old
    expect(deliveries.rows.value[0]?.status).toBe('queued')
    expect(controller.refreshVisibleDeliveryReceipts()).toBe(current)
    currentRead.resolve([{ id: row.id, status: 'accepted', turnId: 'new' }])
    await current
    expect(deliveries.rows.value[0]?.status).toBe('accepted')
  })

  it('bounds receipt reads to 100 valid IDs and keeps content visible across failures', async () => {
    const { controller, deliveries } = setup()
    const rows = Array.from({ length: 105 }, (_, index) => message(`receipt-${index}`, 'steer'))
    api.read.mockResolvedValueOnce({ thread: rows })
    await controller.refreshQueueState()
    const failure = deferred<Array<{ id: string; status: 'accepted' }>>()
    api.receipts.mockReturnValueOnce(failure.promise)
    await controller.refreshQueueState()
    expect(api.receipts.mock.calls[0]![1]).toHaveLength(100)
    const joined = controller.refreshVisibleDeliveryReceipts()
    expect(api.receipts).toHaveBeenCalledTimes(1)
    failure.reject(new Error('receipt read failure'))
    await joined
    expect(deliveries.rows.value).toHaveLength(105)
    await controller.refreshVisibleDeliveryReceipts()
    expect(api.receipts).toHaveBeenCalledTimes(2)
  })

  it('isolates old processing completions and cancels callbacks across ten restarts', async () => {
    const { controller, timers, cancel } = setup()
    const first = deferred<ThreadQueueState>()
    const second = deferred<ThreadQueueState>()
    api.read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    controller.scheduleQueueStateRefresh('thread')
    await Promise.resolve()
    controller.stop()
    controller.start()
    controller.scheduleQueueStateRefresh('thread')
    await Promise.resolve()
    first.resolve({})
    for (let index = 0; index < 6; index++) await Promise.resolve()
    controller.scheduleQueueStateRefresh('thread')
    await Promise.resolve()
    expect(api.read).toHaveBeenCalledTimes(2)
    second.resolve({})
    for (let index = 0; index < 6; index++) await Promise.resolve()
    for (let index = 0; index < 10; index++) {
      controller.scheduleQueueStateRefresh('thread')
      controller.stop()
      controller.start()
    }
    const reads = api.read.mock.calls.length
    for (const callback of timers) callback()
    await Promise.resolve()
    expect(api.read).toHaveBeenCalledTimes(reads)
    expect(cancel).toHaveBeenCalledTimes(timers.length)
  })
})
