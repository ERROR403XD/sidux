import { describe, expect, it, vi } from 'vitest'
import { createThreadListSnapshotState } from './threadListSnapshotState'
import type { UiProjectGroup } from '../types/codex'

function thread(id: string, projectName: string) {
  return {
    id,
    projectName,
    cwd: `/${id}`,
    title: id,
    hasWorktree: false,
    createdAtIso: '2026-01-01T00:00:00.000Z',
    updatedAtIso: `2026-01-01T00:00:0${id.length % 10}.000Z`,
    preview: '',
    unread: false,
    inProgress: false,
  } as UiProjectGroup['threads'][number]
}

function group(name: string, threads: string[] = []): UiProjectGroup {
  return { projectName: name, threads: threads.map(id => thread(id, name)) }
}

describe('thread list snapshot state', () => {
  it('stores the first page and exposes its roots snapshot', () => {
    const commit = vi.fn()
    const state = createThreadListSnapshotState({ commit })
    state.commitFirstPage([group('first', ['first'])], null)
    expect(state.groups).toEqual([group('first', ['first'])])
    expect(state.rootsState).toBeNull()
    expect(commit).toHaveBeenCalledWith([group('first', ['first'])], null)
  })

  it('merges later first pages without losing existing groups', () => {
    const commit = vi.fn()
    const state = createThreadListSnapshotState({ commit })
    state.commitFirstPage([group('first', ['first'])], null)
    state.commitFirstPage([group('second', ['second'])], null)
    expect(state.groups.flatMap(item => item.threads.map(thread => thread.id))).toEqual(['second', 'first'])
  })

  it('appends a remaining page', () => {
    const commit = vi.fn()
    const state = createThreadListSnapshotState({ commit })
    state.commitFirstPage([group('first', ['first'])], null)
    state.commitRemainingPage([group('older', ['older'])], null)
    expect(state.groups.flatMap(item => item.threads.map(thread => thread.id))).toEqual(['first', 'older'])
    expect(commit).toHaveBeenCalledTimes(2)
  })

  it('removes a thread through the shared helper', () => {
    const commit = vi.fn()
    const state = createThreadListSnapshotState({ commit })
    state.commitFirstPage([group('first', ['thread-1'])], null)
    state.removeThread('thread-1')
    expect(state.groups).toEqual([])
  })

  it('resets groups, roots, and loaded marker together', () => {
    const commit = vi.fn()
    const state = createThreadListSnapshotState({ commit })
    state.commitFirstPage([group('first', ['first'])], null)
    state.reset()
    expect(state.groups).toEqual([])
    expect(state.rootsState).toBeNull()
    expect(commit).toHaveBeenLastCalledWith([], null)
    state.commitFirstPage([group('next', ['next'])], null)
    expect(state.groups).toEqual([group('next', ['next'])])
  })
})
