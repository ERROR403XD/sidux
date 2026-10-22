import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isReadonly } from 'vue'
import { createProjectOrganizationController } from './projectOrganizationController'
import type { UiProjectGroup, UiThread } from '../types/codex'
import type { WorkspaceRootsState } from '../api/projectGateway'

const api = vi.hoisted(() => ({ roots: vi.fn(), save: vi.fn(), remove: vi.fn() }))
vi.mock('../api/projectGateway', () => ({
  getWorkspaceRootsState: api.roots, setWorkspaceRootsState: api.save, removeVirtualProject: api.remove,
}))
const thread = (id: string, name = 'alpha'): UiThread => ({
  id, title: id, projectName: name, cwd: `/work/${name}`, hasWorktree: false,
  createdAtIso: '2026-10-12T00:00:00Z', updatedAtIso: '2026-10-12T00:00:00Z',
  preview: '', unread: false, inProgress: false,
})
const groups = (...rows: UiThread[]): UiProjectGroup[] => [{ projectName: rows[0]?.projectName ?? 'alpha', threads: rows }]
const roots = (patch: Partial<WorkspaceRootsState> = {}): WorkspaceRootsState => ({
  order: ['/work/alpha'], active: ['/work/alpha'], projectOrder: ['/work/alpha'], labels: {}, ...patch,
})
const controllers: ReturnType<typeof createProjectOrganizationController>[] = []
function setup() {
  const state = { selectedId: '', progress: {} as Record<string, boolean>, unread: {} as Record<string, string> }
  const ports = {
    selection: { getThreadId: () => state.selectedId, setThreadId: vi.fn((id: string) => { state.selectedId = id }) },
    titles: { applyCachedToGroups: vi.fn((value: UiProjectGroup[]) => value) },
    status: {
      isInProgress: (id: string) => state.progress[id] === true,
      getInProgressMap: () => state.progress,
      markServerListedThreads: vi.fn(), pruneInProgress: vi.fn(), removeThread: vi.fn(),
    },
    getPendingRequestState: vi.fn<() => UiThread['pendingRequestState']>(() => null),
    getUnreadToken: (id: string) => state.unread[id],
    list: { removeThread: vi.fn(), load: vi.fn().mockResolvedValue(undefined) },
    pruneThreadState: vi.fn(),
  }
  const owner = createProjectOrganizationController(ports)
  controllers.push(owner)
  return { owner, ports, state }
}
beforeEach(() => {
  vi.useFakeTimers()
  api.roots.mockReset().mockResolvedValue(roots())
  api.save.mockReset().mockResolvedValue(undefined)
  api.remove.mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
  controllers.splice(0).forEach(owner => owner.stop())
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('complete project organization owner', () => {
  it('exposes readonly projections and preserves identity for an equivalent list', () => {
    const { owner } = setup()
    owner.applyThreadGroups(groups(thread('a')), null)
    const previous = owner.projectGroups.value
    owner.applyThreadGroups(groups(thread('a')), null)
    expect(owner.projectGroups.value).toBe(previous)
    expect(isReadonly(owner.projectGroups)).toBe(true)
    expect(isReadonly(owner.projectDisplayNameById)).toBe(true)
  })

  it('reprojects title and status without modifying the source thread or its version', () => {
    const { owner, state, ports } = setup()
    const row = thread('a')
    owner.applyThreadGroups(groups(row), null)
    const sourceRow = owner.getSourceThreads()[0]
    state.unread.a = 'completion'
    ports.titles.applyCachedToGroups.mockImplementation(value => value.map(group => ({ ...group, threads: group.threads.map(item => ({ ...item, title: 'Cached title' })) })))
    ports.getPendingRequestState.mockReturnValue('approval')
    owner.applyThreadFlags()
    expect(owner.projectGroups.value[0].threads[0]).toMatchObject({ title: 'Cached title', unread: true, pendingRequestState: 'approval' })
    expect(owner.getSourceThreads()[0]).toBe(sourceRow)
    expect(sourceRow.title).toBe('a')
    expect(owner.currentThreadVersion('a')).toBe(row.updatedAtIso)
    expect(owner.currentThreadVersion('absent')).toBe('')
    state.progress.a = true
    owner.applyThreadFlags()
    expect(owner.projectGroups.value[0].threads[0].unread).toBe(false)
    state.progress.a = false
    state.selectedId = 'a'
    owner.applyThreadFlags()
    expect(owner.projectGroups.value[0].threads[0].unread).toBe(false)
  })

  it('retains optimistic rows until listed and releases that protection afterward', () => {
    const { owner, ports } = setup()
    owner.insertOptimisticThread('new', '/work/alpha', '  First line\nsecond line')
    owner.applyThreadGroups([], null)
    expect(owner.getSourceThreads()).toHaveLength(1)
    expect(owner.getSourceThreads()[0].title).toBe('First line')
    owner.applyThreadGroups(groups(thread('new')), null)
    expect(ports.status.markServerListedThreads).toHaveBeenLastCalledWith(new Set(['new']))
    owner.applyThreadGroups([], null)
    expect(owner.getSourceThreads()).toEqual([])
  })

  it('retains running local rows even after optimistic protection has ended', () => {
    const { owner, state } = setup()
    owner.applyThreadGroups(groups(thread('running')), null)
    state.progress.running = true
    owner.applyThreadGroups([], null)
    expect(owner.getSourceThreads().map(row => row.id)).toEqual(['running'])
    state.progress.running = false
    owner.applyThreadGroups([], null)
    expect(owner.getSourceThreads()).toEqual([])
  })

  it('bounds unlisted optimistic retention to the latest 256 conversations', () => {
    const { owner } = setup()
    for (let index = 0; index < 257; index += 1) owner.insertOptimisticThread(String(index), '/work/alpha', '')
    owner.applyThreadGroups([], null)
    expect(owner.getSourceThreads()).toHaveLength(256)
    expect(owner.getSourceThreads().some(row => row.id === '0')).toBe(false)
    expect(owner.getSourceThreads().some(row => row.id === '256')).toBe(true)
  })

  it('removes an archived optimistic row from both snapshots and status before reprojecting', () => {
    const { owner, ports } = setup()
    owner.insertOptimisticThread('archived', '/work/alpha', 'Draft')
    owner.removeArchivedThreadFromLoadedLists('archived')
    expect(ports.list.removeThread).toHaveBeenCalledExactlyOnceWith('archived')
    expect(ports.status.removeThread).toHaveBeenCalledExactlyOnceWith('archived')
    owner.applyThreadGroups([], null)
    expect(owner.getSourceThreads()).toEqual([])
  })

  it('keeps virtual project membership display-only for optimistic conversations', () => {
    const { owner } = setup()
    const id = 'virtual:11111111-1111-4111-8111-111111111111'
    owner.insertOptimisticThread('a', '/home/user/Documents/Codex/2026-10-12/chat', 'Prompt', id)
    expect(owner.getSourceThreads()[0]).toMatchObject({ id: 'a', cwd: '/home/user/Documents/Codex/2026-10-12/chat', projectName: id })
    owner.insertOptimisticThread('b', '/work/alpha', 'Prompt', id)
    expect(owner.getSourceThreads().find(row => row.id === 'b')?.projectName).toBe('alpha')
  })

  it('hydrates duplicate physical paths and remote labels after null without writing global state', async () => {
    const { owner } = setup()
    await owner.hydrateWorkspaceRootsStateIfNeeded([], null)
    await owner.hydrateWorkspaceRootsStateIfNeeded([], roots({
      order: ['/work/alpha', '/other/alpha'], labels: { '/work/alpha': 'First', '/other/alpha': 'Second' },
      remoteProjects: [{ id: 'remote:alpha', hostId: 'ssh:nas', label: 'Remote', remotePath: '/work/alpha' }],
    }))
    expect(owner.projectDisplayNameById.value).toMatchObject({ '/work/alpha': 'First', '/other/alpha': 'Second', 'remote:alpha': 'Remote nas' })
    expect(api.roots).not.toHaveBeenCalled()
    expect(api.save).not.toHaveBeenCalled()
  })

  it('falls back to local removal when global reads fail', async () => {
    const { owner, state, ports } = setup()
    owner.applyThreadGroups(groups(thread('a'), thread('b')), null)
    state.selectedId = 'a'
    api.roots.mockRejectedValue(new Error('offline'))
    await owner.removeProject('alpha')
    expect(owner.projectGroups.value).toEqual([])
    expect(ports.selection.setThreadId).toHaveBeenLastCalledWith('')
    expect(ports.pruneThreadState).toHaveBeenLastCalledWith([])
    expect(api.save).not.toHaveBeenCalled()
  })

  it('does not drop local virtual rows when membership deletion fails', async () => {
    const { owner, ports } = setup()
    const id = 'virtual:11111111-1111-4111-8111-111111111111'
    owner.applyThreadGroups([], roots({ virtualProjects: [{ id, label: 'Virtual', cwds: [] }] }))
    const previous = owner.projectGroups.value
    api.remove.mockRejectedValue(new Error('offline'))
    await expect(owner.removeProject(id)).rejects.toThrow('offline')
    expect(owner.projectGroups.value).toBe(previous)
    expect(ports.list.load).not.toHaveBeenCalled()
  })

  it('falls back to order persistence when direct root removal fails', async () => {
    const { owner } = setup()
    owner.applyThreadGroups(groups(thread('a')), null)
    api.save.mockRejectedValueOnce(new Error('temporary failure'))
    await owner.removeProject('alpha')
    expect(api.roots).toHaveBeenCalledTimes(3)
    expect(api.save).toHaveBeenCalledTimes(2)
  })

  it('keeps accepted global rename persistence after stop while cancelling new debounce work', async () => {
    const { owner } = setup()
    let resolve!: (state: WorkspaceRootsState) => void
    api.roots.mockReturnValueOnce(new Promise(done => { resolve = done }))
    owner.renameProject('alpha', 'Accepted')
    await vi.advanceTimersByTimeAsync(500)
    owner.renameProject('alpha', 'Cancelled')
    owner.stop()
    resolve(roots())
    await vi.advanceTimersByTimeAsync(500)
    expect(api.roots).toHaveBeenCalledOnce()
    expect(api.save).toHaveBeenCalledExactlyOnceWith(roots({ labels: { '/work/alpha': 'Accepted' } }))
    expect(vi.getTimerCount()).toBe(0)
  })
})
