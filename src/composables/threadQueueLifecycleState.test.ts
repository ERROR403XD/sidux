import { describe, expect, it, vi } from 'vitest'
import { createThreadQueueLifecycleState } from './threadQueueLifecycleState'
import type { StoredQueuedMessage, ThreadQueueResult, ThreadQueueState } from '../threadQueue'

function queuedMessage(id: string): StoredQueuedMessage {
  return {
    id,
    text: `message-${id}`,
    imageUrls: [],
    skills: [],
    fileAttachments: [],
    collaborationMode: 'default',
  }
}

describe('thread queue lifecycle state', () => {
  it('invalidates account work while retaining accepted mutation order', async () => {
    let finish!: (result: ThreadQueueResult) => void
    const mutate = vi.fn()
      .mockImplementationOnce(() => new Promise<ThreadQueueResult>(resolve => { finish = resolve }))
      .mockResolvedValue({ state: {} })
    const apply = vi.fn()
    const state = createThreadQueueLifecycleState({
      getQueueState: async () => ({}), mutateQueueState: mutate, applyQueueState: apply,
      markRemoved: vi.fn(), markMutationSucceeded: vi.fn(), markMutationFailed: vi.fn(),
      scheduleTimeout: vi.fn(() => 1), cancelTimeout: vi.fn(),
    })
    const oldContext = state.captureContext()
    const operation = { type: 'remove' as const, threadId: 'thread', messageId: 'message' }
    const old = state.runMutation(operation)
    await Promise.resolve()
    state.invalidateForAccountChange()
    expect(oldContext()).toBe(false)
    expect(state.captureContext()()).toBe(true)
    const current = state.runMutation(operation)
    await Promise.resolve()
    expect(mutate).toHaveBeenCalledTimes(1)
    finish({ state: {} })
    await Promise.all([old, current])
    expect(mutate).toHaveBeenCalledTimes(2)
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('suppresses read failures superseded by a successful mutation', async () => {
    let reject!: (cause: Error) => void
    const apply = vi.fn()
    const state = createThreadQueueLifecycleState({
      getQueueState: () => new Promise<ThreadQueueState>((_, fail) => { reject = fail }),
      mutateQueueState: async () => ({ state: {} }), applyQueueState: apply,
      markRemoved: vi.fn(), markMutationSucceeded: vi.fn(), markMutationFailed: vi.fn(),
      scheduleTimeout: vi.fn(() => 1), cancelTimeout: vi.fn(),
    })
    const old = state.refresh()
    await Promise.resolve()
    await state.runMutation({ type: 'remove', threadId: 'thread', messageId: 'message' })
    reject(new Error('superseded queue failure'))
    await expect(old).resolves.toBeUndefined()
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('keeps a reused current timer registered when an old callback is retained', () => {
    const callbacks: Array<() => void> = []
    const cancel = vi.fn()
    const process = vi.fn(async () => {})
    const state = createThreadQueueLifecycleState({
      getQueueState: async () => ({}), mutateQueueState: async () => ({ state: {} }),
      applyQueueState: vi.fn(), markRemoved: vi.fn(), markMutationSucceeded: vi.fn(), markMutationFailed: vi.fn(),
      scheduleTimeout: callback => { callbacks.push(callback); return 1 }, cancelTimeout: cancel,
    })
    state.scheduleRefresh('thread', process)
    state.stop()
    state.start()
    state.scheduleRefresh('thread', process)
    callbacks[0]!()
    state.stop()
    expect(process).toHaveBeenCalledTimes(2)
    expect(cancel).toHaveBeenCalledTimes(2)
  })

  it.each(['success', 'failure'])('isolates a late mutation %s after stop and restart', async outcome => {
    let resolve!: (result: ThreadQueueResult) => void
    let reject!: (error: Error) => void
    const mutate = vi.fn(() => new Promise<ThreadQueueResult>((done, fail) => { resolve = done; reject = fail }))
    const applyQueueState = vi.fn()
    const markRemoved = vi.fn()
    const markMutationSucceeded = vi.fn()
    const markMutationFailed = vi.fn()
    const state = createThreadQueueLifecycleState({
      getQueueState: async () => ({}), mutateQueueState: mutate,
      applyQueueState, markRemoved, markMutationSucceeded, markMutationFailed,
      scheduleTimeout: vi.fn(() => 1), cancelTimeout: vi.fn(),
    })
    const operation = { type: 'remove' as const, threadId: 'thread', messageId: 'message' }
    const old = state.runMutation(operation)
    const observed = old.catch(cause => cause)
    await Promise.resolve()
    state.stop()
    state.start()
    if (outcome === 'success') resolve({ state: {}, removed: queuedMessage('message') })
    else reject(new Error('Late failure'))
    await observed
    expect(applyQueueState).not.toHaveBeenCalled()
    expect(markRemoved).not.toHaveBeenCalled()
    expect(markMutationSucceeded).not.toHaveBeenCalled()
    expect(markMutationFailed).not.toHaveBeenCalled()
    await state.loadPersistedStateIfNeeded()
    expect(applyQueueState).toHaveBeenCalledTimes(1)
  })

  it('preserves accepted mutation ordering across stop without applying old results', async () => {
    let finish!: (result: ThreadQueueResult) => void
    const mutate = vi.fn()
      .mockImplementationOnce(() => new Promise<ThreadQueueResult>(resolve => { finish = resolve }))
      .mockResolvedValue({ state: {} })
    const applyQueueState = vi.fn()
    const state = createThreadQueueLifecycleState({
      getQueueState: async () => ({}), mutateQueueState: mutate, applyQueueState,
      markRemoved: vi.fn(), markMutationSucceeded: vi.fn(), markMutationFailed: vi.fn(),
      scheduleTimeout: vi.fn(() => 1), cancelTimeout: vi.fn(),
    })
    const operation = { type: 'remove' as const, threadId: 'thread', messageId: 'message' }
    const old = state.runMutation(operation)
    await Promise.resolve()
    state.stop()
    state.start()
    const current = state.runMutation(operation)
    await Promise.resolve()
    expect(mutate).toHaveBeenCalledTimes(1)
    finish({ state: {} })
    await Promise.all([old, current])
    expect(mutate).toHaveBeenCalledTimes(2)
    expect(applyQueueState).toHaveBeenCalledTimes(1)
  })

  it('does not mark a stopped read as loaded or invoke a cancelled refresh callback', async () => {
    let finish!: (state: ThreadQueueState) => void
    const read = vi.fn().mockImplementationOnce(() => new Promise<ThreadQueueState>(resolve => { finish = resolve })).mockResolvedValue({})
    let callback!: () => void
    const process = vi.fn(async () => {})
    const state = createThreadQueueLifecycleState({
      getQueueState: read, mutateQueueState: vi.fn(), applyQueueState: vi.fn(),
      markRemoved: vi.fn(), markMutationSucceeded: vi.fn(), markMutationFailed: vi.fn(),
      scheduleTimeout: action => { callback = action; return 1 }, cancelTimeout: vi.fn(),
    })
    const loading = state.loadPersistedStateIfNeeded()
    await Promise.resolve()
    state.scheduleRefresh('thread', process)
    state.stop()
    state.start()
    callback()
    finish({})
    await loading
    await state.loadPersistedStateIfNeeded()
    expect(read).toHaveBeenCalledTimes(2)
    expect(process).toHaveBeenCalledTimes(1)
  })

  it('rejects stale reads and serializes mutations', async () => {
    const applied: ThreadQueueState[] = []
    const queuedState: ThreadQueueState = { 'thread-1': [queuedMessage('queued-1')] }
    const mutableState: ThreadQueueState = { 'thread-2': [queuedMessage('queued-2')] }
    let releaseRead: (() => void) | undefined
    const state = createThreadQueueLifecycleState({
      getQueueState: () => new Promise<ThreadQueueState>(resolve => {
        releaseRead = () => resolve({})
      }),
      mutateQueueState: async (): Promise<ThreadQueueResult> => ({ state: mutableState }),
      applyQueueState: next => applied.push(next),
      markRemoved: vi.fn(),
      markMutationSucceeded: vi.fn(),
      markMutationFailed: vi.fn(),
      scheduleTimeout: vi.fn(() => 0),
      cancelTimeout: vi.fn(),
    })
    const read = state.refresh()
    await Promise.resolve()
    mutableState['thread-2'] = []
    await state.runMutation({ type: 'remove', threadId: 'thread-2', messageId: 'queued-2' })
    releaseRead!()
    await read
    expect(applied).toEqual([mutableState])
  })

  it('loads persisted state once only after a successful read and retries failures', async () => {
    let reads = 0
    let failNext = true
    const state = createThreadQueueLifecycleState({
      getQueueState: async () => {
        reads += 1
        if (failNext) throw new Error('fixture read failed')
        return {}
      },
      mutateQueueState: vi.fn(async (): Promise<ThreadQueueResult> => ({ state: {} })),
      applyQueueState: vi.fn(),
      markRemoved: vi.fn(),
      markMutationSucceeded: vi.fn(),
      markMutationFailed: vi.fn(),
      scheduleTimeout: vi.fn(() => 0),
      cancelTimeout: vi.fn(),
    })
    await state.loadPersistedStateIfNeeded()
    expect(reads).toBe(1)
    failNext = false
    await state.loadPersistedStateIfNeeded()
    await state.loadPersistedStateIfNeeded()
    expect(reads).toBe(2)
  })

  it('schedules one delayed queue refresh and cancels registered timers on stop', () => {
    const timers = new Map<number, () => void>()
    const process = vi.fn()
    const state = createThreadQueueLifecycleState({
      getQueueState: async () => ({}),
      mutateQueueState: vi.fn(async (): Promise<ThreadQueueResult> => ({ state: {} })),
      applyQueueState: vi.fn(),
      markRemoved: vi.fn(),
      markMutationSucceeded: vi.fn(),
      markMutationFailed: vi.fn(),
      scheduleTimeout: (callback, delay) => {
        expect(delay).toBe(650)
        const timer = timers.size + 1
        timers.set(timer, callback)
        return timer
      },
      cancelTimeout: timer => timers.delete(timer),
    })
    state.scheduleRefresh('thread-1', process)
    state.scheduleRefresh('thread-2', process)
    expect([...timers.keys()]).toEqual([1, 2])
    state.stop()
    expect(timers.size).toBe(0)
  })

  it('marks removed rows after a successful mutation and resets lifecycle state on stop', async () => {
    const markRemoved = vi.fn()
    const removed = queuedMessage('removed')
    const state = createThreadQueueLifecycleState({
      getQueueState: async () => ({}),
      mutateQueueState: async (): Promise<ThreadQueueResult> => ({ state: {}, removed }),
      applyQueueState: vi.fn(),
      markRemoved,
      markMutationSucceeded: vi.fn(),
      markMutationFailed: vi.fn(),
      scheduleTimeout: vi.fn(() => 0),
      cancelTimeout: vi.fn(),
    })
    await state.runMutation({ type: 'remove', threadId: 'thread-1', messageId: 'removed' })
    expect(markRemoved).toHaveBeenCalledWith('removed')
    state.stop()
  })
})
