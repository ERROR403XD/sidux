import { describe, expect, it, vi } from 'vitest'
import type { RpcNotification } from '../api/codexRpcClient'
import { createThreadHistoryState } from './threadHistoryState'
import { createThreadSynchronizationController } from './threadSynchronizationController'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(resolveValue => { resolve = resolveValue })
  return { promise, resolve }
}

function notification(method: string, threadId = 'selected'): RpcNotification {
  return { method, params: { threadId }, atIso: '2026-10-11T00:00:00Z' }
}

function setup() {
  let accountRevision = 0
  const revisions = createThreadHistoryState()
  const timers: Array<() => void> = []
  const loadList = vi.fn(async () => {})
  const loadHistory = vi.fn(async () => {})
  const loadPending = vi.fn(async () => {})
  const controller = createThreadSynchronizationController({
    getAccountRevision: () => accountRevision,
    getSelectedThreadId: () => 'selected',
    isInProgress: () => false,
    list: { hasLoaded: () => true, getVersion: () => 'current', load: loadList },
    history: {
      getPendingThreadIds: () => revisions.pendingThreadIds,
      takePendingThreadIds: revisions.takePendingThreadIds,
      markDirty: revisions.markDirty,
      isLoaded: () => true,
      getLoadedVersion: () => 'current',
      load: loadHistory,
    },
    loadPendingServerRequests: loadPending,
    extractThreadId: value => (value.params as { threadId: string }).threadId,
    delayMs: 220,
    scheduleTimeout: callback => {
      timers.push(callback)
      return timers.length
    },
    cancelTimeout: vi.fn(),
  })
  return {
    controller, revisions, timers, loadList, loadHistory, loadPending,
    switchAccount: () => {
      accountRevision++
      controller.invalidateForAccountChange()
    },
  }
}

describe('complete notification synchronization owner', () => {
  it('merges a burst into one list/history sync and retains events that arrive while waiting', async () => {
    const test = setup()
    const pending = deferred()
    test.loadList.mockReturnValueOnce(pending.promise)
    test.controller.queue(notification('turn/completed'))
    test.controller.queue(notification('turn/completed'))
    expect(test.timers).toHaveLength(1)
    test.timers[0]()
    await vi.waitFor(() => expect(test.loadList).toHaveBeenCalledTimes(1))
    test.controller.queue(notification('turn/started'))
    expect(test.timers).toHaveLength(1)
    pending.resolve()
    await vi.waitFor(() => expect(test.loadHistory).toHaveBeenCalledTimes(1))
    expect(test.loadList).toHaveBeenCalledExactlyOnceWith({ force: true })
    await vi.waitFor(() => expect(test.timers).toHaveLength(2))
    test.timers[1]()
    await vi.waitFor(() => expect(test.loadHistory).toHaveBeenCalledTimes(2))
    expect(test.loadList).toHaveBeenCalledTimes(1)
  })

  it.each(['stop', 'account'])('rejects late list work when the owner receives %s', async transition => {
    const test = setup()
    const pending = deferred()
    test.loadList.mockReturnValueOnce(pending.promise)
    test.controller.markThreadsDirty()
    const old = test.controller.syncFromNotifications()
    if (transition === 'stop') test.controller.stop()
    else test.switchAccount()
    pending.resolve()
    await old
    expect(test.loadHistory).not.toHaveBeenCalled()
    expect(test.timers).toHaveLength(0)
  })

  it('does not let late bridge recovery requeue history after stop', async () => {
    const test = setup()
    const pending = deferred()
    test.loadPending.mockReturnValueOnce(pending.promise)
    const old = test.controller.recoverBridgeState(true)
    test.controller.stop()
    pending.resolve()
    await old
    expect(test.revisions.pendingThreadIds).toEqual([])
    expect(test.loadList).not.toHaveBeenCalled()
    expect(test.loadHistory).not.toHaveBeenCalled()
  })

  it('keeps the new sync busy when a stopped request completes after restart', async () => {
    const test = setup()
    const oldList = deferred()
    const currentList = deferred()
    test.loadList.mockReturnValueOnce(oldList.promise).mockReturnValueOnce(currentList.promise)
    test.controller.markThreadsDirty()
    const old = test.controller.syncFromNotifications()
    test.controller.stop()
    test.controller.start()
    test.controller.markThreadsDirty()
    const current = test.controller.syncFromNotifications()
    oldList.resolve()
    await old
    test.controller.queue(notification('turn/completed'))
    expect(test.timers).toHaveLength(0)
    expect(test.loadHistory).not.toHaveBeenCalled()
    currentList.resolve()
    await current
    expect(test.timers).toHaveLength(1)
  })

  it('keeps background-thread dirtiness from fetching selected history or unrelated metadata', async () => {
    const test = setup()
    test.controller.queue(notification('turn/started', 'background'))
    await test.controller.syncFromNotifications()
    expect(test.loadList).not.toHaveBeenCalled()
    expect(test.loadHistory).not.toHaveBeenCalled()
    expect(test.loadPending).not.toHaveBeenCalled()
  })
})
