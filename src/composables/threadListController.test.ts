import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThreadGroupsPage } from '../api/threadReadGateway'
import type { UiProjectGroup, UiThread } from '../types/codex'
import { createThreadListController } from './threadListController'

const api = vi.hoisted(() => ({ getThreadGroupsPage: vi.fn(), getWorkspaceRootsState: vi.fn() }))
vi.mock('../api/threadReadGateway', () => ({ ...api, getBackgroundThreadListLimit: () => 100 }))
vi.mock('../api/projectGateway', () => api)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolveValue => { resolve = resolveValue })
  return { promise, resolve }
}

function page(id: string, nextCursor: string | null = null): ThreadGroupsPage {
  const thread: UiThread = {
    id, title: id, projectName: 'project', cwd: '/fixture', hasWorktree: false, preview: '', unread: false, inProgress: false,
    createdAtIso: '2026-10-11T00:00:00Z', updatedAtIso: '2026-10-11T00:00:00Z',
  }
  return { groups: [{ projectName: 'project', threads: [thread] }], nextCursor }
}

function setup() {
  let accountRevision = 0
  let selectedThreadId = ''
  let visibleGroups: UiProjectGroup[] = []
  const timers: Array<() => void> = []
  const loadTitleCache = vi.fn(async () => {})
  const hydrateWorkspace = vi.fn(async () => {})
  const commitGroups = vi.fn((groups: UiProjectGroup[]) => { visibleGroups = groups })
  const applyListedStatuses = vi.fn()
  const pruneThreadState = vi.fn()
  const cancelTimeout = vi.fn()
  const controller = createThreadListController({
    getAccountRevision: () => accountRevision,
    getStatusRevisions: () => new Map([['thread', accountRevision]]),
    applyListedStatuses,
    loadTitleCache,
    hydrateWorkspace,
    view: {
      commitGroups,
      getVisibleThreads: () => visibleGroups.flatMap(group => group.threads),
      pruneThreadState,
      getSelectedThreadId: () => selectedThreadId,
      setSelectedThreadId: id => { selectedThreadId = id },
    },
    reuseMs: 2000,
    paginationDelayMs: 10000,
    scheduleTimeout: callback => {
      timers.push(callback)
      return timers.length
    },
    cancelTimeout,
  })
  return {
    controller, timers, loadTitleCache, hydrateWorkspace, commitGroups, applyListedStatuses, pruneThreadState, cancelTimeout,
    getSelectedThreadId: () => selectedThreadId,
    select: (id: string) => { selectedThreadId = id },
    switchAccount: () => {
      accountRevision++
      controller.resetForAccountChange()
    },
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('window', {})
  api.getWorkspaceRootsState.mockResolvedValue(null)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('complete thread list owner', () => {
  it('coalesces first-page reads and reuses the warm snapshot without repeating metadata reads', async () => {
    const test = setup()
    const pending = deferred<ThreadGroupsPage>()
    api.getThreadGroupsPage.mockReturnValue(pending.promise)
    const first = test.controller.loadThreads()
    const joined = test.controller.loadThreads()
    pending.resolve(page('thread'))
    await Promise.all([first, joined])
    await test.controller.loadThreads()
    expect(api.getThreadGroupsPage).toHaveBeenCalledTimes(1)
    expect(api.getWorkspaceRootsState).toHaveBeenCalledTimes(1)
    expect(test.loadTitleCache).toHaveBeenCalledTimes(1)
    expect(test.commitGroups).toHaveBeenCalledTimes(1)
    expect(test.getSelectedThreadId()).toBe('thread')
  })

  it.each(['stop', 'account'])('checks context again after workspace hydration across %s', async transition => {
    const test = setup()
    const hydration = deferred<void>()
    api.getThreadGroupsPage.mockResolvedValue(page('old'))
    test.hydrateWorkspace.mockReturnValueOnce(hydration.promise)
    const old = test.controller.loadThreads()
    await vi.waitFor(() => expect(test.hydrateWorkspace).toHaveBeenCalledTimes(1))
    if (transition === 'stop') test.controller.stop()
    else test.switchAccount()
    api.getThreadGroupsPage.mockResolvedValue(page('current'))
    await test.controller.loadThreads({ force: true })
    const commits = test.commitGroups.mock.calls.length
    hydration.resolve()
    await old
    expect(test.commitGroups).toHaveBeenCalledTimes(commits)
    expect(test.pruneThreadState).toHaveBeenCalledTimes(1)
    expect(test.getSelectedThreadId()).toBe('current')
    expect(test.controller.isLoadingThreads.value).toBe(false)
  })

  it('preserves the original background cursor when a first-page refresh overlaps pagination', async () => {
    const test = setup()
    api.getThreadGroupsPage.mockResolvedValueOnce(page('first', 'page-two'))
    await test.controller.loadThreads()
    const pending = deferred<ThreadGroupsPage>()
    api.getThreadGroupsPage.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(page('first', 'new-first-cursor'))
    test.timers[0]()
    await vi.waitFor(() => expect(api.getThreadGroupsPage).toHaveBeenCalledTimes(2))
    await test.controller.loadThreads({ force: true })
    pending.resolve(page('second', 'page-three'))
    await vi.waitFor(() => expect(test.commitGroups.mock.calls.at(-1)?.[0].flatMap(group => group.threads).map(row => row.id)).toEqual(['first', 'second']))
    api.getThreadGroupsPage.mockResolvedValueOnce(page('third'))
    test.timers.at(-1)!()
    await vi.waitFor(() => expect(test.controller.isThreadListFullyLoaded.value).toBe(true))
    expect(api.getThreadGroupsPage.mock.calls.filter(call => call.length).map(call => call.slice(0, 2))).toEqual([['page-two', 100], ['page-three', 100]])
    expect(api.getWorkspaceRootsState).toHaveBeenCalledTimes(2)
  })

  it('keeps a selected deep-link conversation while optional workspace metadata fails', async () => {
    const test = setup()
    test.select('deep-link')
    api.getWorkspaceRootsState.mockRejectedValue(new Error('optional root state unavailable'))
    api.getThreadGroupsPage.mockResolvedValue(page('thread'))
    await test.controller.loadThreads()
    expect(test.controller.rootsState).toBeNull()
    expect(test.controller.hasLoadedThreads.value).toBe(true)
    expect(test.getSelectedThreadId()).toBe('deep-link')
  })

  it('keeps the page deadline and current project metadata after a first-page refresh', async () => {
    const test = setup()
    const roots = { order: ['/fixture'], active: ['/fixture'], projectOrder: ['/fixture'], labels: { '/fixture': 'Original name' } }
    const renamedRoots = { ...roots, labels: { '/fixture': 'Renamed project' } }
    api.getWorkspaceRootsState.mockResolvedValueOnce(roots).mockResolvedValueOnce(renamedRoots)
    api.getThreadGroupsPage.mockResolvedValueOnce(page('first', 'page-two'))
    await test.controller.loadThreads()
    api.getThreadGroupsPage.mockResolvedValueOnce(page('first', 'refreshed-cursor'))
    await test.controller.loadThreads({ force: true })
    expect(test.timers).toHaveLength(1)
    api.getThreadGroupsPage.mockResolvedValueOnce(page('older'))
    test.timers[0]!()
    await vi.waitFor(() => expect(test.controller.isThreadListFullyLoaded.value).toBe(true))
    expect(api.getThreadGroupsPage).toHaveBeenLastCalledWith('page-two', 100)
    expect(test.commitGroups).toHaveBeenLastCalledWith(expect.any(Array), renamedRoots)
  })

  it('cancels ten background timers and rejects their old callbacks after restart', async () => {
    const test = setup()
    for (let index = 0; index < 10; index++) {
      test.controller.start()
      api.getThreadGroupsPage.mockResolvedValueOnce(page('thread', 'pending-page'))
      await test.controller.loadThreads({ force: true })
      const timer = test.timers.at(-1)!
      test.controller.stop()
      test.controller.start()
      timer()
    }
    expect(api.getThreadGroupsPage).toHaveBeenCalledTimes(10)
    expect(test.cancelTimeout).toHaveBeenCalledTimes(10)
    expect(test.timers).toHaveLength(10)
  })
})
