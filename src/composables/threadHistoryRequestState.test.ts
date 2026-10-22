import { describe, expect, it, vi } from 'vitest'
import { createThreadHistoryRequestState } from './threadHistoryRequestState'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue
    reject = rejectValue
  })
  return { promise, resolve, reject }
}

function createState() {
  let accountRevision = 0
  const load = vi.fn()
  const state = createThreadHistoryRequestState({ getAccountRevision: () => accountRevision })
  return { load, state, switchAccount: () => { accountRevision += 1 } }
}

describe('thread history request state', () => {
  it('reuses one request for concurrent callers on the same thread', async () => {
    const deferred = createDeferred<void>()
    const test = createState()
    test.load.mockReturnValueOnce(deferred.promise)
    const first = test.state.loadHistory('thread-1', () => test.load('thread-1'))
    const second = test.state.loadHistory('thread-1', () => test.load('thread-1'))
    expect(test.load).toHaveBeenCalledTimes(1)
    deferred.resolve()
    await Promise.all([first, second])
  })

  it('keeps requests separate by thread', async () => {
    const test = createState()
    test.load.mockResolvedValue(undefined)
    await Promise.all([
      test.state.loadHistory('thread-1', () => test.load('thread-1')),
      test.state.loadHistory('thread-2', () => test.load('thread-2')),
    ])
    expect(test.load.mock.calls.map(([threadId]) => threadId)).toEqual(['thread-1', 'thread-2'])
  })

  it('propagates the original failure to callers on the same account', async () => {
    const deferred = createDeferred<void>()
    const test = createState()
    const first = test.state.loadHistory('thread-1', () => deferred.promise)
    const second = test.state.loadHistory('thread-1', () => test.load('thread-1'))
    deferred.reject(new Error('history failed'))
    const causes = await Promise.allSettled([first, second])
    expect(causes.every(result => result.status === 'rejected' && result.reason.message === 'history failed')).toBe(true)
  })

  it('retries after the awaited request becomes stale', async () => {
    const previous = createDeferred<void>()
    const current = createDeferred<void>()
    const test = createState()
    test.load.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise)
    const oldLoad = test.state.loadHistory('thread-1', () => test.load('thread-1'))
    const joinedLoad = test.state.loadHistory('thread-1', () => test.load('thread-1'))
    test.switchAccount()
    previous.resolve()
    current.resolve()
    await Promise.all([oldLoad, joinedLoad])
    expect(test.load.mock.calls.map(([threadId]) => threadId)).toEqual(['thread-1', 'thread-1'])
  })

  it('bypasses a stale failure and retries the current account', async () => {
    const previous = createDeferred<void>()
    const current = createDeferred<void>()
    const test = createState()
    test.load.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise)
    const oldLoad = test.state.loadHistory('thread-1', () => test.load('thread-1'))
    const joinedLoad = test.state.loadHistory('thread-1', () => test.load('thread-1'))
    test.switchAccount()
    previous.reject(new Error('previous account failed'))
    current.resolve()
    await Promise.all([oldLoad.catch(() => undefined), joinedLoad])
    expect(test.load).toHaveBeenCalledTimes(2)
  })

  it('exposes thread ids for account transition bookkeeping', async () => {
    const deferred = createDeferred<void>()
    const test = createState()
    test.load.mockReturnValueOnce(deferred.promise)
    const load = test.state.loadHistory('thread-1', () => deferred.promise)
    expect(test.state.threadIds).toEqual(['thread-1'])
    deferred.resolve()
    await load
    expect(test.state.threadIds).toEqual([])
  })
})
