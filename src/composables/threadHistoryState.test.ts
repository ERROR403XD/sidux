import { describe, expect, it, vi } from 'vitest'
import { createThreadHistoryState } from './threadHistoryState'

describe('thread history state', () => {
  it('marks a thread dirty and queues a refresh', () => {
    const state = createThreadHistoryState()
    state.markDirty('thread-1')
    expect(state.getRevision('thread-1')).toBe(1)
    expect(state.pendingThreadIds).toEqual(['thread-1'])
  })

  it('increments revisions independently by thread', () => {
    const state = createThreadHistoryState()
    state.markDirty('thread-1')
    state.markDirty('thread-2')
    state.markDirty('thread-1')
    expect(state.getRevision('thread-1')).toBe(2)
    expect(state.getRevision('thread-2')).toBe(1)
  })

  it('records loaded revisions without queueing refreshes', () => {
    const state = createThreadHistoryState()
    const revision = state.getRevision('thread-1')
    state.setLoadedRevision('thread-1', revision)
    expect(state.getRevision('thread-1')).toBe(0)
    expect(state.getLoadedRevision('thread-1')).toBe(0)
    expect(state.pendingThreadIds).toEqual([])
  })

  it('keeps a pending refresh until it is taken', () => {
    const state = createThreadHistoryState()
    state.setLoadedRevision('thread-1', state.getRevision('thread-1'))
    expect(state.getLoadedRevision('thread-1')).toBe(0)
    expect(state.pendingThreadIds).toEqual([])
  })

  it('takes pending refresh ids atomically', () => {
    const state = createThreadHistoryState()
    state.markDirty('thread-1')
    state.markDirty('thread-2')
    expect(state.takePendingThreadIds()).toEqual(['thread-1', 'thread-2'])
    expect(state.pendingThreadIds).toEqual([])
    expect(state.takePendingThreadIds()).toEqual([])
  })

  it('requeues stale snapshots explicitly', () => {
    const state = createThreadHistoryState()
    state.markDirty('thread-1')
    const pending = state.takePendingThreadIds()
    state.queueRefresh('thread-1')
    expect(pending).toEqual(['thread-1'])
    expect(state.pendingThreadIds).toEqual(['thread-1'])
  })

  it('keeps dirty threads pending across repeated notifications', () => {
    const state = createThreadHistoryState()
    state.markDirty('thread-1')
    state.markDirty('thread-1')
    expect(state.pendingThreadIds).toEqual(['thread-1'])
  })

  it('prunes absent threads and invalidates selected ids', () => {
    const state = createThreadHistoryState()
    state.markDirty('thread-1')
    state.markDirty('thread-2')
    state.setLoadedRevision('thread-1', 1)
    state.setLoadedRevision('thread-2', 2)
    state.prune(new Set(['thread-2']))
    state.invalidateForAccountChange(['thread-2', 'selected'])
    expect(state.getRevision('thread-1')).toBe(0)
    expect(state.getLoadedRevision('thread-1')).toBe(0)
    expect(state.getLoadedRevision('thread-2')).toBe(-1)
    expect(state.getLoadedRevision('selected')).toBe(-1)
    expect(state.pendingThreadIds).toEqual([])
  })

  it('clears pending refreshes on stop', () => {
    const state = createThreadHistoryState()
    const schedule = vi.fn()
    state.markDirty('thread-1')
    state.clearPendingRefreshes()
    expect(schedule).not.toHaveBeenCalled()
    expect(state.pendingThreadIds).toEqual([])
  })
})
