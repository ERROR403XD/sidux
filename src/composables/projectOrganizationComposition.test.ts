import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDesktopState } from './useDesktopState'
import type { WorkspaceRootsState } from '../api/projectGateway'
import type { UiThread } from '../types/codex'

const api = vi.hoisted(() => ({
  roots: vi.fn(), save: vi.fn(), removeVirtual: vi.fn(), list: vi.fn(),
}))
vi.mock('../api/projectGateway', () => ({
  getWorkspaceRootsState: api.roots, setWorkspaceRootsState: api.save, removeVirtualProject: api.removeVirtual,
}))
vi.mock('../api/threadReadGateway', () => ({
  getThreadGroupsPage: api.list, invalidateThreadResumeCache: vi.fn(), getBackgroundThreadListLimit: () => 100,
}))
vi.mock('../api/threadQueueGateway', () => ({
  getThreadQueueState: vi.fn().mockResolvedValue({}), getDeliveryStatuses: vi.fn().mockResolvedValue([]),
}))
vi.mock('../api/threadPreferencesGateway', () => ({
  getThreadTitleCache: vi.fn().mockResolvedValue({ titles: {} }), persistThreadTitle: vi.fn(),
}))

const virtualId = 'virtual:11111111-1111-4111-8111-111111111111'
const roots = (patch: Partial<WorkspaceRootsState> = {}): WorkspaceRootsState => ({
  order: ['/work/alpha', '/work/beta'], active: ['/work/alpha'],
  projectOrder: ['/work/alpha', '/work/beta'], labels: {}, ...patch,
})
const thread = (id: string, projectName: string): UiThread => ({
  id, title: id, projectName, cwd: `/work/${projectName}`, hasWorktree: false,
  createdAtIso: '2026-10-12T00:00:00Z', updatedAtIso: '2026-10-12T00:00:00Z',
  preview: '', unread: false, inProgress: false,
})
const states: ReturnType<typeof useDesktopState>[] = []
function setup(storage: Record<string, string> = {}) {
  const values = new Map(Object.entries(storage))
  vi.stubGlobal('window', {
    localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) },
    setTimeout: vi.fn(), clearTimeout: vi.fn(),
  })
  const state = useDesktopState()
  states.push(state)
  const refresh = () => state.refreshAll({ forceThreadRefresh: true, includeSelectedThreadMessages: false })
  return { state, values, refresh }
}
beforeEach(() => {
  vi.useFakeTimers()
  api.roots.mockReset().mockResolvedValue(roots())
  api.save.mockReset().mockResolvedValue(undefined)
  api.removeVirtual.mockReset().mockResolvedValue(undefined)
  api.list.mockReset().mockResolvedValue({
    groups: ['alpha', 'beta'].map(name => ({ projectName: name, threads: [thread(name, name)] })), nextCursor: null,
  })
})
afterEach(() => {
  states.splice(0).forEach(state => state.stopPolling())
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('project organization through the real desktop owners', () => {
  it('recovers physical labels after an unavailable first workspace snapshot', async () => {
    api.roots.mockRejectedValueOnce(new Error('temporary outage'))
    const test = setup({ 'codex-web-local.project-display-name.v1': JSON.stringify({ alpha: 'Local fallback' }) })
    await test.refresh()
    expect(test.state.projectDisplayNameById.value.alpha).toBe('Local fallback')
    api.roots.mockResolvedValue(roots({ labels: { '/work/alpha': 'Saved alpha' } }))
    await test.refresh()
    expect(test.state.projectDisplayNameById.value.alpha).toBe('Saved alpha')
    expect(test.state.projectDisplayNameById.value['/work/alpha']).toBe('Saved alpha')
    expect(api.roots).toHaveBeenCalledTimes(2)
    expect(api.save).not.toHaveBeenCalled()
  })

  it('recovers remote labels after an unavailable first workspace snapshot', async () => {
    api.roots.mockRejectedValueOnce(new Error('temporary outage'))
    const test = setup()
    await test.refresh()
    api.roots.mockResolvedValue(roots({ remoteProjects: [{ id: 'remote:alpha', hostId: 'ssh:nas', remotePath: '/remote/alpha', label: 'Remote alpha' }] }))
    await test.refresh()
    expect(test.state.projectDisplayNameById.value['remote:alpha']).toBe('Remote alpha nas')
    expect(test.state.projectGroups.value.some(group => group.projectName === 'remote:alpha')).toBe(true)
  })

  it('hydrates once after success while virtual labels continue following snapshots', async () => {
    api.roots.mockResolvedValue(roots({ labels: { '/work/alpha': 'Saved alpha' }, virtualProjects: [{ id: virtualId, label: 'First virtual', cwds: [] }] }))
    const test = setup()
    await test.refresh()
    test.state.renameProject('alpha', 'Local edit')
    api.roots.mockResolvedValue(roots({ labels: { '/work/alpha': 'Older alpha' }, virtualProjects: [{ id: virtualId, label: 'New virtual', cwds: [] }] }))
    await test.refresh()
    expect(test.state.projectDisplayNameById.value.alpha).toBe('Local edit')
    expect(test.state.projectDisplayNameById.value[virtualId]).toBe('New virtual')
  })

  it('persists the latest debounced rename and cancels a pending rename on stop', async () => {
    const test = setup()
    await test.refresh()
    api.roots.mockClear()
    test.state.renameProject('alpha', 'First')
    test.state.renameProject('alpha', ' Final ')
    await vi.advanceTimersByTimeAsync(499)
    expect(api.roots).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(api.roots).toHaveBeenCalledOnce()
    expect(api.save).toHaveBeenCalledExactlyOnceWith(roots({ labels: { '/work/alpha': 'Final' } }))
    test.state.renameProject('beta', 'Cancelled')
    test.state.stopPolling()
    await vi.advanceTimersByTimeAsync(500)
    expect(api.save).toHaveBeenCalledOnce()
  })

  it('keeps accepted global persistence across account changes', async () => {
    const test = setup()
    await test.refresh()
    let resolve!: (value: WorkspaceRootsState) => void
    api.roots.mockReturnValueOnce(new Promise(done => { resolve = done }))
    test.state.renameProject('alpha', 'Shared name')
    await vi.advanceTimersByTimeAsync(500)
    await test.state.refreshAll({ accountChanged: true, includeThreads: false, includeSelectedThreadMessages: false })
    resolve(roots())
    await vi.advanceTimersByTimeAsync(0)
    expect(api.save).toHaveBeenCalledExactlyOnceWith(roots({ labels: { '/work/alpha': 'Shared name' } }))
  })

  it('reorders and pins loaded groups with one read and one write per action', async () => {
    const test = setup()
    await test.refresh()
    api.roots.mockClear()
    test.state.reorderProject('alpha', 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(test.state.projectGroups.value.map(group => group.projectName)).toEqual(['beta', 'alpha'])
    expect(api.save).toHaveBeenLastCalledWith(roots({ order: ['/work/beta', '/work/alpha'], projectOrder: ['/work/beta', '/work/alpha'] }))
    test.state.pinProjectToTop('alpha')
    await vi.advanceTimersByTimeAsync(0)
    expect(test.state.projectGroups.value.map(group => group.projectName)).toEqual(['alpha', 'beta'])
    expect(api.roots).toHaveBeenCalledTimes(2)
    expect(api.save).toHaveBeenCalledTimes(2)
  })

  it('removes a physical project and selects the remaining conversation', async () => {
    api.roots.mockResolvedValue(roots({ labels: { '/work/alpha': 'Alpha', '/work/beta': 'Beta' } }))
    const test = setup()
    await test.refresh()
    api.roots.mockClear()
    await test.state.removeProject('alpha')
    expect(test.state.projectGroups.value.map(group => group.projectName)).toEqual(['beta'])
    expect(test.state.selectedThreadId.value).toBe('beta')
    expect(test.state.projectDisplayNameById.value.alpha).toBeUndefined()
    expect(api.roots).toHaveBeenCalledTimes(2)
    expect(api.save).toHaveBeenCalledExactlyOnceWith({ order: ['/work/beta'], active: ['/work/beta'], labels: { '/work/beta': 'Beta' }, projectOrder: ['/work/beta'] })
  })

  it('removes virtual membership through its gateway then reloads the list', async () => {
    const test = setup()
    await test.refresh()
    api.list.mockClear()
    await test.state.removeProject(virtualId)
    expect(api.removeVirtual).toHaveBeenCalledExactlyOnceWith(virtualId)
    expect(api.list).toHaveBeenCalledOnce()
    expect(api.save).not.toHaveBeenCalled()
  })
})
