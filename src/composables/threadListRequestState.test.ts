import { describe, expect, it, vi } from 'vitest'
import { createThreadListRequestState } from './threadListRequestState'

type Page = { name: string }

function createDeferred() {
  let resolve!: (value: Page) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<Page>((resolveValue, rejectValue) => {
    resolve = resolveValue
    reject = rejectValue
  })
  return { promise, resolve, reject }
}

function createState() {
  let accountRevision = 0
  const loadingValues: boolean[] = []
  const load = vi.fn()
  const apply = vi.fn()
  const state = createThreadListRequestState<Page>({
    getAccountRevision: () => accountRevision,
    getHasLoaded: () => false,
    setLoading: loading => loadingValues.push(loading),
    beginRequest: force => ({ accountRevision, statusRevisions: new Map(), force }),
    load,
    apply,
  })
  return {
    apply,
    load,
    loadingValues,
    state,
    switchAccount: () => { accountRevision += 1 },
  }
}

describe('thread list request state', () => {
  it.each(['success', 'failure'])('does not retry a stopped joined request across an account change after %s', async outcome => {
    const previous = createDeferred()
    const current = createDeferred()
    const test = createState()
    test.load.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise)
    const old = test.state.loadList()
    const joined = test.state.loadList()
    test.state.stop()
    test.switchAccount()
    const next = test.state.loadList()
    if (outcome === 'success') previous.resolve({ name: 'old' })
    else previous.reject(new Error('stopped failure'))
    await Promise.all([old, joined])
    expect(test.apply).not.toHaveBeenCalled()
    expect(test.load).toHaveBeenCalledTimes(2)
    expect(test.loadingValues.at(-1)).toBe(true)
    current.resolve({ name: 'current' })
    await next
    expect(test.apply).toHaveBeenCalledExactlyOnceWith({ name: 'current' }, expect.objectContaining({ accountRevision: 1 }))
  })

  it('reuses one request for concurrent callers and propagates its result context', async () => {
    const deferred = createDeferred()
    const test = createState()
    test.load.mockReturnValueOnce(deferred.promise)
    const first = test.state.loadList()
    const second = test.state.loadList()
    expect(test.load).toHaveBeenCalledTimes(1)
    deferred.resolve({ name: 'first' })
    await Promise.all([first, second])
    expect(test.apply).toHaveBeenCalledWith({ name: 'first' }, {
      accountRevision: 0,
      statusRevisions: new Map(),
      force: false,
    })
    expect(test.loadingValues).toEqual([true, false])
  })

  it('does not let a stale request block or overwrite the current account', async () => {
    const previous = createDeferred()
    const current = createDeferred()
    const test = createState()
    test.load.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise)
    const oldLoad = test.state.loadList()
    test.switchAccount()
    const currentLoad = test.state.loadList()
    expect(test.load).toHaveBeenCalledTimes(2)
    expect(test.loadingValues.at(-1)).toBe(true)
    previous.resolve({ name: 'previous' })
    current.resolve({ name: 'current' })
    await Promise.all([oldLoad, currentLoad])
    expect(test.apply.mock.calls.map(([page]) => page)).toEqual([{ name: 'current' }])
    expect(test.apply.mock.calls[0][1].accountRevision).toBe(1)
    expect(test.loadingValues).toEqual([true, true, false])
  })

  it('retries after an existing request becomes stale while being joined', async () => {
    const previous = createDeferred()
    const current = createDeferred()
    const test = createState()
    test.load.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise)
    const oldLoad = test.state.loadList()
    const joinedLoad = test.state.loadList()
    test.switchAccount()
    previous.resolve({ name: 'previous' })
    current.resolve({ name: 'current' })
    await Promise.all([oldLoad, joinedLoad])
    expect(test.apply).toHaveBeenCalledTimes(1)
    expect(test.apply).toHaveBeenCalledWith({ name: 'current' }, expect.objectContaining({ accountRevision: 1 }))
  })

  it('suppresses a stale failure for a caller that retries on the current account', async () => {
    const previous = createDeferred()
    const current = createDeferred()
    const test = createState()
    test.load.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise)
    const oldLoad = test.state.loadList()
    const joinedLoad = test.state.loadList()
    test.switchAccount()
    previous.reject(new Error('previous failed'))
    current.resolve({ name: 'current' })
    await Promise.all([oldLoad.catch(() => undefined), joinedLoad])
    expect(test.apply).toHaveBeenCalledWith({ name: 'current' }, expect.objectContaining({ accountRevision: 1 }))
    expect(test.loadingValues.at(-1)).toBe(false)
  })

  it('propagates the original failure to a caller on the same account', async () => {
    const deferred = createDeferred()
    const test = createState()
    test.load.mockReturnValueOnce(deferred.promise)
    const first = test.state.loadList()
    const second = test.state.loadList()
    deferred.reject(new Error('network failed'))
    const causes = await Promise.allSettled([first, second])
    expect(causes.every(result => result.status === 'rejected' && result.reason.message === 'network failed')).toBe(true)
    expect(test.loadingValues.at(-1)).toBe(false)
  })
})
