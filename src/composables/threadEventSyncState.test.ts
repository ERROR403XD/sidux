import { describe, expect, it, vi } from 'vitest'
import { createThreadEventSyncState } from './threadEventSyncState'
import type { RpcNotification } from '../api/codexRpcClient'

function notification(method: string, params: Record<string, unknown> = {}): RpcNotification {
  return { method, params, atIso: '2026-01-01T00:00:00.000Z' }
}

function createState() {
  const run = vi.fn()
  let pendingThreadIds: string[] = []
  const timeouts: Array<{ callback: () => void; delay: number; id: number }> = []
  let nextId = 1
  const state = createThreadEventSyncState({
    delayMs: 20,
    hasPendingMessageThreadIds: () => pendingThreadIds.length > 0,
    takePendingMessageThreadIds: () => {
      const threadIds = pendingThreadIds
      pendingThreadIds = []
      return threadIds
    },
    isBusy: () => false,
    run,
    scheduleTimeout: (callback, delay) => {
      const entry = { callback, delay, id: nextId++ }
      timeouts.push(entry)
      return entry.id
    },
    cancelTimeout: id => {
      const index = timeouts.findIndex(entry => entry.id === id)
      if (index >= 0) timeouts.splice(index, 1)
    },
  })
  return { markMessageDirty: (threadId: string | null) => {
    if (threadId) pendingThreadIds.push(threadId)
  }, run, state, timeouts }
}

describe('thread event sync state', () => {
  it('does not schedule new work after stop', () => {
    const test = createState()
    test.state.stop()
    test.state.schedule()
    expect(test.timeouts).toHaveLength(0)
  })

  it('rejects a cancelled timer callback that was already retained by the scheduler', () => {
    const test = createState()
    test.state.schedule()
    const callback = test.timeouts[0].callback
    test.state.stop()
    callback()
    expect(test.run).not.toHaveBeenCalled()
    expect(test.timeouts).toHaveLength(0)
  })

  it('keeps a new timer registered when an old callback arrives after restart', () => {
    const test = createState()
    test.state.schedule()
    const old = test.timeouts[0].callback
    test.state.stop()
    test.state.start()
    test.state.schedule()
    old()
    test.state.schedule()
    expect(test.timeouts).toHaveLength(1)
    expect(test.run).not.toHaveBeenCalled()
    test.timeouts[0].callback()
    expect(test.run).toHaveBeenCalledTimes(1)
  })

  it('marks messages dirty from realtime lifecycle notifications', () => {
    const test = createState()
    const markDirty = vi.fn()
    test.state.queue(notification('turn/completed', { threadId: 'thread-1' }), markDirty, () => 'thread-1')
    expect(markDirty).toHaveBeenCalledWith('thread-1')
    expect(test.state.hasPendingWork).toBe(true)
  })

  it('ignores usage and goal notifications', () => {
    const test = createState()
    const markDirty = vi.fn()
    test.state.queue(notification('thread/tokenUsage/updated', { threadId: 'thread-1' }), markDirty, () => 'thread-1')
    test.state.queue(notification('thread/goal/updated', { threadId: 'thread-1' }), markDirty, () => 'thread-1')
    expect(markDirty).not.toHaveBeenCalled()
    expect(test.state.hasPendingWork).toBe(false)
  })

  it('schedules one debounce per burst', () => {
    const test = createState()
    test.state.queue(notification('turn/started', { threadId: 'thread-1' }), test.markMessageDirty, () => 'thread-1')
    test.state.queue(notification('turn/completed', { threadId: 'thread-2' }), test.markMessageDirty, () => 'thread-2')
    expect(test.timeouts).toHaveLength(1)
    expect(test.timeouts[0].delay).toBe(20)
  })

  it('takes thread and list refresh requests atomically', () => {
    const test = createState()
    test.state.queue(notification('turn/completed', { threadId: 'thread-1' }), test.markMessageDirty, () => 'thread-1')
    const request = test.state.take()
    expect(request).toEqual({ threadIds: ['thread-1'], refreshThreads: true, forceThreads: true })
    expect(test.state.take()).toEqual({ threadIds: [], refreshThreads: false, forceThreads: false })
  })

  it('marks reconnect and unloaded states without immediate execution', () => {
    const test = createState()
    test.state.markBridgeRecovery(true, true)
    expect(test.state.hasPendingWork).toBe(true)
    expect(test.run).not.toHaveBeenCalled()
    const request = test.state.take()
    expect(request.refreshThreads).toBe(true)
    expect(request.forceThreads).toBe(true)
  })

  it('schedules follow-up work directly', () => {
    const test = createState()
    test.state.schedule()
    expect(test.timeouts).toHaveLength(1)
  })

  it('does not schedule duplicate work while busy', () => {
    const run = vi.fn()
    const state = createThreadEventSyncState({
      delayMs: 20,
      hasPendingMessageThreadIds: () => false,
      takePendingMessageThreadIds: () => [],
      isBusy: () => true,
      run,
      scheduleTimeout: vi.fn((callback: () => void, delay: number) => {
        queueMicrotask(() => callback())
        return 1
      }),
      cancelTimeout: vi.fn(),
    })
    state.queue(notification('turn/completed', { threadId: 'thread-1' }), vi.fn(), () => 'thread-1')
    expect(run).not.toHaveBeenCalled()
  })

  it('stops and cancels a scheduled timer', () => {
    const test = createState()
    test.state.queue(notification('turn/completed', { threadId: 'thread-1' }), test.markMessageDirty, () => 'thread-1')
    test.state.stop()
    expect(test.timeouts).toHaveLength(0)
    test.state.take()
    expect(test.state.hasPendingWork).toBe(false)
  })

  it('clears pending work without timer side effects', () => {
    const test = createState()
    test.state.queue(notification('turn/completed', { threadId: 'thread-1' }), test.markMessageDirty, () => 'thread-1')
    test.state.clearPending()
    test.state.take()
    expect(test.state.hasPendingWork).toBe(false)
  })
})
