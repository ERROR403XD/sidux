import { normalizeModelCapability } from '../modelCapabilities'
import { applyThreadQueueOperation, type ThreadQueueState } from '../threadQueue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useDesktopState,
} from './useDesktopState'
import {
  buildWorkspaceRootsProjectOrderState,
  collectWorkspaceRootPathsForProjectRemoval,
  filterGroupsByWorkspaceRoots,
  findAdjacentThreadId,
  flattenThreads,
  removeThreadFromGroups,
} from '../projectOrganization'
import type { UiProjectGroup } from '../types/codex'
import type { WorkspaceRootsState } from '../api/projectGateway'

const gatewayMocks = vi.hoisted(() => ({
  archiveThread: vi.fn(),
  forkThread: vi.fn(),
  forkThreadAtTurn: vi.fn(),
  getThreadTurnMessages: vi.fn(),
  getOlderThreadMessages: vi.fn(),
  getAccountRateLimits: vi.fn(),
  getAvailableCollaborationModes: vi.fn(),
  getAvailableModelIds: vi.fn(),
  getCurrentModelConfig: vi.fn(),
  getPendingServerRequests: vi.fn(),
  getSkillsList: vi.fn(),
  getThreadDetail: vi.fn(),
  getThreadGroupsPage: vi.fn(),
  getThreadQueueState: vi.fn(),
  getDeliveryStatuses: vi.fn(),
  getThreadTitleCache: vi.fn(),
  getWorkspaceRootsState: vi.fn(),
  generateThreadTitle: vi.fn(),
  interruptThreadTurn: vi.fn(),
  persistThreadTitle: vi.fn(),
  renameThread: vi.fn(),
  replyToServerRequest: vi.fn(),
  resumeThread: vi.fn(),
  revertThreadFileChanges: vi.fn(),
  rollbackThread: vi.fn(),
  setCodexSpeedMode: vi.fn(),
  mutateThreadQueueState: vi.fn(),
  setWorkspaceRootsState: vi.fn(),
  startThread: vi.fn(),
  startThreadTurn: vi.fn(),
  subscribeCodexNotifications: vi.fn(),
}))

vi.mock('../api/modelCatalog', () => ({
  invalidateModelCatalog: vi.fn(),
}))

vi.mock('../api/accountGateway', () => ({
  getAccountRateLimits: gatewayMocks.getAccountRateLimits,
  pickCodexRateLimitSnapshot: vi.fn(() => null),
}))

vi.mock('../api/executionSettingsGateway', () => ({
  getAvailableCollaborationModes: gatewayMocks.getAvailableCollaborationModes,
}))

vi.mock('../api/runtimeGateway', () => ({
  getPendingServerRequests: gatewayMocks.getPendingServerRequests,
  replyToServerRequest: gatewayMocks.replyToServerRequest,
}))

vi.mock('../api/codexRpcClient', async importOriginal => ({
  ...await importOriginal<typeof import('../api/codexRpcClient')>(),
  subscribeRpcNotifications: gatewayMocks.subscribeCodexNotifications,
}))

vi.mock('../api/skillsGateway', () => ({
  getSkillsList: gatewayMocks.getSkillsList,
}))

vi.mock('../api/threadQueueGateway', () => ({
  getThreadQueueState: gatewayMocks.getThreadQueueState,
  getDeliveryStatuses: gatewayMocks.getDeliveryStatuses,
  mutateThreadQueueState: gatewayMocks.mutateThreadQueueState,
}))

vi.mock('../api/projectGateway', () => ({
  ...gatewayMocks,
}))

vi.mock('../api/threadCommandGateway', () => ({
  archiveThread: gatewayMocks.archiveThread,
  forkThread: gatewayMocks.forkThread,
  forkThreadAtTurn: gatewayMocks.forkThreadAtTurn,
  renameThread: gatewayMocks.renameThread,
  revertThreadFileChanges: gatewayMocks.revertThreadFileChanges,
  updateThreadFileChanges: vi.fn(),
  startThread: gatewayMocks.startThread,
  getAvailableModels: async (options: unknown) => (await gatewayMocks.getAvailableModelIds(options) || []).map((id: string) => normalizeModelCapability(id)! ),
  getCurrentModelConfig: gatewayMocks.getCurrentModelConfig,
  interruptThreadTurn: gatewayMocks.interruptThreadTurn,
  startThreadTurn: gatewayMocks.startThreadTurn,
}))

vi.mock('../api/threadReadGateway', () => ({
  getBackgroundThreadListLimit: vi.fn(() => 100),
  getThreadTurnMessages: gatewayMocks.getThreadTurnMessages,
  getOlderThreadMessages: gatewayMocks.getOlderThreadMessages,
  getThreadDetail: gatewayMocks.getThreadDetail,
  getThreadGroupsPage: gatewayMocks.getThreadGroupsPage,
  invalidateThreadResumeCache: vi.fn(),
  rollbackThread: gatewayMocks.rollbackThread,
  resumeThread: gatewayMocks.resumeThread,
}))

vi.mock('../api/threadPreferencesGateway', () => ({
  generateThreadTitle: gatewayMocks.generateThreadTitle,
  getThreadTitleCache: gatewayMocks.getThreadTitleCache,
  persistThreadTitle: gatewayMocks.persistThreadTitle,
}))

function thread(id: string, cwd: string, options: { hasWorktree?: boolean } = {}) {
  return {
    id,
    title: id,
    projectName: cwd ? cwd.split('/').at(-1) || cwd : 'Projectless',
    cwd,
    hasWorktree: options.hasWorktree ?? false,
    createdAtIso: '2026-04-28T00:00:00.000Z',
    updatedAtIso: '2026-04-28T00:00:00.000Z',
    preview: '',
    unread: false,
    inProgress: false,
  }
}

function installTestWindow(initialStorage: Record<string, string> = {}) {
  const store = new Map(Object.entries(initialStorage))
  vi.stubGlobal('window', {
    localStorage: {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value)
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key)
      }),
    },
    setTimeout: vi.fn(),
    clearTimeout: vi.fn(),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  gatewayMocks.resumeThread.mockReset().mockResolvedValue({ messages: [], model: '', modelProvider: '', inProgress: false, activeTurnId: '', turnIndexByTurnId: {} })
  gatewayMocks.getThreadQueueState.mockResolvedValue({})
  gatewayMocks.getDeliveryStatuses.mockResolvedValue([])
  gatewayMocks.getThreadTitleCache.mockResolvedValue({ titles: {} })
  gatewayMocks.getWorkspaceRootsState.mockRejectedValue(new Error('no workspace roots state'))
})

describe('metadata operation lifecycle', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (cause: Error) => void
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
  }

  function setup() {
    installTestWindow()
    gatewayMocks.getAvailableCollaborationModes.mockReset().mockResolvedValue([{ value: 'default', label: 'Default' }, { value: 'plan', label: 'Plan' }])
    gatewayMocks.getCurrentModelConfig.mockReset().mockResolvedValue({ model: '', providerId: '', reasoningEffort: '', speedMode: '' })
    gatewayMocks.getAvailableModelIds.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockReset().mockResolvedValue(null)
    gatewayMocks.getSkillsList.mockReset().mockResolvedValue([])
    gatewayMocks.getThreadGroupsPage.mockReset().mockResolvedValue({ groups: [{ projectName: '/project', threads: [thread('metadata', '/project')] }], nextCursor: null })
    gatewayMocks.getThreadTitleCache.mockReset().mockResolvedValue({ titles: {} })
    gatewayMocks.getThreadDetail.mockResolvedValue({ messages: [], inProgress: false, activeTurnId: '', turnIndexByTurnId: {} })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.subscribeCodexNotifications.mockImplementation(() => vi.fn())
    const state = useDesktopState()
    state.primeSelectedThread('metadata')
    state.startPolling()
    return state
  }

  async function transition(state: ReturnType<typeof useDesktopState>, kind: string) {
    if (kind === 'account') await state.refreshAll({ accountChanged: true, includeThreads: false, includeSelectedThreadMessages: false })
    else { state.stopPolling(); state.startPolling() }
  }

  it.each(['stop', 'account'])('starts a current skills read without joining a stale slot after %s', async kind => {
    const state = setup()
    const old = deferred<unknown[]>()
    const current = deferred<unknown[]>()
    gatewayMocks.getSkillsList.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const oldRead = state.refreshSkills()
    await transition(state, kind)
    const currentRead = state.refreshSkills()
    old.resolve([{ name: 'old-skill', path: '/old', description: '' }])
    current.resolve([{ name: 'current-skill', path: '/current', description: '' }])
    await Promise.all([oldRead, currentRead])
    expect(gatewayMocks.getSkillsList).toHaveBeenCalledTimes(2)
    expect(state.installedSkills.value.map(row => row.name)).toEqual(['current-skill'])
    state.stopPolling()
  })

  it.each(['stop', 'account'])('does not restore old quota or reuse its flight after %s', async kind => {
    const state = setup()
    const old = deferred<unknown>()
    const current = deferred<unknown>()
    gatewayMocks.getAccountRateLimits.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const oldRead = state.refreshAll({ includeThreads: false, includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
    await vi.waitFor(() => expect(gatewayMocks.getAccountRateLimits).toHaveBeenCalledTimes(1))
    await transition(state, kind)
    const currentRead = state.refreshAll({ includeThreads: false, includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
    old.resolve({ limitId: 'old', primary: null, secondary: null })
    current.resolve({ limitId: 'current', primary: null, secondary: null })
    await Promise.all([oldRead, currentRead])
    expect(gatewayMocks.getAccountRateLimits).toHaveBeenCalledTimes(2)
    expect(state.codexQuota.value?.limitId).toBe('current')
    state.stopPolling()
  })

  it.each(['stop', 'account'])('does not apply late collaboration modes to current preferences after %s', async kind => {
    const state = setup()
    const old = deferred<unknown[]>()
    gatewayMocks.getAvailableCollaborationModes.mockReturnValueOnce(old.promise)
    const loading = state.refreshAll({ includeThreads: false, includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
    await vi.waitFor(() => expect(gatewayMocks.getAvailableCollaborationModes).toHaveBeenCalledOnce())
    await transition(state, kind)
    state.setSelectedCollaborationMode('plan')
    old.resolve([{ value: 'default', label: 'old mode' }])
    await loading
    expect(state.selectedCollaborationMode.value).toBe('plan')
    expect(state.availableCollaborationModes.value.some(row => row.label === 'old mode')).toBe(false)
    state.stopPolling()
  })

  it('does not publish an obsolete CLI config failure', async () => {
    const state = setup()
    const old = deferred<unknown>()
    gatewayMocks.getCurrentModelConfig.mockReturnValueOnce(old.promise)
    const loading = state.refreshAll({ includeThreads: false, includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
    await vi.waitFor(() => expect(gatewayMocks.getCurrentModelConfig).toHaveBeenCalledOnce())
    await transition(state, 'stop')
    old.reject(new Error('Codex CLI is not available'))
    await loading
    expect(state.codexCliMissingError.value).toBe('')
    state.stopPolling()
  })

  it('does not generate a cache entry or persist a title after the requesting lifecycle stops', async () => {
    const state = setup()
    const title = deferred<string>()
    gatewayMocks.generateThreadTitle.mockReset().mockReturnValueOnce(title.promise)
    gatewayMocks.persistThreadTitle.mockReset().mockResolvedValue(undefined)
    gatewayMocks.startThread.mockResolvedValueOnce({ threadId: 'titled', model: '' })
    gatewayMocks.startThreadTurn.mockResolvedValueOnce('title-turn')
    expect(await state.sendMessageToNewThread('original title', '/project')).toBe('titled')
    await transition(state, 'stop')
    title.resolve('obsolete generated title')
    await Promise.resolve()
    await Promise.resolve()
    expect(gatewayMocks.persistThreadTitle).not.toHaveBeenCalled()
    expect(state.selectedThread.value?.title).not.toBe('obsolete generated title')
    state.stopPolling()
  })

  it('does not seed the new list with a stopped title-cache read', async () => {
    const state = setup()
    const old = deferred<{ titles: Record<string, string> }>()
    gatewayMocks.getThreadTitleCache.mockReturnValueOnce(old.promise)
    const loading = state.refreshAll({ includeSelectedThreadMessages: false })
    await vi.waitFor(() => expect(gatewayMocks.getThreadTitleCache).toHaveBeenCalledOnce())
    await transition(state, 'stop')
    old.resolve({ titles: { metadata: 'obsolete cached title' } })
    await loading
    await state.refreshAll({ includeSelectedThreadMessages: false, forceThreadRefresh: true })
    expect(state.selectedThread.value?.title).not.toBe('obsolete cached title')
    state.stopPolling()
  })

  it('ignores an ancillary callback retained by the scheduler after stop/start', async () => {
    const state = setup()
    await state.refreshAll({ includeThreads: false, includeSelectedThreadMessages: false })
    const callback = vi.mocked(window.setTimeout).mock.calls.find(([, delay]) => delay === 0)![0] as () => void
    await transition(state, 'stop')
    gatewayMocks.getSkillsList.mockClear()
    gatewayMocks.getCurrentModelConfig.mockClear()
    callback()
    await Promise.resolve()
    expect(gatewayMocks.getSkillsList).not.toHaveBeenCalled()
    expect(gatewayMocks.getCurrentModelConfig).not.toHaveBeenCalled()
    state.stopPolling()
  })

  it('keeps a new skills slot across an old finally and coalesces its current joiners', async () => {
    const state = setup()
    const old = deferred<unknown[]>()
    const current = deferred<unknown[]>()
    gatewayMocks.getSkillsList.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const oldRead = state.refreshSkills()
    await transition(state, 'stop')
    const currentRead = state.refreshSkills()
    old.resolve([])
    await oldRead
    const joined = state.refreshSkills()
    current.resolve([{ name: 'current', path: '/current', description: '' }])
    await Promise.all([currentRead, joined])
    await state.refreshSkills()
    expect(gatewayMocks.getSkillsList).toHaveBeenCalledTimes(2)
    state.stopPolling()
  })

  it('starts a different cwd skills read and rejects the previous cwd result', async () => {
    const state = setup()
    const old = deferred<unknown[]>()
    gatewayMocks.getSkillsList.mockReturnValueOnce(old.promise).mockResolvedValueOnce([{ name: 'project-skill', path: '/project/skill', description: '' }])
    const oldRead = state.refreshSkills()
    await state.refreshAll({ includeSelectedThreadMessages: false })
    await state.refreshSkills()
    old.resolve([{ name: 'global-old', path: '/old', description: '' }])
    await oldRead
    expect(gatewayMocks.getSkillsList.mock.calls.map(([cwds]) => cwds)).toEqual([undefined, ['/project']])
    expect(state.installedSkills.value.map(row => row.name)).toEqual(['project-skill'])
    state.stopPolling()
  })

  it('does not overwrite a confirmed rename with an earlier title-cache response', async () => {
    const state = setup()
    const cache = deferred<{ titles: Record<string, string> }>()
    gatewayMocks.getThreadTitleCache.mockReturnValueOnce(cache.promise)
    gatewayMocks.renameThread.mockResolvedValueOnce(undefined)
    gatewayMocks.persistThreadTitle.mockResolvedValueOnce(undefined)
    const loading = state.refreshAll({ includeSelectedThreadMessages: false })
    await vi.waitFor(() => expect(gatewayMocks.getThreadTitleCache).toHaveBeenCalledOnce())
    await state.renameThreadById('metadata', 'current confirmed title')
    cache.resolve({ titles: { metadata: 'earlier server title' } })
    await loading
    expect(state.selectedThread.value?.title).toBe('current confirmed title')
    state.stopPolling()
  })
})

describe('thread mutation continuations', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    gatewayMocks.getThreadGroupsPage.mockReset()
    gatewayMocks.revertThreadFileChanges.mockReset()
    gatewayMocks.rollbackThread.mockReset()
  })

  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (cause: Error) => void
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
  }

  async function setup() {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockReset().mockResolvedValue({ groups: [{ projectName: 'project', threads: [thread('source', '/project'), thread('other', '/project')] }], nextCursor: null })
    gatewayMocks.getThreadDetail.mockReset().mockResolvedValue({ messages: [{ id: 'source-message', role: 'user', text: 'source', turnId: 'turn', turnIndex: 0 }], inProgress: false, activeTurnId: '', turnIndexByTurnId: { turn: 0 } })
    gatewayMocks.getPendingServerRequests.mockReset().mockResolvedValue([])
    gatewayMocks.subscribeCodexNotifications.mockReset().mockReturnValue(vi.fn())
    gatewayMocks.renameThread.mockReset().mockResolvedValue(undefined)
    gatewayMocks.persistThreadTitle.mockReset().mockResolvedValue(undefined)
    gatewayMocks.archiveThread.mockReset().mockResolvedValue(undefined)
    gatewayMocks.forkThread.mockReset().mockResolvedValue({ threadId: 'forked', model: '' })
    gatewayMocks.forkThreadAtTurn.mockReset().mockResolvedValue({ threadId: 'forked', model: '' })
    gatewayMocks.revertThreadFileChanges.mockReset().mockResolvedValue({ reverted: 0, errors: [] })
    gatewayMocks.rollbackThread.mockReset().mockResolvedValue([])
    const state = useDesktopState()
    state.primeSelectedThread('source')
    state.startPolling()
    await state.refreshAll({ forceThreadRefresh: true })
    return state
  }

  async function transition(state: ReturnType<typeof useDesktopState>, kind: string) {
    if (kind === 'account') await state.refreshAll({ accountChanged: true, includeThreads: false, includeSelectedThreadMessages: false })
    else { state.stopPolling(); state.startPolling() }
  }

  it.each(['stop', 'account'])('does not update or persist a late rename after %s', async kind => {
    const state = await setup()
    const rename = deferred<void>()
    gatewayMocks.renameThread.mockReturnValueOnce(rename.promise)
    const operation = state.renameThreadById('source', 'Old title')
    await transition(state, kind)
    const version = state.threadSearchVersion.value
    rename.resolve()
    await operation
    expect(gatewayMocks.persistThreadTitle).not.toHaveBeenCalled()
    expect(state.selectedThread.value?.title).not.toBe('Old title')
    expect(state.threadSearchVersion.value).toBe(version)
    state.stopPolling()
  })

  it.each(['stop', 'account'])('does not remove current rows or read lists after an old archive completes after %s', async kind => {
    const state = await setup()
    const archive = deferred<void>()
    gatewayMocks.archiveThread.mockReturnValueOnce(archive.promise)
    const operation = state.archiveThreadById('other')
    await transition(state, kind)
    gatewayMocks.getThreadGroupsPage.mockClear()
    const version = state.threadSearchVersion.value
    const rows = state.projectGroups.value
    archive.resolve()
    await operation
    expect(gatewayMocks.getThreadGroupsPage).not.toHaveBeenCalled()
    expect(state.projectGroups.value).toBe(rows)
    expect(state.threadSearchVersion.value).toBe(version)
    state.stopPolling()
  })

  it.each(['rename', 'archive', 'fork', 'fork-turn'])('does not overwrite a current error after an old %s failure', async action => {
    const state = await setup()
    const failure = deferred<never>()
    const api = { rename: gatewayMocks.renameThread, archive: gatewayMocks.archiveThread, fork: gatewayMocks.forkThread, 'fork-turn': gatewayMocks.forkThreadAtTurn }[action]!
    api.mockReturnValueOnce(failure.promise)
    const operation = action === 'rename' ? state.renameThreadById('source', 'Old') : action === 'archive' ? state.archiveThreadById('other') : action === 'fork' ? state.forkThreadById('source') : state.forkThreadFromTurn('source', 'turn')
    await transition(state, 'account')
    state.error.value = 'Current error'
    failure.reject(new Error('Old failure'))
    await operation
    expect(state.error.value).toBe('Current error')
    state.stopPolling()
  })

  it.each(['fork', 'fork-turn'])('does not insert or navigate an old %s after account change', async action => {
    const state = await setup()
    const fork = deferred<{ threadId: string; model: string }>()
    const api = action === 'fork' ? gatewayMocks.forkThread : gatewayMocks.forkThreadAtTurn
    api.mockReturnValueOnce(fork.promise)
    const operation = action === 'fork' ? state.forkThreadById('source') : state.forkThreadFromTurn('source', 'turn')
    await transition(state, 'account')
    state.primeSelectedThread('other')
    gatewayMocks.getThreadGroupsPage.mockClear()
    gatewayMocks.resumeThread.mockClear()
    fork.resolve({ threadId: 'old-fork', model: 'gpt-6-astra' })
    expect(await operation).toBe('')
    expect(state.selectedThreadId.value).toBe('other')
    expect(state.projectGroups.value.flatMap(group => group.threads.map(row => row.id))).not.toContain('old-fork')
    expect(gatewayMocks.renameThread).not.toHaveBeenCalled()
    expect(gatewayMocks.getThreadGroupsPage).not.toHaveBeenCalled()
    expect(gatewayMocks.resumeThread).not.toHaveBeenCalled()
    state.stopPolling()
  })

  it.each(['fork', 'fork-turn'])('does not take selection back after navigation during %s', async action => {
    const state = await setup()
    const fork = deferred<{ threadId: string; model: string }>()
    const api = action === 'fork' ? gatewayMocks.forkThread : gatewayMocks.forkThreadAtTurn
    api.mockReturnValueOnce(fork.promise)
    const operation = action === 'fork' ? state.forkThreadById('source') : state.forkThreadFromTurn('source', 'turn')
    state.primeSelectedThread('other')
    fork.resolve({ threadId: 'old-fork', model: '' })
    expect(await operation).toBe('')
    expect(state.selectedThreadId.value).toBe('other')
    state.stopPolling()
  })

  it('does not issue any mutation while stopped', async () => {
    const state = await setup()
    state.stopPolling()
    await state.renameThreadById('source', 'Old')
    await state.archiveThreadById('source')
    expect(await state.forkThreadById('source')).toBe('')
    expect(await state.forkThreadFromTurn('source', 'turn')).toBe('')
    expect(gatewayMocks.renameThread).not.toHaveBeenCalled()
    expect(gatewayMocks.archiveThread).not.toHaveBeenCalled()
    expect(gatewayMocks.forkThread).not.toHaveBeenCalled()
    expect(gatewayMocks.forkThreadAtTurn).not.toHaveBeenCalled()
  })

  it('releases a late persistence completion without committing search state or its error', async () => {
    const state = await setup()
    const persist = deferred<void>()
    gatewayMocks.persistThreadTitle.mockReturnValueOnce(persist.promise)
    const operation = state.renameThreadById('source', 'Accepted title')
    await vi.waitFor(() => expect(gatewayMocks.persistThreadTitle).toHaveBeenCalledOnce())
    await transition(state, 'account')
    const version = state.threadSearchVersion.value
    state.error.value = 'Current error'
    persist.reject(new Error('Old persistence failure'))
    await operation
    expect(state.threadSearchVersion.value).toBe(version)
    expect(state.error.value).toBe('Current error')
    state.stopPolling()
  })

  it('does not load fork history after selection changes during its list refresh', async () => {
    const state = await setup()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000)
    const list = deferred<{ groups: UiProjectGroup[]; nextCursor: null }>()
    gatewayMocks.getThreadGroupsPage.mockClear().mockReturnValueOnce(list.promise)
    gatewayMocks.getThreadDetail.mockClear()
    gatewayMocks.resumeThread.mockClear()
    const operation = state.forkThreadById('source')
    await vi.waitFor(() => expect(gatewayMocks.getThreadGroupsPage).toHaveBeenCalledOnce())
    state.primeSelectedThread('other')
    list.resolve({ groups: [{ projectName: 'project', threads: [thread('source', '/project'), thread('other', '/project')] }], nextCursor: null })
    expect(await operation).toBe('')
    expect(state.selectedThreadId.value).toBe('other')
    expect(gatewayMocks.getThreadDetail).not.toHaveBeenCalled()
    expect(gatewayMocks.resumeThread).not.toHaveBeenCalled()
    state.stopPolling()
  })

  it('does not select a history fork after its rename crosses an account transition', async () => {
    const state = await setup()
    const rename = deferred<void>()
    gatewayMocks.renameThread.mockReturnValueOnce(rename.promise)
    const operation = state.forkThreadFromTurn('source', 'turn')
    await vi.waitFor(() => expect(gatewayMocks.renameThread).toHaveBeenCalledOnce())
    await transition(state, 'account')
    state.primeSelectedThread('other')
    gatewayMocks.resumeThread.mockClear()
    rename.resolve()
    expect(await operation).toBe('')
    expect(state.selectedThreadId.value).toBe('other')
    expect(gatewayMocks.persistThreadTitle).not.toHaveBeenCalled()
    expect(gatewayMocks.resumeThread).not.toHaveBeenCalled()
    state.stopPolling()
  })

  it('does not schedule a list refresh after a history fork read crosses an account transition', async () => {
    const state = await setup()
    const history = deferred<unknown>()
    gatewayMocks.getThreadDetail.mockReturnValueOnce(history.promise)
    const operation = state.forkThreadFromTurn('source', 'turn')
    await vi.waitFor(() => expect(state.selectedThreadId.value).toBe('forked'))
    await transition(state, 'account')
    state.primeSelectedThread('other')
    gatewayMocks.getThreadGroupsPage.mockClear()
    history.resolve({ messages: [], inProgress: false, activeTurnId: '', turnIndexByTurnId: {} })
    expect(await operation).toBe('')
    expect(gatewayMocks.getThreadGroupsPage).not.toHaveBeenCalled()
    expect(state.selectedThreadId.value).toBe('other')
    state.stopPolling()
  })

  it('does not scaffold or rename an empty history fork result', async () => {
    const state = await setup()
    gatewayMocks.forkThreadAtTurn.mockResolvedValueOnce({ threadId: '', model: '' })
    expect(await state.forkThreadFromTurn('source', 'turn')).toBe('')
    expect(state.selectedThreadId.value).toBe('source')
    expect(gatewayMocks.renameThread).not.toHaveBeenCalled()
    expect(state.projectGroups.value.flatMap(group => group.threads.map(row => row.id))).not.toContain('')
    state.stopPolling()
  })

  it('keeps a current background rename valid when the user opens another conversation', async () => {
    const state = await setup()
    const rename = deferred<void>()
    gatewayMocks.renameThread.mockReturnValueOnce(rename.promise)
    const operation = state.renameThreadById('source', 'Confirmed')
    state.primeSelectedThread('other')
    rename.resolve()
    await operation
    expect(gatewayMocks.persistThreadTitle).toHaveBeenCalledExactlyOnceWith('source', 'Confirmed')
    expect(state.projectGroups.value.flatMap(group => group.threads).find(row => row.id === 'source')?.title).toBe('Confirmed')
    expect(state.selectedThreadId.value).toBe('other')
    state.stopPolling()
  })

  it.each(['stop', 'account'])('does not start history rollback after an old file undo finishes after %s', async kind => {
    const state = await setup()
    const files = deferred<{ reverted: number; errors: string[] }>()
    gatewayMocks.revertThreadFileChanges.mockReturnValueOnce(files.promise)
    const operation = state.rollbackSelectedThread('turn')
    expect(gatewayMocks.revertThreadFileChanges).toHaveBeenCalledOnce()
    await transition(state, kind)
    files.resolve({ reverted: 1, errors: [] })
    expect(await operation).toBe(false)
    expect(gatewayMocks.rollbackThread).not.toHaveBeenCalled()
    expect(state.isRollingBack.value).toBe(false)
    state.stopPolling()
  })

  it.each(['stop', 'account'])('does not restore old history or continue sync after a late rollback after %s', async kind => {
    const state = await setup()
    const history = deferred<unknown[]>()
    gatewayMocks.rollbackThread.mockReturnValueOnce(history.promise)
    const operation = state.rollbackSelectedThread('turn')
    await vi.waitFor(() => expect(gatewayMocks.rollbackThread).toHaveBeenCalledOnce())
    await transition(state, kind)
    await state.loadMessages('source')
    const current = state.messages.value
    gatewayMocks.getThreadGroupsPage.mockClear()
    history.resolve([{ id: 'old-rollback', role: 'assistant', text: 'Old rollback' }])
    expect(await operation).toBe(false)
    expect(state.messages.value).toEqual(current)
    expect(gatewayMocks.getThreadGroupsPage).not.toHaveBeenCalled()
    state.stopPolling()
  })

  it('does not expose errors from a file undo belonging to a former account', async () => {
    const state = await setup()
    const files = deferred<{ reverted: number; errors: string[] }>()
    gatewayMocks.revertThreadFileChanges.mockReturnValueOnce(files.promise)
    const operation = state.rollbackSelectedThread('turn')
    await transition(state, 'account')
    state.error.value = 'Current error'
    files.resolve({ reverted: 0, errors: ['Old file error'] })
    expect(await operation).toBe(false)
    expect(state.error.value).toBe('Current error')
    state.stopPolling()
  })

  it('releases the old rollback slot on account change without letting old finally release the new slot', async () => {
    const state = await setup()
    const old = deferred<{ reverted: number; errors: string[] }>()
    const current = deferred<{ reverted: number; errors: string[] }>()
    gatewayMocks.revertThreadFileChanges.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const previous = state.rollbackSelectedThread('turn')
    await transition(state, 'account')
    state.primeSelectedThread('source')
    await state.refreshAll({ forceThreadRefresh: true })
    expect(state.selectedThread.value?.cwd).toBe('/project')
    const next = state.rollbackSelectedThread('turn')
    old.resolve({ reverted: 1, errors: [] })
    await previous
    expect(gatewayMocks.revertThreadFileChanges).toHaveBeenCalledTimes(2)
    expect(state.isRollingBack.value).toBe(true)
    current.resolve({ reverted: 0, errors: ['Current fixture stops before history write'] })
    expect(await next).toBe(false)
    expect(state.isRollingBack.value).toBe(false)
    state.stopPolling()
  })

  it('does not report rollback success after its synchronization crosses an account transition', async () => {
    const state = await setup()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000)
    const list = deferred<{ groups: UiProjectGroup[]; nextCursor: null }>()
    gatewayMocks.getThreadGroupsPage.mockClear().mockReturnValueOnce(list.promise)
    const operation = state.rollbackSelectedThread('turn')
    await vi.waitFor(() => expect(gatewayMocks.getThreadGroupsPage).toHaveBeenCalledOnce())
    await transition(state, 'account')
    list.resolve({ groups: [], nextCursor: null })
    expect(await operation).toBe(false)
    state.stopPolling()
  })

  it('deduplicates a current rollback and keeps file errors ahead of the history write', async () => {
    const state = await setup()
    const files = deferred<{ reverted: number; errors: string[] }>()
    gatewayMocks.revertThreadFileChanges.mockReturnValueOnce(files.promise)
    const operation = state.rollbackSelectedThread('turn')
    expect(await state.rollbackSelectedThread('turn')).toBe(false)
    expect(gatewayMocks.revertThreadFileChanges).toHaveBeenCalledExactlyOnceWith('source', 'turn', '/project')
    files.resolve({ reverted: 0, errors: ['Current file error'] })
    expect(await operation).toBe(false)
    expect(gatewayMocks.rollbackThread).not.toHaveBeenCalled()
    expect(state.error.value).toBe('Current file error')
    expect(state.isRollingBack.value).toBe(false)
    state.stopPolling()
  })
})

describe('send operation lifecycle', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (cause: Error) => void
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
  }

  function setup(running = false) {
    installTestWindow()
    gatewayMocks.startThread.mockReset()
    gatewayMocks.startThreadTurn.mockReset().mockResolvedValue('current-turn')
    gatewayMocks.getThreadDetail.mockReset().mockResolvedValue({ messages: [], inProgress: running, activeTurnId: running ? 'source-turn' : '', turnIndexByTurnId: {}, hasMoreOlder: false })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.generateThreadTitle.mockReset().mockResolvedValue('current title')
    gatewayMocks.subscribeCodexNotifications.mockImplementation(() => vi.fn())
    const state = useDesktopState()
    state.primeSelectedThread('send-thread')
    state.startPolling()
    return state
  }

  async function transition(state: ReturnType<typeof useDesktopState>, kind: string) {
    if (kind === 'account') await state.refreshAll({ accountChanged: true, includeThreads: false, includeSelectedThreadMessages: false })
    else { state.stopPolling(); state.startPolling() }
  }

  it.each(['stop', 'account'])('does not follow a late resume with a turn submission after %s', async kind => {
    const state = setup()
    const resume = deferred<{ messages: never[]; model: string; modelProvider: string }>()
    gatewayMocks.resumeThread.mockReturnValueOnce(resume.promise)
    const sending = state.sendMessageToSelectedThread('old prompt')
    await transition(state, kind)
    resume.resolve({ messages: [], model: 'old-model', modelProvider: 'old-provider' })
    await sending
    expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()
    expect(state.readModelIdForThread('send-thread')).not.toBe('old-model')
    state.stopPolling()
  })

  it.each(['stop', 'account'])('does not commit a late selected-turn success after %s', async kind => {
    const state = setup()
    await state.loadMessages('send-thread')
    const turn = deferred<string>()
    gatewayMocks.startThreadTurn.mockReturnValueOnce(turn.promise)
    const sending = state.sendMessageToSelectedThread('old prompt')
    await vi.waitFor(() => expect(gatewayMocks.startThreadTurn).toHaveBeenCalled())
    await transition(state, kind)
    gatewayMocks.getThreadDetail.mockClear()
    vi.mocked(window.setTimeout).mockClear()
    turn.resolve('old-turn')
    await sending
    expect(state.messages.value.some(row => row.text === 'old prompt')).toBe(false)
    expect(gatewayMocks.getThreadDetail).not.toHaveBeenCalled()
    expect(vi.mocked(window.setTimeout).mock.calls.filter(([, delay]) => delay === 3000)).toEqual([])
    state.stopPolling()
  })

  it.each(['stop', 'account'])('does not publish a late selected-turn failure after %s', async kind => {
    const state = setup()
    await state.loadMessages('send-thread')
    const turn = deferred<string>()
    gatewayMocks.startThreadTurn.mockReturnValueOnce(turn.promise)
    const sending = state.sendMessageToSelectedThread('old prompt')
    const settled = sending.then(() => 'obsolete', () => 'rejected')
    await vi.waitFor(() => expect(gatewayMocks.startThreadTurn).toHaveBeenCalled())
    await transition(state, kind)
    state.error.value = 'current error'
    turn.reject(new Error('old failure'))
    expect(await settled).toBe('obsolete')
    expect(state.error.value).toBe('current error')
    state.stopPolling()
  })

  it.each(['stop', 'account'])('ignores late steering display observers and failure reads after %s', async kind => {
    const state = setup(true)
    await state.loadMessages('send-thread')
    const turn = deferred<string>()
    gatewayMocks.startThreadTurn.mockReturnValueOnce(turn.promise)
    const sending = state.sendMessageToSelectedThread('old steer', [], [], 'steer')
    const settled = sending.catch(() => {})
    await vi.waitFor(() => expect(gatewayMocks.startThreadTurn).toHaveBeenCalled())
    const delivery = gatewayMocks.startThreadTurn.mock.calls[0][10]
    const originalId = delivery.id
    await transition(state, kind)
    gatewayMocks.getThreadQueueState.mockClear()
    delivery.onPrepared('old-prepared')
    delivery.onResult({ id: 'old-result', status: 'accepted', turnId: 'old-turn' })
    turn.reject(new Error('old steer failure'))
    await settled
    expect(state.messages.value.find(row => row.text === 'old steer')?.clientUserMessageId).toBe(originalId)
    expect(state.messages.value.find(row => row.text === 'old steer')?.deliveryState?.status).toBe('submitting')
    expect(gatewayMocks.getThreadQueueState).not.toHaveBeenCalled()
    state.stopPolling()
  })

  it.each(['stop', 'account'])('releases a stale creation slot and protects a new busy slot after %s', async kind => {
    const state = setup()
    const old = deferred<{ threadId: string; model: string }>()
    const current = deferred<{ threadId: string; model: string }>()
    gatewayMocks.startThread.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const oldSend = state.sendMessageToNewThread('old prompt', '/old')
    await transition(state, kind)
    const currentSend = state.sendMessageToNewThread('current prompt', '/current')
    expect(gatewayMocks.startThread).toHaveBeenCalledTimes(2)
    old.resolve({ threadId: 'old-created', model: 'old-model' })
    expect(await oldSend).toBe('')
    expect(state.selectedThreadId.value).toBe('send-thread')
    expect(state.isSendingMessage.value).toBe(true)
    expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()
    current.resolve({ threadId: 'current-created', model: '' })
    expect(await currentSend).toBe('current-created')
    expect(state.isSendingMessage.value).toBe(false)
    state.stopPolling()
  })

  it.each(['success', 'failure'])('does not navigate, title or clear a new slot after an old new-thread turn %s', async result => {
    const state = setup()
    const old = deferred<string>()
    const current = deferred<{ threadId: string; model: string }>()
    gatewayMocks.startThread.mockResolvedValueOnce({ threadId: 'old-created', model: '' }).mockReturnValueOnce(current.promise)
    gatewayMocks.startThreadTurn.mockReturnValueOnce(old.promise)
    const oldSend = state.sendMessageToNewThread('old prompt', '/old')
    const settled = oldSend.then(value => value, () => 'rejected')
    await vi.waitFor(() => expect(gatewayMocks.startThreadTurn).toHaveBeenCalledTimes(1))
    await transition(state, 'stop')
    const currentSend = state.sendMessageToNewThread('current prompt', '/current')
    state.error.value = 'current error'
    if (result === 'success') old.resolve('old-turn')
    else old.reject(new Error('old failure'))
    expect(await settled).toBe('')
    expect(gatewayMocks.generateThreadTitle).not.toHaveBeenCalled()
    expect(state.isSendingMessage.value).toBe(true)
    expect(state.error.value).toBe('current error')
    current.resolve({ threadId: 'current-created', model: '' })
    await currentSend
    state.stopPolling()
  })

  it.each(['detail', 'turn'])('does not merge questions or submit an answer after a stopped %s read', async stage => {
    const state = setup()
    const question = { id: 'q', turnId: 'source-turn', role: 'assistant', text: 'choose', questions: [{ title: 'Fruit?', options: ['Pear'] }], questionOrdinal: 0 }
    gatewayMocks.getThreadDetail.mockResolvedValueOnce({ messages: [question], inProgress: false, activeTurnId: '', turnIndexByTurnId: {}, hasMoreOlder: false })
    await state.loadMessages('send-thread')
    const detail = deferred<unknown>()
    const turns = deferred<unknown>()
    if (stage === 'detail') gatewayMocks.getThreadDetail.mockReturnValueOnce(detail.promise)
    else gatewayMocks.getThreadTurnMessages.mockReturnValueOnce(turns.promise)
    const answering = state.answerAsyncQuestions({ threadId: 'send-thread', turnId: 'source-turn', itemId: 'q', questionOrdinal: 0, answers: ['Pear'] })
    if (stage === 'turn') await vi.waitFor(() => expect(gatewayMocks.getThreadTurnMessages).toHaveBeenCalled())
    await transition(state, 'stop')
    if (stage === 'detail') detail.resolve({ messages: [question, { id: 'old-read', role: 'assistant', text: 'old read' }] })
    else turns.resolve([question])
    await answering
    expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()
    expect(state.messages.value.some(row => row.text === 'old read')).toBe(false)
    state.stopPolling()
  })

  it('does not schedule delayed sync when context changes during post-acceptance history loading', async () => {
    const state = setup()
    await state.loadMessages('send-thread')
    const detail = deferred<unknown>()
    gatewayMocks.getThreadDetail.mockReturnValueOnce(detail.promise)
    const sending = state.sendMessageToSelectedThread('accepted prompt')
    await vi.waitFor(() => expect(gatewayMocks.getThreadDetail).toHaveBeenCalled())
    await transition(state, 'stop')
    vi.mocked(window.setTimeout).mockClear()
    detail.resolve({ messages: [], inProgress: false, activeTurnId: '', turnIndexByTurnId: {} })
    await sending
    expect(vi.mocked(window.setTimeout).mock.calls.filter(([, delay]) => delay === 3000)).toEqual([])
    state.stopPolling()
  })

  it('does not start unsupported-model fallback after an obsolete creation failure', async () => {
    const state = setup()
    state.setSelectedModelIdForThread('__new-thread__', 'unsupported-model')
    const create = deferred<{ threadId: string; model: string }>()
    gatewayMocks.startThread.mockReturnValueOnce(create.promise)
    const sending = state.sendMessageToNewThread('old prompt', '/old')
    const settled = sending.catch(() => 'rejected')
    await transition(state, 'stop')
    create.reject(new Error('model is not supported'))
    expect(await settled).toBe('')
    expect(gatewayMocks.startThread).toHaveBeenCalledTimes(1)
    state.stopPolling()
  })

  it('ignores an obsolete fallback creation result', async () => {
    const state = setup()
    state.setSelectedModelIdForThread('__new-thread__', 'unsupported-model')
    const fallback = deferred<{ threadId: string; model: string }>()
    gatewayMocks.startThread.mockRejectedValueOnce(new Error('model is not supported')).mockReturnValueOnce(fallback.promise)
    const sending = state.sendMessageToNewThread('old prompt', '/old')
    await vi.waitFor(() => expect(gatewayMocks.startThread).toHaveBeenCalledTimes(2))
    await transition(state, 'stop')
    fallback.resolve({ threadId: 'old-fallback', model: 'old-model' })
    expect(await sending).toBe('')
    expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()
    expect(state.selectedThreadId.value).toBe('send-thread')
    state.stopPolling()
  })

  it('releases new-thread busy on an empty creation result and keeps current failure recovery metadata', async () => {
    const state = setup()
    gatewayMocks.startThread.mockResolvedValueOnce({ threadId: '', model: '' })
    expect(await state.sendMessageToNewThread('prompt', '/project')).toBe('')
    expect(state.isSendingMessage.value).toBe(false)
    gatewayMocks.startThread.mockResolvedValueOnce({ threadId: 'created', model: '' })
    gatewayMocks.startThreadTurn.mockRejectedValueOnce(new Error('current failure'))
    await expect(state.sendMessageToNewThread('prompt', '/project')).rejects.toMatchObject({ message: 'current failure', createdThreadId: 'created' })
    expect(state.error.value).toBe('current failure')
    expect(state.isSendingMessage.value).toBe(false)
    state.stopPolling()
  })

  it('ignores a stopped question-read error and refuses sends while stopped', async () => {
    const state = setup()
    const question = { id: 'q', turnId: 'source-turn', role: 'assistant', text: 'choose', questions: [{ title: 'Fruit?', options: ['Pear'] }] }
    gatewayMocks.getThreadDetail.mockResolvedValueOnce({ messages: [question], inProgress: false, activeTurnId: '', turnIndexByTurnId: {}, hasMoreOlder: false })
    await state.loadMessages('send-thread')
    const detail = deferred<unknown>()
    gatewayMocks.getThreadDetail.mockReturnValueOnce(detail.promise)
    const answer = state.answerAsyncQuestions({ threadId: 'send-thread', turnId: 'source-turn', itemId: 'q', answers: ['Pear'] })
    state.stopPolling()
    detail.reject(new Error('old read error'))
    await expect(answer).resolves.toBeUndefined()
    await state.sendMessageToSelectedThread('stopped')
    expect(await state.sendMessageToNewThread('stopped', '/project')).toBe('')
    expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()
    expect(gatewayMocks.startThread).not.toHaveBeenCalled()
  })
})

describe('queue operation lifecycle', () => {
  function setup() {
    installTestWindow()
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    let notify!: (event: { method: string; params: unknown }) => void
    let turnSequence = 0
    gatewayMocks.subscribeCodexNotifications.mockImplementation(handler => { notify = handler; return vi.fn() })
    gatewayMocks.mutateThreadQueueState.mockReset()
    const state = useDesktopState()
    state.primeSelectedThread('queue-lifecycle')
    state.startPolling()
    const message = {
      id: 'queue-lifecycle-message', text: 'old queued content', imageUrls: [], skills: [], fileAttachments: [],
      collaborationMode: 'default' as const,
      delivery: { mode: 'queue' as const, status: 'queued' as const, revision: 1, createdAt: 1, updatedAt: 1 },
    }
    gatewayMocks.getThreadQueueState.mockResolvedValue({ 'queue-lifecycle': [message] })
    return { state, message,
      notifyQueueRefresh: () => notify({ method: 'turn/completed', params: { threadId: 'queue-lifecycle', turn: { id: `queue-refresh-${++turnSequence}` } } }),
    }
  }

  async function transition(state: ReturnType<typeof useDesktopState>, kind: string) {
    gatewayMocks.getThreadQueueState.mockResolvedValue({})
    if (kind === 'account') {
      await state.refreshAll({ accountChanged: true, includeThreads: false, includeSelectedThreadMessages: false })
    } else {
      state.stopPolling()
      state.startPolling()
    }
  }

  it.each(['stop', 'account'])('does not commit a late delivered queue action after %s', async kind => {
    const { state, message } = setup()
    await state.refreshQueueState()
    let release!: (result: unknown) => void
    gatewayMocks.mutateThreadQueueState.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const old = state.changeQueuedMessage(message.id, 'reconcile')
    await Promise.resolve()
    const changed = transition(state, kind)
    vi.mocked(window.setTimeout).mockClear()
    release({ state: {}, delivered: { id: message.id, turnId: 'old-turn' } })
    await old
    expect(state.messages.value.some(row => row.text === message.text)).toBe(false)
    expect(vi.mocked(window.setTimeout).mock.calls.filter(([, delay]) => delay === 3000)).toEqual([])
    await changed
    state.stopPolling()
  })

  it.each(['stop', 'account'])('does not accept a late steering result after %s', async kind => {
    const { state, message } = setup()
    await state.refreshQueueState()
    let release!: (result: unknown) => void
    gatewayMocks.mutateThreadQueueState.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const old = state.steerQueuedMessage(message.id)
    await Promise.resolve()
    const changed = transition(state, kind)
    release({ state: {}, delivered: { id: message.id, turnId: 'old-turn' } })
    await old
    expect(state.messages.value.find(row => row.text === message.text)?.deliveryState?.status).toBe('submitting')
    await changed
    state.stopPolling()
  })

  it.each(['remove', 'edit'])('does not return a late %s result to the composer', async action => {
    const { state, message } = setup()
    await state.refreshQueueState()
    let release!: (result: unknown) => void
    gatewayMocks.mutateThreadQueueState.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const old = action === 'remove' ? state.removeQueuedMessage(message.id) : state.beginQueuedMessageEdit(message.id)
    await Promise.resolve()
    await transition(state, 'stop')
    release({ state: { 'queue-lifecycle': [{ ...message, delivery: { ...message.delivery, status: 'editing' } }] }, removed: message })
    expect(await old).toBeNull()
    state.stopPolling()
  })

  it.each(['remove', 'edit', 'move', 'steer'])('does not refresh the new context after an old %s failure', async action => {
    const { state, message } = setup()
    await state.refreshQueueState()
    let reject!: (cause: Error) => void
    gatewayMocks.mutateThreadQueueState.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    const old = action === 'remove' ? state.removeQueuedMessage(message.id)
      : action === 'edit' ? state.beginQueuedMessageEdit(message.id)
        : action === 'move' ? state.reorderQueuedMessage(message.id, 'target') : state.steerQueuedMessage(message.id)
    await Promise.resolve()
    await transition(state, 'stop')
    gatewayMocks.getThreadQueueState.mockClear()
    reject(new Error('old queue failure'))
    await old
    await Promise.resolve()
    expect(gatewayMocks.getThreadQueueState).not.toHaveBeenCalled()
    expect(state.error.value).toBe('')
    if (action === 'steer') expect(state.messages.value.find(row => row.text === message.text)?.deliveryState?.status).toBe('submitting')
    state.stopPolling()
  })

  it('does not publish a stopped queue read failure over a current error', async () => {
    const { state } = setup()
    let reject!: (cause: Error) => void
    gatewayMocks.getThreadQueueState.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    const old = state.refreshQueueState().catch(() => {})
    await Promise.resolve()
    await transition(state, 'stop')
    gatewayMocks.getThreadQueueState.mockRejectedValueOnce(new Error('current queue failure'))
    await state.refreshQueueState().catch(() => {})
    reject(new Error('old queue failure'))
    await old
    expect(state.selectedThreadQueueError.value).toBe('current queue failure')
    state.stopPolling()
  })

  it.each(['stop', 'account'])('isolates receipt commits and in-flight slots after %s', async kind => {
    const { state, message } = setup()
    gatewayMocks.getThreadQueueState.mockResolvedValue({ 'queue-lifecycle': [{ ...message, delivery: { ...message.delivery, mode: 'steer' } }] })
    await state.refreshQueueState()
    let releaseOld!: (result: unknown) => void
    let releaseCurrent!: (result: unknown) => void
    gatewayMocks.getDeliveryStatuses.mockReset()
    gatewayMocks.getDeliveryStatuses
      .mockImplementationOnce(() => new Promise(resolve => { releaseOld = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { releaseCurrent = resolve }))
      .mockResolvedValue([])
    gatewayMocks.getThreadQueueState.mockResolvedValue({})
    await state.refreshQueueState()
    expect(gatewayMocks.getDeliveryStatuses).toHaveBeenCalledTimes(1)
    await transition(state, kind)
    await state.refreshQueueState()
    expect(gatewayMocks.getDeliveryStatuses).toHaveBeenCalledTimes(2)
    releaseOld([{ id: message.id, status: 'cancelled' }])
    await Promise.resolve()
    await Promise.resolve()
    expect(state.messages.value.find(row => row.text === message.text)?.deliveryState?.status).toBe('queued')
    await state.refreshQueueState()
    expect(gatewayMocks.getDeliveryStatuses).toHaveBeenCalledTimes(2)
    releaseCurrent([{ id: message.id, status: 'accepted', turnId: 'current-turn' }])
    await Promise.resolve()
    await Promise.resolve()
    expect(state.messages.value.find(row => row.text === message.text)?.deliveryState?.status).toBe('accepted')
    state.stopPolling()
  })

  it('does not let an old processing finally release a current queue refresh', async () => {
    const { state, notifyQueueRefresh } = setup()
    let releaseOld!: (result: unknown) => void
    let releaseCurrent!: (result: unknown) => void
    gatewayMocks.getThreadQueueState.mockReset()
    gatewayMocks.getThreadQueueState
      .mockImplementationOnce(() => new Promise(resolve => { releaseOld = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { releaseCurrent = resolve }))
      .mockResolvedValue({})
    notifyQueueRefresh()
    await Promise.resolve()
    await transition(state, 'stop')
    notifyQueueRefresh()
    await Promise.resolve()
    expect(gatewayMocks.getThreadQueueState).toHaveBeenCalledTimes(2)
    releaseOld({})
    for (let index = 0; index < 6; index++) await Promise.resolve()
    notifyQueueRefresh()
    await Promise.resolve()
    expect(gatewayMocks.getThreadQueueState).toHaveBeenCalledTimes(2)
    releaseCurrent({})
    for (let index = 0; index < 6; index++) await Promise.resolve()
    notifyQueueRefresh()
    await Promise.resolve()
    expect(gatewayMocks.getThreadQueueState).toHaveBeenCalledTimes(3)
    state.stopPolling()
  })
})

it('removes former-account approvals and recovery when changing account without stopping', async () => {
  installTestWindow()
  let notify!: (event: { method: string; params: unknown }) => void
  gatewayMocks.getPendingServerRequests.mockResolvedValue([])
  gatewayMocks.subscribeCodexNotifications.mockImplementation(handler => { notify = handler; return vi.fn() })
  const state = useDesktopState()
  state.primeSelectedThread('shared-account-thread')
  state.startPolling()
  await Promise.resolve()
  notify({ method: 'server/request', params: { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'shared-account-thread', command: ['pwd'] } } })
  notify({ method: 'modelProvider/authRecoveryStarted', params: { threadId: 'shared-account-thread', turnId: 'turn', provider: 'fixture', message: 'old recovery' } })
  expect(state.selectedThreadServerRequests.value.map(row => row.id)).toEqual([7])
  expect(state.selectedAuthRecovery.value?.message).toBe('old recovery')
  await state.refreshAll({ accountChanged: true, includeThreads: false, includeSelectedThreadMessages: false })
  expect(state.selectedThreadServerRequests.value).toEqual([])
  expect(state.selectedAuthRecovery.value).toBeNull()
  state.stopPolling()
})

describe('history read lifecycle', () => {
  const snapshot = (text: string) => ({
    messages: [{ id: text, turnId: text, role: 'assistant', text }],
    inProgress: false, activeTurnId: '', turnIndexByTurnId: { [text]: 0 }, hasMoreOlder: true,
  })

  it.each(['success', 'failure'])('isolates a stopped read and its joined caller after %s', async outcome => {
    installTestWindow()
    let releaseOld!: (value: unknown) => void
    let rejectOld!: (cause: Error) => void
    let releaseCurrent!: (value: unknown) => void
    gatewayMocks.getThreadDetail.mockReset()
    gatewayMocks.getThreadDetail
      .mockImplementationOnce(() => new Promise((resolve, reject) => { releaseOld = resolve; rejectOld = reject }))
      .mockImplementationOnce(() => new Promise(resolve => { releaseCurrent = resolve }))
    const state = useDesktopState()
    state.primeSelectedThread('history')
    const old = state.loadMessages('history')
    const joined = state.loadMessages('history')
    state.stopPolling()
    const current = state.loadMessages('history')
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(2)
    if (outcome === 'success') releaseOld(snapshot('stopped-history'))
    else rejectOld(new Error('stopped failure'))
    await Promise.all([old, joined])
    expect(state.messages.value).toEqual([])
    expect(state.selectedLiveOverlay.value).toBeNull()
    expect(state.isLoadingMessages.value).toBe(true)
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(2)
    releaseCurrent(snapshot('current-history'))
    await current
    expect(state.messages.value.map(message => message.text)).toEqual(['current-history'])
    expect(state.isLoadingMessages.value).toBe(false)
  })

  it.each(['stop', 'account'])('keeps a new older-page request loading across an old completion after %s', async transition => {
    installTestWindow()
    let releaseOld!: (value: unknown) => void
    let releaseCurrent!: (value: unknown) => void
    gatewayMocks.getThreadDetail.mockReset().mockResolvedValue(snapshot('latest'))
    gatewayMocks.getOlderThreadMessages.mockReset()
    gatewayMocks.getOlderThreadMessages
      .mockImplementationOnce(() => new Promise(resolve => { releaseOld = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { releaseCurrent = resolve }))
    const state = useDesktopState()
    state.primeSelectedThread('history')
    await state.loadMessages('history')
    const old = state.loadOlderMessages('history')
    if (transition === 'stop') {
      state.stopPolling()
      await state.loadMessages('history')
    } else {
      await state.refreshAll({ accountChanged: true, includeThreads: false, includeSelectedThreadMessages: false })
    }
    const current = state.loadOlderMessages('history')
    expect(gatewayMocks.getOlderThreadMessages).toHaveBeenCalledTimes(2)
    releaseOld(snapshot('stale-older'))
    await old
    expect(state.isLoadingOlderMessages.value).toBe(true)
    expect(state.messages.value.some(message => message.text === 'stale-older')).toBe(false)
    releaseCurrent({ ...snapshot('current-older'), hasMoreOlder: false })
    await current
    expect(state.messages.value.some(message => message.text === 'current-older')).toBe(true)
    expect(state.isLoadingOlderMessages.value).toBe(false)
    expect(state.hasMoreOlderMessages.value).toBe(false)
  })
})

describe('thread list and refresh lifecycle', () => {
  it('ignores a notification callback retained after unsubscribe', () => {
    installTestWindow()
    let notify!: (notification: { method: string; params: unknown }) => void
    gatewayMocks.subscribeCodexNotifications.mockImplementation(handler => { notify = handler; return vi.fn() })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    const state = useDesktopState()
    state.primeSelectedThread('stopped')
    state.startPolling()
    state.stopPolling()
    notify({ method: 'item/agentMessage/delta', params: { threadId: 'stopped', itemId: 'late-message', delta: 'after unsubscribe' } })
    expect(state.messages.value).toEqual([])
  })

  it('does not follow a stopped event list read with a new history read', async () => {
    installTestWindow()
    const timers: Array<() => void> = []
    vi.mocked(window.setTimeout).mockImplementation(((callback: () => void, delay: number) => {
      if (delay === 220) timers.push(callback)
      return timers.length
    }) as typeof window.setTimeout)
    let notify!: (notification: { method: string; params: unknown }) => void
    gatewayMocks.subscribeCodexNotifications.mockImplementation(handler => { notify = handler; return vi.fn() })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    let release!: (value: unknown) => void
    gatewayMocks.getThreadGroupsPage.mockReset().mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    gatewayMocks.getThreadDetail.mockReset()
    const state = useDesktopState()
    state.primeSelectedThread('stopped')
    state.startPolling()
    notify({ method: 'turn/completed', params: { threadId: 'stopped', turn: { id: 'completed-turn', status: 'completed' } } })
    timers[0]()
    await vi.waitFor(() => expect(typeof release).toBe('function'))
    state.stopPolling()
    release({ groups: [], nextCursor: null })
    await vi.waitFor(() => expect(state.isLoadingThreads.value).toBe(false))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(gatewayMocks.resumeThread).not.toHaveBeenCalled()
    expect(state.messages.value).toEqual([])
  })

  it('keeps the restarted event sync busy while the stopped sync finishes', async () => {
    installTestWindow()
    const timers: Array<() => void> = []
    vi.mocked(window.setTimeout).mockImplementation(((callback: () => void, delay: number) => {
      if (delay === 220) timers.push(callback)
      return timers.length
    }) as typeof window.setTimeout)
    const notifications: Array<(notification: { method: string; params: unknown }) => void> = []
    gatewayMocks.subscribeCodexNotifications.mockImplementation(handler => { notifications.push(handler); return vi.fn() })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    let releaseOld!: (value: unknown) => void
    let releaseCurrent!: (value: unknown) => void
    gatewayMocks.getThreadGroupsPage.mockReset()
      .mockImplementationOnce(() => new Promise(resolve => { releaseOld = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { releaseCurrent = resolve }))
    gatewayMocks.getThreadDetail.mockReset().mockResolvedValue({ messages: [], inProgress: false, activeTurnId: '', turnIndexByTurnId: {} })
    const state = useDesktopState()
    state.primeSelectedThread('history')
    const completed = (id: string) => ({ method: 'turn/completed', params: { threadId: 'history', turn: { id, status: 'completed' } } })
    state.startPolling()
    notifications[0](completed('old-turn'))
    timers[0]()
    await vi.waitFor(() => expect(typeof releaseOld).toBe('function'))
    state.stopPolling()
    state.startPolling()
    notifications[1](completed('current-turn'))
    timers[1]()
    await vi.waitFor(() => expect(typeof releaseCurrent).toBe('function'))
    releaseOld({ groups: [], nextCursor: null })
    await new Promise(resolve => setTimeout(resolve, 20))
    notifications[1](completed('newer-turn'))
    expect(timers).toHaveLength(2)
    expect(gatewayMocks.resumeThread).not.toHaveBeenCalled()
    releaseCurrent({ groups: [], nextCursor: null })
    await vi.waitFor(() => expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(1))
    state.stopPolling()
  })

  it.each(['success', 'failure'])('discards a stopped first-page %s without starting follow-up history or metadata work', async outcome => {
    installTestWindow()
    let release!: (value: unknown) => void
    let reject!: (cause: Error) => void
    gatewayMocks.getThreadGroupsPage.mockReset().mockImplementationOnce(() => new Promise((resolve, fail) => { release = resolve; reject = fail }))
    gatewayMocks.getThreadDetail.mockReset().mockResolvedValue({ messages: [], inProgress: false, activeTurnId: '', turnIndexByTurnId: {} })
    gatewayMocks.getAvailableModelIds.mockReset().mockResolvedValue([])
    const state = useDesktopState()
    state.primeSelectedThread('stopped')
    const old = state.refreshAll({ awaitAncillaryRefreshes: true })
    await vi.waitFor(() => expect(typeof release).toBe('function'))
    state.stopPolling()
    if (outcome === 'success') release({ groups: [{ projectName: 'old', threads: [thread('stopped', '/old')] }], nextCursor: 'late-page' })
    else reject(new Error('stopped list failure'))
    await old
    expect(state.projectGroups.value).toEqual([])
    expect(state.error.value).toBe('')
    expect(gatewayMocks.resumeThread).not.toHaveBeenCalled()
    expect(gatewayMocks.getAvailableModelIds).not.toHaveBeenCalled()
    expect(state.isLoadingThreads.value).toBe(false)
  })

  it('starts a fresh list immediately after stop and keeps its loading indicator during the old completion', async () => {
    installTestWindow()
    let releaseOld!: (value: unknown) => void
    let releaseCurrent!: (value: unknown) => void
    gatewayMocks.getThreadGroupsPage.mockReset()
      .mockImplementationOnce(() => new Promise(resolve => { releaseOld = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { releaseCurrent = resolve }))
    const state = useDesktopState()
    const old = state.refreshAll({ includeSelectedThreadMessages: false })
    await vi.waitFor(() => expect(typeof releaseOld).toBe('function'))
    state.stopPolling()
    const current = state.refreshAll({ includeSelectedThreadMessages: false, forceThreadRefresh: true })
    await vi.waitFor(() => expect(gatewayMocks.getThreadGroupsPage).toHaveBeenCalledTimes(2))
    releaseOld({ groups: [{ projectName: 'old', threads: [thread('old', '/old')] }], nextCursor: null })
    await old
    expect(state.projectGroups.value).toEqual([])
    expect(state.isLoadingThreads.value).toBe(true)
    releaseCurrent({ groups: [{ projectName: 'current', threads: [thread('current', '/current')] }], nextCursor: null })
    await current
    expect(state.projectGroups.value.flatMap(group => group.threads).map(row => row.id)).toEqual(['current'])
    expect(state.isLoadingThreads.value).toBe(false)
  })
})

it('restarts a joined history request with the current account context', async () => {
  installTestWindow()
  let releaseOld!: (value: unknown) => void
  const snapshot = (text: string) => ({
    model: 'model', modelProvider: 'openai', messages: [{ id: text, role: 'assistant', text }],
    inProgress: false, activeTurnId: '', turnIndexByTurnId: {}, hasMoreOlder: false,
  })
  gatewayMocks.getThreadDetail.mockReset()
  gatewayMocks.getThreadDetail
    .mockImplementationOnce(() => new Promise(resolve => { releaseOld = resolve }))
    .mockResolvedValue(snapshot('current-history'))
  const state = useDesktopState()
  state.primeSelectedThread('history')
  const first = state.loadMessages('history')
  const joined = state.loadMessages('history')
  await state.refreshAll({ accountChanged: true, includeThreads: false, includeSelectedThreadMessages: false })
  releaseOld(snapshot('previous-history'))
  await Promise.all([first, joined])
  expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(2)
  expect(state.messages.value.some(message => message.text === 'current-history')).toBe(true)
  expect(state.messages.value.some(message => message.text === 'previous-history')).toBe(false)
  expect(state.isLoadingMessages.value).toBe(false)
})

it('loads older project conversations while first-page conversations remain active', async () => {
  installTestWindow()
  const timers: Array<{ callback: () => void; delay: number }> = []
  vi.mocked(window.setTimeout).mockImplementation(((callback: () => void, delay: number) => {
    timers.push({ callback, delay })
    return timers.length
  }) as typeof window.setTimeout)
  gatewayMocks.getThreadGroupsPage.mockReset()
    .mockResolvedValueOnce({ groups: [{ projectName: 'current', threads: [{ ...thread('running', '/current'), inProgress: true }] }], nextCursor: 'older' })
    .mockResolvedValueOnce({ groups: [{ projectName: 'Sophos', threads: [thread('older-sophos', '/home/docker/Sophos')] }], nextCursor: 'oldest' })
    .mockResolvedValueOnce({ groups: [{ projectName: 'another', threads: [thread('oldest', '/another')] }], nextCursor: null })
  const state = useDesktopState()
  try {
    await state.refreshAll({ includeSelectedThreadMessages: false })
    expect(state.projectGroups.value.flatMap(group => group.threads).find(row => row.id === 'running')?.inProgress).toBe(true)
    expect(timers.filter(timer => timer.delay === 10000)).toHaveLength(1)
    timers.find(timer => timer.delay === 10000)!.callback()
    await vi.waitFor(() => expect(state.projectGroups.value.some(group => group.threads.some(row => row.id === 'older-sophos'))).toBe(true))
    timers.filter(timer => timer.delay === 10000).at(-1)!.callback()
    await vi.waitFor(() => expect(state.isThreadListFullyLoaded.value).toBe(true))
    expect(state.projectGroups.value.flatMap(group => group.threads).find(row => row.id === 'running')?.inProgress).toBe(true)
    expect(gatewayMocks.getThreadGroupsPage.mock.calls.map(call => call.slice(0, 2))).toEqual([[], ['older', 100], ['oldest', 100]])
  } finally {
    state.stopPolling()
  }
})

it('preserves a newer live status while committing a delayed background page', async () => {
  installTestWindow()
  const timers: Array<{ callback: () => void; delay: number }> = []
  vi.mocked(window.setTimeout).mockImplementation(((callback: () => void, delay: number) => {
    timers.push({ callback, delay })
    return timers.length
  }) as typeof window.setTimeout)
  let notify!: (notification: { method: string; params: unknown }) => void
  gatewayMocks.subscribeCodexNotifications.mockImplementation(handler => { notify = handler; return vi.fn() })
  gatewayMocks.getPendingServerRequests.mockResolvedValue([])
  let releasePage!: (page: unknown) => void
  gatewayMocks.getThreadGroupsPage.mockReset()
  gatewayMocks.getThreadGroupsPage
    .mockResolvedValueOnce({ groups: [{ projectName: 'p', threads: [thread('first', '/p')] }], nextCursor: 'page-two' })
    .mockImplementationOnce(() => new Promise(resolve => { releasePage = resolve }))
  const state = useDesktopState()
  state.startPolling()
  try {
    await state.refreshAll({ includeSelectedThreadMessages: false })
    timers.find(timer => timer.delay === 10000)!.callback()
    await vi.waitFor(() => expect(typeof releasePage).toBe('function'))
    notify({ method: 'thread/status/changed', params: { threadId: 'later', status: { type: 'inProgress' } } })
    releasePage({ groups: [{ projectName: 'p', threads: [thread('later', '/p')] }], nextCursor: null })
    await vi.waitFor(() => expect(state.isThreadListFullyLoaded.value).toBe(true))
    expect(state.projectGroups.value.flatMap(group => group.threads).find(row => row.id === 'later')?.inProgress).toBe(true)
  } finally {
    state.stopPolling()
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('filterGroupsByWorkspaceRoots', () => {
  it('keeps projectless chats visible when workspace roots are configured', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'Projectless',
        threads: [thread('projectless-chat', '')],
      },
      {
        projectName: 'allowed-project',
        threads: [thread('allowed-chat', '/tmp/allowed-project')],
      },
      {
        projectName: 'other-project',
        threads: [thread('other-chat', '/tmp/other-project')],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/allowed-project'],
      labels: {},
      active: ['/tmp/allowed-project'],
      projectOrder: [],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => group.projectName)).toEqual([
      'Projectless',
      'allowed-project',
    ])
  })

  it('keeps workspace roots with the same folder name as separate projects', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'api',
        threads: [
          thread('first-api-chat', '/tmp/first/api'),
          thread('second-api-chat', '/tmp/second/api'),
        ],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/first/api', '/tmp/second/api'],
      labels: {},
      active: ['/tmp/first/api', '/tmp/second/api'],
      projectOrder: [],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => group.projectName)).toEqual([
      '/tmp/first/api',
      '/tmp/second/api',
    ])
  })

  it('uses Codex project-order when workspace roots are hydrated', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'alpha',
        threads: [thread('alpha-chat', '/tmp/alpha')],
      },
      {
        projectName: 'beta',
        threads: [thread('beta-chat', '/tmp/beta')],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/alpha', '/tmp/beta'],
      labels: {},
      active: ['/tmp/alpha'],
      projectOrder: ['/tmp/beta', '/tmp/alpha'],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => group.projectName)).toEqual([
      'beta',
      'alpha',
    ])
  })

  it('keeps empty duplicate workspace roots visible in Codex project order', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'TestChat',
        threads: [thread('testchat-chat', '/Users/igor/temp/TestChat')],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/Users/igor/Documents/New project 2/TestChat', '/Users/igor/temp/TestChat'],
      labels: {},
      active: ['/Users/igor/Documents/New project 2/TestChat', '/Users/igor/temp/TestChat'],
      projectOrder: ['/Users/igor/Documents/New project 2/TestChat', '/Users/igor/temp/TestChat'],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => [group.projectName, group.threads.length])).toEqual([
      ['/Users/igor/Documents/New project 2/TestChat', 0],
      ['/Users/igor/temp/TestChat', 1],
    ])
  })

  it('keeps remote projects from Codex project order visible as empty project rows', () => {
    const groups: UiProjectGroup[] = []
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/local-project'],
      labels: {},
      active: ['/tmp/local-project'],
      projectOrder: ['remote-project-id', '/tmp/local-project'],
      remoteProjects: [{
        id: 'remote-project-id',
        hostId: 'remote-ssh-discovered:a1',
        remotePath: '/home/ubuntu',
        label: 'ubuntu',
      }],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => [group.projectName, group.threads.length])).toEqual([
      ['remote-project-id', 0],
      ['local-project', 0],
    ])
  })

  it('keeps managed worktree threads under the matching workspace root project', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'codex-web-local',
        threads: [
          thread('main-chat', '/Users/igor/Git-projects/codex-web-local'),
          thread('worktree-chat', '/Users/igor/.codex/worktrees/53e7/codex-web-local', { hasWorktree: true }),
        ],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/Users/igor/Git-projects/codex-web-local'],
      labels: {},
      active: ['/Users/igor/Git-projects/codex-web-local'],
      projectOrder: ['/Users/igor/Git-projects/codex-web-local'],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => [group.projectName, group.threads.map((row) => row.id)])).toEqual([
      ['codex-web-local', ['main-chat', 'worktree-chat']],
    ])
  })

  it('keeps unregistered managed worktrees under the main root when another managed worktree root is registered', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'codex-web-local',
        threads: [
          thread('main-chat', '/Users/igor/Git-projects/codex-web-local'),
          thread('registered-worktree-chat', '/Users/igor/.codex/worktrees/a77f/codex-web-local', { hasWorktree: true }),
          thread('unregistered-worktree-chat', '/Users/igor/.codex/worktrees/53e7/codex-web-local', { hasWorktree: true }),
        ],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: [
        '/Users/igor/Git-projects/codex-web-local',
        '/Users/igor/.codex/worktrees/a77f/codex-web-local',
      ],
      labels: {
        '/Users/igor/.codex/worktrees/a77f/codex-web-local': 'codex-web-local2',
      },
      active: ['/Users/igor/Git-projects/codex-web-local'],
      projectOrder: ['/Users/igor/Git-projects/codex-web-local'],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => [group.projectName, group.threads.map((row) => row.id)])).toEqual([
      ['/Users/igor/Git-projects/codex-web-local', ['main-chat', 'unregistered-worktree-chat']],
      ['/Users/igor/.codex/worktrees/a77f/codex-web-local', ['registered-worktree-chat']],
    ])
  })

  it('does not group unrelated git worktrees under a same-leaf workspace root project', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'codex-web-local',
        threads: [
          thread('main-chat', '/Users/igor/Git-projects/codex-web-local'),
          thread('other-git-worktree-chat', '/tmp/other/.git/worktrees/codex-web-local', { hasWorktree: true }),
        ],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/Users/igor/Git-projects/codex-web-local'],
      labels: {},
      active: ['/Users/igor/Git-projects/codex-web-local'],
      projectOrder: ['/Users/igor/Git-projects/codex-web-local'],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => [group.projectName, group.threads.map((row) => row.id)])).toEqual([
      ['/Users/igor/Git-projects/codex-web-local', ['main-chat']],
    ])
  })
})

describe('removeThreadFromGroups', () => {
  it('removes an archived thread and drops the now-empty project group', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'alpha',
        threads: [thread('keep-alpha', '/tmp/alpha')],
      },
      {
        projectName: 'archived-project',
        threads: [thread('archive-me', '/tmp/archived-project')],
      },
      {
        projectName: 'beta',
        threads: [thread('keep-beta', '/tmp/beta')],
      },
      {
        projectName: 'empty-workspace-root',
        threads: [],
      },
    ]

    expect(removeThreadFromGroups(groups, 'archive-me').map((group) => [
      group.projectName,
      group.threads.map((row) => row.id),
    ])).toEqual([
      ['alpha', ['keep-alpha']],
      ['beta', ['keep-beta']],
      ['empty-workspace-root', []],
    ])
  })

  it('preserves referential identity when the thread is absent', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'alpha',
        threads: [thread('keep-alpha', '/tmp/alpha')],
      },
    ]

    expect(removeThreadFromGroups(groups, 'missing-thread')).toBe(groups)
  })
})

describe('workspace roots project persistence helpers', () => {
  it('collects duplicate-path project roots by full path when removing a project', () => {
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/first/api', '/tmp/second/api'],
      labels: {
        '/tmp/first/api': 'First API',
        '/tmp/second/api': 'Second API',
      },
      active: ['/tmp/first/api'],
      projectOrder: ['/tmp/first/api', '/tmp/second/api'],
    }

    expect([...collectWorkspaceRootPathsForProjectRemoval(rootsState, '/tmp/first/api')]).toEqual([
      '/tmp/first/api',
    ])
  })

  it('preserves remote project ids in explicit project order when persisting workspace roots', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'local-project',
        threads: [thread('local-chat', '/tmp/local-project')],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/local-project'],
      labels: {},
      active: ['/tmp/local-project'],
      projectOrder: ['remote-project-id', '/tmp/local-project'],
      remoteProjects: [{
        id: 'remote-project-id',
        hostId: 'remote-ssh-discovered:a1',
        remotePath: '/home/ubuntu',
        label: 'ubuntu',
      }],
    }

    expect(buildWorkspaceRootsProjectOrderState(rootsState, ['remote-project-id', 'local-project'], groups)).toEqual({
      order: ['/tmp/local-project'],
      active: ['/tmp/local-project'],
      projectOrder: ['remote-project-id', '/tmp/local-project'],
    })
  })
})

describe('collaboration mode selection', () => {
  it('can prime an empty selected thread without clearing persisted selection', () => {
    installTestWindow({
      'codex-web-local.selected-thread-id.v1': 'thread-a',
    })

    const state = useDesktopState()

    expect(state.selectedThreadId.value).toBe('thread-a')

    state.primeSelectedThread('', { persist: false })

    expect(state.selectedThreadId.value).toBe('')
    expect(window.localStorage.getItem('codex-web-local.selected-thread-id.v1')).toBe('thread-a')
  })

  it('does not carry plan mode from new chats into existing threads', () => {
    installTestWindow({
      'codex-web-local.collaboration-mode.v1': 'plan',
    })

    const state = useDesktopState()

    expect(state.selectedCollaborationMode.value).toBe('default')

    state.setSelectedCollaborationMode('plan')

    expect(state.selectedCollaborationMode.value).toBe('plan')
    expect(window.localStorage.getItem('codex-web-local.collaboration-mode-by-context.v1')).toBe(null)

    state.primeSelectedThread('thread-a')

    expect(state.selectedCollaborationMode.value).toBe('default')

    state.setSelectedCollaborationMode('plan')
    state.primeSelectedThread('thread-b')

    expect(state.selectedCollaborationMode.value).toBe('default')

    state.primeSelectedThread('thread-a')

    expect(state.selectedCollaborationMode.value).toBe('plan')
  })
})

describe('Codex CLI availability', () => {
  it('surfaces a chat runtime error when the app-server bridge cannot find Codex CLI', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockRejectedValue(new Error('Codex CLI is not available. Install @openai/codex or set CODEXUI_CODEX_COMMAND.'))

    const state = useDesktopState()

    await state.refreshAll({ awaitAncillaryRefreshes: true })

    expect(state.codexCliMissingError.value).toBe('Codex CLI not found. Install @openai/codex or set CODEXUI_CODEX_COMMAND.')
  })

  it('clears a previous Codex CLI missing banner when a later refresh fails for another reason', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage
      .mockRejectedValueOnce(new Error('Codex CLI is not available. Install @openai/codex or set CODEXUI_CODEX_COMMAND.'))
      .mockRejectedValueOnce(new Error('Connection lost'))

    const state = useDesktopState()

    await state.refreshAll({ awaitAncillaryRefreshes: true })
    expect(state.codexCliMissingError.value).toBe('Codex CLI not found. Install @openai/codex or set CODEXUI_CODEX_COMMAND.')

    await state.refreshAll({ awaitAncillaryRefreshes: true })
    expect(state.error.value).toBe('Connection lost')
    expect(state.codexCliMissingError.value).toBe('')
  })

})

describe('startup request deduplication', () => {
  it('reloads cached thread titles on forced thread refresh', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-1', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getThreadTitleCache
      .mockResolvedValueOnce({ titles: {} })
      .mockResolvedValueOnce({ titles: { 'thread-1': 'Imported title' } })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false })
    expect(state.projectGroups.value[0]?.threads[0]?.title).toBe('thread-1')

    await state.refreshAll({ includeSelectedThreadMessages: false, forceThreadRefresh: true })

    expect(gatewayMocks.getThreadTitleCache).toHaveBeenCalledTimes(2)
    expect(state.projectGroups.value[0]?.threads[0]?.title).toBe('Imported title')
  })

  it('reuses a just-loaded thread list during startup refresh bursts', async () => {
    installTestWindow()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-1', '/tmp/project')] }],
      nextCursor: null,
    })

    try {
      const state = useDesktopState()
      await state.refreshAll({ includeSelectedThreadMessages: false })
      await state.refreshAll({ includeSelectedThreadMessages: false })

      expect(gatewayMocks.getThreadGroupsPage).toHaveBeenCalledTimes(1)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('reuses a just-loaded skills list for the same selected cwd', async () => {
    installTestWindow()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-1', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([
      {
        name: 'example',
        description: 'Example skill',
        path: '/tmp/project/.agents/skills/example/SKILL.md',
        scope: 'project',
        enabled: true,
      },
    ])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: '',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue([])

    try {
      const state = useDesktopState()
      state.primeSelectedThread('thread-1')
      await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
      await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

      expect(gatewayMocks.getSkillsList).toHaveBeenCalledTimes(1)
      expect(gatewayMocks.getSkillsList).toHaveBeenCalledWith(['/tmp/project'])
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('reuses a just-loaded empty skills list for the same selected cwd', async () => {
    installTestWindow()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-1', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: '',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue([])

    try {
      const state = useDesktopState()
      state.primeSelectedThread('thread-1')
      await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
      await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

      expect(gatewayMocks.getSkillsList).toHaveBeenCalledTimes(1)
      expect(state.installedSkills.value).toEqual([])
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('bypasses recent thread-list reuse for event-driven thread refreshes', async () => {
    installTestWindow()
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler) => {
      if (typeof callback === 'function') {
        void Promise.resolve().then(() => callback())
      }
      return 1
    }) as typeof window.setTimeout)
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-1', '/tmp/project')] }],
      nextCursor: null,
    })

    try {
      const state = useDesktopState()
      await state.refreshAll({ includeSelectedThreadMessages: false })
      const callsBeforeNotification = gatewayMocks.getThreadGroupsPage.mock.calls.length
      state.startPolling()
      expect(notificationHandler).toBeDefined()
      notificationHandler!({
        method: 'thread/name/updated',
        params: {
          threadId: 'thread-1',
          threadName: 'Updated title',
        },
      })
      await Promise.resolve()
      await Promise.resolve()

      expect(gatewayMocks.getThreadGroupsPage.mock.calls.length).toBeGreaterThan(callsBeforeNotification)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('does not issue a second initial thread-list request while initial refresh is loading', async () => {
    installTestWindow()
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler) => {
      if (typeof callback === 'function') {
        void Promise.resolve().then(() => callback())
      }
      return 1
    }) as typeof window.setTimeout)
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    let releaseThreadList: ((value: { groups: UiProjectGroup[]; nextCursor: string | null }) => void) | undefined
    gatewayMocks.getThreadGroupsPage.mockReturnValue(new Promise(resolve => {
      releaseThreadList = resolve
    }))
    gatewayMocks.getWorkspaceRootsState.mockResolvedValue({
      order: [],
      labels: {},
      active: [],
      projectOrder: [],
      remoteProjects: [],
      virtualProjects: [],
    } satisfies WorkspaceRootsState)

    const state = useDesktopState()
    state.primeSelectedThread('thread-1')
    const initialRefresh = state.refreshAll({ includeSelectedThreadMessages: true, awaitAncillaryRefreshes: false })
    state.startPolling()
    notificationHandler?.({ method: 'ready', params: { ok: true } })

    await Promise.resolve()
    await Promise.resolve()
    expect(gatewayMocks.getThreadGroupsPage).toHaveBeenCalledTimes(1)

    releaseThreadList?.({
      groups: [{ projectName: 'Project', threads: [thread('thread-1', '/tmp/project')] }],
      nextCursor: null,
    })
    await initialRefresh
    await vi.waitFor(() => expect(state.isLoadingThreads.value).toBe(false))
    expect(gatewayMocks.getThreadGroupsPage).toHaveBeenCalledTimes(1)
    expect(state.isThreadListFullyLoaded.value).toBe(true)
  })

  it('does not refresh the whole thread list for high-frequency thread status events', async () => {
    installTestWindow()
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler) => {
      if (typeof callback === 'function') {
        void Promise.resolve().then(() => callback())
      }
      return 1
    }) as typeof window.setTimeout)
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    const state = useDesktopState()
    state.startPolling()
    notificationHandler?.({ method: 'thread/status/changed', params: { threadId: 'thread-1', status: 'active' } })
    await Promise.resolve()
    await Promise.resolve()
    expect(gatewayMocks.getThreadGroupsPage).not.toHaveBeenCalled()
    state.stopPolling()
  })
})

describe('live error overlay', () => {
  it('shows the default thinking overlay while a selected thread is in progress without activity events', async () => {
    installTestWindow()
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.resumeThread.mockResolvedValue(null)
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [
        {
          id: 'user-1',
          role: 'user',
          text: 'create todo list app',
          messageType: 'userMessage',
        },
      ],
      inProgress: true,
      activeTurnId: 'turn-1',
      turnIndexByTurnId: {},
      hasMoreOlder: false,
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-thinking')
    await state.loadMessages('thread-thinking')

    expect(state.selectedLiveOverlay.value).toMatchObject({
      activityLabel: 'Thinking',
      reasoningText: '',
      errorText: '',
    })
  })

  it('keeps a new live error visible when an older persisted turn error exists', async () => {
    installTestWindow()
    let notificationHandler: (notification: { method: string; params?: unknown }) => void = () => {}
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.resumeThread.mockResolvedValue(null)
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [
        {
          id: 'old-error',
          role: 'system',
          text: 'old persisted failure',
          messageType: 'turnError',
        },
      ],
      inProgress: false,
      activeTurnId: '',
      turnIndexByTurnId: {},
      hasMoreOlder: false,
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-with-errors')
    await state.loadMessages('thread-with-errors')
    state.startPolling()

    notificationHandler?.({
      method: 'turn/completed',
      params: {
        threadId: 'thread-with-errors',
        turnId: 'new-turn',
        turn: {
          id: 'new-turn',
          status: 'failed',
          error: { message: 'new live failure' },
        },
      },
    })

    expect(state.selectedLiveOverlay.value?.errorText).toBe('new live failure')
  })

  it('suppresses a live error only after that same error has persisted', async () => {
    installTestWindow()
    let notificationHandler: (notification: { method: string; params?: unknown }) => void = () => {}
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.resumeThread.mockResolvedValue(null)
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [
        {
          id: 'persisted-error',
          role: 'system',
          text: 'same failure',
          messageType: 'turnError',
        },
      ],
      inProgress: false,
      activeTurnId: '',
      turnIndexByTurnId: {},
      hasMoreOlder: false,
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-with-persisted-error')
    await state.loadMessages('thread-with-persisted-error')
    state.startPolling()

    notificationHandler?.({
      method: 'turn/completed',
      params: {
        threadId: 'thread-with-persisted-error',
        turnId: 'same-turn',
        turn: {
          id: 'same-turn',
          status: 'failed',
          error: { message: 'same failure' },
        },
      },
    })

    expect(state.selectedLiveOverlay.value).toBe(null)
  })
})

describe('provider model selection', () => {
  it('ignores global selected-model localStorage when OpenCode Zen is the active provider', async () => {
    installTestWindow({
      'codex-web-local.selected-model-by-context.v1': JSON.stringify({
        '__new-thread__': 'gpt-5.5',
      }),
      'codex-web-local.selected-model-id.v1': 'gpt-5.5',
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'big-pickle',
      providerId: 'opencode-zen',
      reasoningEffort: 'medium',
      speedMode: '',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue([
      'big-pickle',
      'deepseek-v4-flash-free',
      'ring-2.6-1t-free',
    ])

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(gatewayMocks.getAvailableModelIds).toHaveBeenCalledWith({
      includeProviderModels: true,
      requireProviderModels: true,
      providerId: 'opencode-zen',
    })
    expect(state.availableModelIds.value).toEqual([
      'big-pickle',
      'deepseek-v4-flash-free',
      'ring-2.6-1t-free',
    ])
    expect(state.selectedModelId.value).toBe('big-pickle')
    expect(state.readModelIdForThread('').trim()).toBe('big-pickle')
    expect(JSON.parse(window.localStorage.getItem('codex-web-local.selected-model-by-context.v1') ?? '{}')).toEqual({
      '__new-thread-provider__::opencode-zen': 'big-pickle',
    })
    expect(window.localStorage.getItem('codex-web-local.selected-model-id.v1')).toBe(null)
  })

  it('restores a valid provider-scoped OpenCode Zen selected model from localStorage', async () => {
    installTestWindow({
      'codex-web-local.selected-model-by-context.v1': JSON.stringify({
        '__new-thread-provider__::opencode-zen': 'ring-2.6-1t-free',
      }),
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'big-pickle',
      providerId: 'opencode-zen',
      reasoningEffort: 'medium',
      speedMode: '',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue([
      'big-pickle',
      'deepseek-v4-flash-free',
      'ring-2.6-1t-free',
    ])

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(state.availableModelIds.value).toEqual([
      'big-pickle',
      'deepseek-v4-flash-free',
      'ring-2.6-1t-free',
    ])
    expect(state.selectedModelId.value).toBe('ring-2.6-1t-free')
    expect(state.readModelIdForThread('').trim()).toBe('ring-2.6-1t-free')
    expect(JSON.parse(window.localStorage.getItem('codex-web-local.selected-model-by-context.v1') ?? '{}')).toEqual({
      '__new-thread-provider__::opencode-zen': 'ring-2.6-1t-free',
    })
  })

  it('keeps a provider-scoped custom model during a same-provider catalog refresh', async () => {
    installTestWindow({
      'codex-web-local.selected-model-by-context.v1': JSON.stringify({
        '__new-thread-provider__::custom': 'custom-beta',
      }),
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'custom-alpha',
      providerId: 'custom',
      reasoningEffort: 'medium',
      speedMode: '',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue(['custom-alpha', 'custom-beta'])

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(gatewayMocks.getAvailableModelIds).toHaveBeenLastCalledWith({
      includeProviderModels: true,
      requireProviderModels: true,
      providerId: 'custom',
    })
    expect(state.selectedModelId.value).toBe('custom-beta')
    expect(state.readModelIdForThread('')).toBe('custom-beta')
  })

  it('stores the new-thread Codex model in a provider-scoped slot', async () => {
    installTestWindow({
      'codex-web-local.selected-model-by-context.v1': JSON.stringify({
        '__new-thread-provider__::openrouter-free': 'openrouter/free',
      }),
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: '',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue([
      'gpt-5.5',
      'gpt-5.4-mini',
    ])

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(state.selectedModelId.value).toBe('gpt-5.5')
    expect(state.readModelIdForThread('').trim()).toBe('gpt-5.5')
    expect(JSON.parse(window.localStorage.getItem('codex-web-local.selected-model-by-context.v1') ?? '{}')).toEqual({
      '__new-thread-provider__::openrouter-free': 'openrouter/free',
      '__new-thread-provider__::codex': 'gpt-5.5',
    })
  })

  it('drops stale non-Codex selected models from the Codex model list', async () => {
    installTestWindow({
      'codex-web-local.selected-model-by-context.v1': JSON.stringify({
        '__new-thread-provider__::codex': 'big-pickle',
      }),
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: '',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue([
      'gpt-5.5',
      'gpt-5.4-mini',
    ])

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(state.availableModelIds.value).toEqual([
      'gpt-5.5',
      'gpt-5.4-mini',
    ])
    expect(state.availableModelIds.value).not.toContain('big-pickle')
    expect(state.selectedModelId.value).toBe('gpt-5.5')
    expect(state.readModelIdForThread('').trim()).toBe('gpt-5.5')
    expect(JSON.parse(window.localStorage.getItem('codex-web-local.selected-model-by-context.v1') ?? '{}')).toEqual({
      '__new-thread-provider__::codex': 'gpt-5.5',
    })
  })

  it('keeps an existing OpenCode Zen thread locked to Zen models after Codex auth becomes active', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('legacy-zen-thread', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.4-mini',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: '',
    })
    gatewayMocks.getAvailableModelIds.mockImplementation(async (options?: { providerId?: string }) => {
      if (options?.providerId === 'opencode-zen') {
        return ['big-pickle', 'ring-2.6-1t-free']
      }
      return ['gpt-5.5', 'gpt-5.4-mini']
    })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.4-mini',
      modelProvider: 'opencode_zen',
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    state.primeSelectedThread('legacy-zen-thread')
    await state.loadMessages('legacy-zen-thread')
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(gatewayMocks.getAvailableModelIds).toHaveBeenLastCalledWith({
      includeProviderModels: true,
      requireProviderModels: true,
      providerId: 'opencode-zen',
    })
    expect(state.availableModelIds.value).toEqual([
      'big-pickle',
      'ring-2.6-1t-free',
    ])
    expect(state.selectedModelId.value).toBe('big-pickle')
    expect(state.readModelIdForThread('legacy-zen-thread')).toBe('big-pickle')
    expect(state.readModelIdForThread('')).toBe('gpt-5.4-mini')
  })

  it('rebinds the pending new conversation to the active connection after switching providers', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.6-sol',
      providerId: 'codex',
      reasoningEffort: 'high',
      speedMode: '',
    })
    gatewayMocks.getAvailableModelIds.mockImplementation(async (options?: { providerId?: string }) => (
      options?.providerId === 'custom' ? ['custom-alpha', 'custom-beta'] : ['gpt-5.6-sol', 'gpt-5.6-luna']
    ))
    gatewayMocks.startThread.mockResolvedValue({
      threadId: 'custom-thread',
      model: 'custom-alpha',
      modelProvider: 'custom',
    })
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-1')
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'custom-alpha',
      modelProvider: 'custom',
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    state.configureWebDefaults({ model: 'gpt-5.6-sol', provider: 'codex', effort: 'high', tier: '' }, true)
    state.primeSelectedThread('')
    state.initializeWebConversation('')
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
    expect(state.webDefaultsProvider.value).toBe('codex')
    expect(state.selectedModelId.value).toBe('gpt-5.6-sol')

    // Switch the connection without touching the model picker.
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'custom-alpha',
      providerId: 'custom',
      reasoningEffort: 'medium',
      speedMode: '',
    })
    await state.refreshAll({ includeSelectedThreadMessages: false, providerChanged: true, awaitAncillaryRefreshes: true })

    expect(state.webDefaultsProvider.value).toBe('custom')
    expect(state.availableModelIds.value).toEqual(['custom-alpha', 'custom-beta'])
    expect(state.selectedModelId.value).toBe('custom-alpha')
    expect(state.readModelIdForThread('')).toBe('custom-alpha')
    // The saved default choice is intent, not a source binding, so it is left untouched.
    expect(state.webPreferenceState.value.defaults).toEqual({
      model: 'gpt-5.6-sol',
      provider: 'codex',
      effort: 'high',
      tier: '',
    })
    expect(state.webPreferenceState.value.threads).toEqual({})

    await state.sendMessageToNewThread('hi', '/tmp/project')
    expect(gatewayMocks.startThread).toHaveBeenCalledWith('/tmp/project', 'custom-alpha')
    state.stopPolling()
  })

  it('gives attachment-only new threads a readable title and persists it', async () => {
    installTestWindow()
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.startThread.mockResolvedValue({ threadId: 'image-thread', model: 'gpt-5.6-sol', modelProvider: 'codex' })
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-1')
    const state = useDesktopState()
    state.primeSelectedThread('')

    // Image-only send: the stored first user message must be non-empty
    // (empty first_user_message threads are omitted from thread/list) and
    // the sidebar title falls back to the attachment-derived label.
    await state.sendMessageToNewThread('', '/tmp/project', ['blob:http://localhost/upload-1'])
    const imageThread = state.projectGroups.value.flatMap(group => group.threads).find(thread => thread.id === 'image-thread')
    expect(imageThread?.title).toBe('[Image]')
    expect(gatewayMocks.startThreadTurn).toHaveBeenCalledTimes(1)
    // The placeholder lives in the gateway turn payload (covered in codexGateway.test.ts);
    // at this layer the send keeps the raw empty text while the title is synthesized.
    expect(gatewayMocks.startThreadTurn.mock.calls[0]![1]).toBe('')
    expect(gatewayMocks.persistThreadTitle).toHaveBeenCalledWith('image-thread', '[Image]')

    // Text-file-only send: the title is the first attachment label.
    gatewayMocks.startThread.mockResolvedValue({ threadId: 'file-thread', model: 'gpt-5.6-sol', modelProvider: 'codex' })
    await state.sendMessageToNewThread('', '/tmp/project', [], [], [{ label: 'notes.txt', path: '/tmp/notes.txt', fsPath: '/tmp/notes.txt' }])
    const fileThread = state.projectGroups.value.flatMap(group => group.threads).find(thread => thread.id === 'file-thread')
    expect(fileThread?.title).toBe('notes.txt')
    expect(gatewayMocks.persistThreadTitle).toHaveBeenCalledWith('file-thread', 'notes.txt')
    state.stopPolling()
  })

  it('keeps a saved per-conversation source intact when the connection changes', async () => {
    installTestWindow({
      'codexapp.web-conversation-preferences.v1': JSON.stringify({
        defaults: null,
        remember: true,
        threads: {
          'openai-thread': {
            source: 'web',
            saved: { model: 'gpt-5.6-sol', provider: 'codex', effort: 'high', tier: '' },
          },
        },
      }),
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'custom-alpha',
      providerId: 'custom',
      reasoningEffort: 'medium',
      speedMode: '',
    })
    gatewayMocks.getAvailableModelIds.mockImplementation(async (options?: { providerId?: string }) => (
      options?.providerId === 'custom' ? ['custom-alpha'] : ['gpt-5.6-sol']
    ))
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.6-sol',
      modelProvider: 'openai',
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    state.primeSelectedThread('openai-thread')
    await state.loadMessages('openai-thread')
    await state.refreshAll({ includeSelectedThreadMessages: false, providerChanged: true, awaitAncillaryRefreshes: true })

    expect(state.webDefaultsProvider.value).toBe('codex')
    expect(state.selectedModelId.value).toBe('gpt-5.6-sol')
    expect(state.webPreferenceState.value.threads['openai-thread'].saved.provider).toBe('codex')
    state.stopPolling()
  })

  it('adopts the live connection for a conversation whose saved source is no longer running', async () => {
    installTestWindow({
      'codexapp.web-conversation-preferences.v1': JSON.stringify({
        defaults: null,
        remember: true,
        threads: {
          'openai-thread': {
            source: 'web',
            saved: { model: 'gpt-5.6-sol', provider: 'codex', effort: 'high', tier: '' },
          },
        },
      }),
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    // Another browser moved the active connection, which the single running app-server binds a
    // resumed conversation to. The saved source can no longer serve the conversation.
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'custom-alpha',
      providerId: 'custom',
      reasoningEffort: 'medium',
      speedMode: '',
    })
    gatewayMocks.getAvailableModelIds.mockImplementation(async (options?: { providerId?: string }) => (
      options?.providerId === 'custom' ? ['custom-alpha', 'custom-beta'] : ['gpt-5.6-sol']
    ))
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'custom-alpha',
      modelProvider: 'custom',
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-1')

    const state = useDesktopState()
    state.primeSelectedThread('openai-thread')
    await state.loadMessages('openai-thread')
    await state.refreshAll({ includeSelectedThreadMessages: false, providerChanged: true, awaitAncillaryRefreshes: true })
    expect(state.webDefaultsProvider.value).toBe('custom')

    await expect(state.sendMessageToSelectedThread('继续用新连接')).resolves.toBeUndefined()
    expect(gatewayMocks.startThreadTurn).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.startThreadTurn.mock.calls[0]![3]).toBe('custom-alpha')
    // The saved choice stays as this conversation's own intent instead of being overwritten.
    expect(state.webPreferenceState.value.threads['openai-thread'].saved.provider).toBe('codex')
    state.stopPolling()
  })

  it('keeps the live conversation source when a later read reports the source stored in the rollout', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValueOnce({
      groups: [{ projectName: 'Project', threads: [thread('thread-1', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'custom-alpha',
      providerId: 'custom',
      reasoningEffort: 'medium',
      speedMode: '',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue(['custom-alpha'])
    gatewayMocks.resumeThread.mockResolvedValue({
      model: 'custom-alpha',
      modelProvider: 'custom',
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })
    // thread/read reports the source written into the rollout, not the live binding.
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.6-sol',
      modelProvider: 'codex',
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-1')
    await state.loadMessages('thread-1')
    expect(state.webDefaultsProvider.value).toBe('codex')
    expect(gatewayMocks.resumeThread).not.toHaveBeenCalled()
    gatewayMocks.startThreadTurn.mockResolvedValue('live-turn')
    await state.sendMessageToSelectedThread('continue')
    expect(state.webDefaultsProvider.value).toBe('custom')

    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000)
    try {
      gatewayMocks.getThreadGroupsPage.mockResolvedValue({
        groups: [{ projectName: 'Project', threads: [{ ...thread('thread-1', '/tmp/project'), updatedAtIso: '2026-04-29T00:00:00.000Z' }] }],
        nextCursor: null,
      })
      await state.refreshAll({ includeSelectedThreadMessages: true, forceThreadRefresh: true })
    } finally {
      clock.mockRestore()
    }
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(3)
    expect(state.webDefaultsProvider.value).toBe('custom')
    state.stopPolling()
  })

  it('loads provider models for a selected provider-backed thread during scheduled refreshes', async () => {
    installTestWindow()
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler) => {
      if (typeof callback === 'function') {
        void Promise.resolve().then(() => callback())
      }
      return 1
    }) as typeof window.setTimeout)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('legacy-zen-thread', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.4-mini',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: '',
    })
    gatewayMocks.getAvailableModelIds.mockImplementation(async (options?: { providerId?: string }) => {
      if (options?.providerId === 'opencode-zen') {
        return ['big-pickle', 'ring-2.6-1t-free']
      }
      return ['gpt-5.5', 'gpt-5.4-mini']
    })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.4-mini',
      modelProvider: 'opencode_zen',
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    state.primeSelectedThread('legacy-zen-thread')
    await state.loadMessages('legacy-zen-thread')
    await state.refreshAll({ includeSelectedThreadMessages: false })
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))

    expect(gatewayMocks.getAvailableModelIds).toHaveBeenLastCalledWith({
      includeProviderModels: true,
      requireProviderModels: true,
      providerId: 'opencode-zen',
    })
    expect(state.availableModelIds.value).toEqual(['big-pickle', 'ring-2.6-1t-free'])
    expect(state.selectedModelId.value).toBe('big-pickle')
  })

  it.each(['accepted', 'failed'] as const)('groups a new organization conversation before the %s send settles', async (result) => {
    installTestWindow()
    const projectId = 'virtual:11111111-1111-4111-8111-111111111111'
    const cwd = '/tmp/Documents/Codex/2026-09-13/new-conversation'
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getWorkspaceRootsState.mockResolvedValue({ order: [], active: [], labels: {}, projectOrder: [projectId], virtualProjects: [{ id: projectId, label: 'Organization', cwds: [] }] })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({ model: 'gpt-5.5', providerId: '', reasoningEffort: 'medium', speedMode: '' })
    gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-5.5'])
    gatewayMocks.startThread.mockResolvedValue({ threadId: 'organization-new', model: 'gpt-5.5', modelProvider: 'openai' })
    let accept!: (turn: string) => void
    let reject!: (error: Error) => void
    gatewayMocks.startThreadTurn.mockImplementation(() => new Promise<string>((resolve, fail) => { accept = resolve; reject = fail }))
    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
    const sending = state.sendMessageToNewThread('hi', cwd, [], [], [], projectId)
    const settled = sending.then(value => ({ value }), error => ({ error }))
    await vi.waitFor(() => expect(gatewayMocks.startThreadTurn).toHaveBeenCalledTimes(1))
    const rows = () => state.projectGroups.value.flatMap(group => group.threads.filter(row => row.id === 'organization-new').map(row => ({ group: group.projectName, project: row.projectName, cwd: row.cwd })))
    try {
      expect(rows()).toEqual([{ group: projectId, project: projectId, cwd }])
      expect(state.selectedThread.value?.projectName).toBe(projectId)
      expect(gatewayMocks.startThread).toHaveBeenCalledWith(cwd, 'gpt-5.5')
      expect(JSON.stringify(gatewayMocks.startThreadTurn.mock.calls)).not.toContain(projectId)
    } finally {
      if (result === 'accepted') accept('turn-organization')
      else reject(new Error('send failed'))
      await settled
    }
    expect(rows()).toEqual([{ group: projectId, project: projectId, cwd }])
    expect(gatewayMocks.startThread).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.startThreadTurn).toHaveBeenCalledTimes(1)
  })

  it('ignores a duplicate new-thread send while the first one is pending', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({ model: 'gpt-5.5', providerId: '', reasoningEffort: 'medium', speedMode: '' })
    gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-5.5'])
    let acceptTurn!: (turnId: string) => void
    gatewayMocks.startThread.mockImplementation(async () => ({ threadId: `thread-${gatewayMocks.startThread.mock.calls.length}`, model: 'gpt-5.5', modelProvider: 'openai' }))
    gatewayMocks.startThreadTurn.mockImplementation(() => new Promise(resolve => { acceptTurn = resolve }))
    gatewayMocks.generateThreadTitle.mockResolvedValue('generated title')
    const state = useDesktopState()
    const first = state.sendMessageToNewThread('hi', '/tmp/project')
    const second = state.sendMessageToNewThread('hi', '/tmp/project')
    expect(await second).toBe('')
    await vi.waitFor(() => expect(typeof acceptTurn).toBe('function'))
    expect(gatewayMocks.startThread).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.startThreadTurn).toHaveBeenCalledTimes(1)
    expect(state.isSendingMessage.value).toBe(true)
    acceptTurn('turn-1')
    expect(await first).toBe('thread-1')
    expect(gatewayMocks.startThread).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.startThreadTurn).toHaveBeenCalledTimes(1)
  })

  it('captures the active provider when creating a new thread', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: '',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-5.5', 'gpt-5.4-mini'])
    gatewayMocks.startThread.mockResolvedValue({
      threadId: 'codex-thread',
      model: 'gpt-5.5',
      modelProvider: 'openai',
    })
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-1')
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.5',
      modelProvider: 'openai',
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          text: 'Hi.',
          messageType: 'agentMessage',
        },
      ],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
    await state.sendMessageToNewThread('hi', '/tmp/project')

    expect(gatewayMocks.startThread).toHaveBeenCalledWith('/tmp/project', 'gpt-5.5')
    expect(gatewayMocks.startThreadTurn).toHaveBeenCalledWith(
      'codex-thread',
      'hi',
      [],
      'gpt-5.5',
      'medium',
      undefined,
      [],
      'default',
      null,
      'immediate', expect.objectContaining({ id: expect.any(String) }),
    )
    expect(state.readModelIdForThread('codex-thread')).toBe('gpt-5.5')
    expect(state.messages.value.some((message) => (
      message.role === 'user' &&
      message.text === 'hi' &&
      message.messageType === 'userMessage.optimistic'
    ))).toBe(true)

    const modelConfigCallsBeforeLoad = gatewayMocks.getCurrentModelConfig.mock.calls.length
    const availableModelCallsBeforeLoad = gatewayMocks.getAvailableModelIds.mock.calls.length
    await state.loadMessages('codex-thread')
    expect(gatewayMocks.getCurrentModelConfig).toHaveBeenCalledTimes(modelConfigCallsBeforeLoad)
    expect(gatewayMocks.getAvailableModelIds).toHaveBeenCalledTimes(availableModelCallsBeforeLoad)
    expect(state.messages.value.map((message) => `${message.role}:${message.text}`)).toEqual([
      'user:hi',
      'assistant:Hi.',
    ])
  })

  it('refreshes a loaded optimistic thread when completion events arrive', async () => {
    installTestWindow()
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler) => {
      if (typeof callback === 'function') {
        void Promise.resolve().then(() => callback())
      }
      return 1
    }) as typeof window.setTimeout)
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.4-mini',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: '',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-5.5', 'gpt-5.4-mini'])
    gatewayMocks.startThread.mockResolvedValue({
      threadId: 'mini-thread',
      model: 'gpt-5.4-mini',
      modelProvider: 'openai',
    })
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-1')
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.4-mini',
      modelProvider: 'openai',
      messages: [
        {
          id: 'user-1',
          turnId: 'turn-1',
          userMessageOrdinal: 0,
          role: 'user',
          text: 'hi',
          messageType: 'userMessage',
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          text: 'Hi.',
          messageType: 'agentMessage',
        },
      ],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
    await state.sendMessageToNewThread('hi', '/tmp/project')
    state.startPolling()
    expect(notificationHandler).toBeDefined()
    notificationHandler!({
      method: 'turn/completed',
      params: {
        threadId: 'mini-thread',
        turn: { id: 'turn-1', status: 'completed' },
      },
    })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledWith('mini-thread')
    expect(state.messages.value.map((message) => `${message.role}:${message.text}`)).toEqual([
      'user:hi',
      'system:Worked for <1s',
      'assistant:Hi.',
    ])
  })

  it('surfaces selected thread load failures and still refreshes models', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: '',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-5.5', 'gpt-5.4-mini'])
    gatewayMocks.getThreadDetail.mockRejectedValue(new Error('thread not found'))

    const state = useDesktopState()
    state.primeSelectedThread('missing-thread')
    await state.refreshAll({
      includeSelectedThreadMessages: true,
      awaitAncillaryRefreshes: true,
    })

    expect(state.selectedLiveOverlay.value?.errorText).toContain('thread not found')
    expect(state.availableModelIds.value).toEqual(['gpt-5.5', 'gpt-5.4-mini'])
    expect(state.selectedModelId.value).toBe('gpt-5.5')

    await state.ensureThreadMessagesLoaded('missing-thread', { silent: true })
    await state.loadMessages('missing-thread')
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(1)
  })
})

describe('findAdjacentThreadId', () => {
  it('selects the next thread after the archived thread', () => {
    const threads = [
      thread('first-thread', '/tmp/project'),
      thread('selected-thread', '/tmp/project'),
      thread('next-thread', '/tmp/project'),
    ]

    expect(findAdjacentThreadId(threads, 'selected-thread')).toBe('next-thread')
  })

  it('falls back to the previous thread when the last thread is archived', () => {
    const threads = [
      thread('previous-thread', '/tmp/project'),
      thread('selected-thread', '/tmp/project'),
    ]

    expect(findAdjacentThreadId(threads, 'selected-thread')).toBe('previous-thread')
  })

  it('returns no fallback when there is no adjacent thread', () => {
    expect(findAdjacentThreadId([thread('selected-thread', '/tmp/project')], 'selected-thread')).toBe('')
  })
})


describe('durable queue lifecycle', () => {
  async function busyState(captureNotification?: (handler: (event: { method: string; params?: unknown }) => void) => void) {
    installTestWindow()
    gatewayMocks.resumeThread.mockResolvedValue(null)
    gatewayMocks.getThreadDetail.mockResolvedValue({ messages: [], inProgress: true, activeTurnId: 'turn-queue', turnIndexByTurnId: {}, hasMoreOlder: false })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.subscribeCodexNotifications.mockImplementation(handler => { captureNotification?.(handler); return () => {} })
    const state = useDesktopState()
    state.primeSelectedThread('queue-thread')
    await state.loadMessages('queue-thread')
    return state
  }

  it('keeps saved queues when polling is stopped and restarted for the same account', async () => {
    let saved: ThreadQueueState = {}
    gatewayMocks.mutateThreadQueueState.mockImplementation(async operation => {
      const result = applyThreadQueueOperation(saved, operation)
      saved = result.state
      return result
    })
    gatewayMocks.getThreadQueueState.mockImplementation(async () => saved)
    const state = await busyState()
    await state.sendMessageToSelectedThread('keep after account refresh')
    expect(state.selectedThreadQueuedMessages.value).toHaveLength(1)
    const savedId = state.selectedThreadQueuedMessages.value[0]!.id
    state.stopPolling()
    state.startPolling()
    await state.refreshQueueState()
    expect(state.selectedThreadQueuedMessages.value[0]?.id).toBe(savedId)
    expect(saved['queue-thread']?.[0]?.id).toBe(savedId)
    expect(gatewayMocks.mutateThreadQueueState).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.mutateThreadQueueState.mock.calls[0]![0].type).toBe('add')
    state.stopPolling()
  })

  it('reports failed saves and does not claim an unsaved message was queued', async () => {
    gatewayMocks.mutateThreadQueueState.mockRejectedValueOnce(new Error('fixture save failed'))
    const state = await busyState()
    await expect(state.sendMessageToSelectedThread('retain draft')).rejects.toThrow('fixture save failed')
    expect(state.error.value).toBe('fixture save failed')
    expect(state.selectedThreadQueueError.value).toBe('fixture save failed')
    state.primeSelectedThread('another-thread')
    expect(state.selectedThreadQueueError.value).toBe('')
    state.primeSelectedThread('queue-thread')
    expect(state.selectedThreadQueueError.value).toBe('fixture save failed')
    expect(state.selectedThreadQueuedMessages.value).toEqual([])
  })

  it('keeps persisted queues but clears polling-scoped account state when stopped', async () => {
    const queuedRow = { id: 'queued-row', text: 'queued', imageUrls: [], skills: [], fileAttachments: [], collaborationMode: 'default' as const }
    let saved: ThreadQueueState = { 'queue-thread': [queuedRow] }
    gatewayMocks.mutateThreadQueueState.mockImplementation(async operation => {
      const result = applyThreadQueueOperation(saved, operation)
      saved = result.state
      return result
    })
    gatewayMocks.getThreadQueueState.mockImplementation(async () => saved)
    let notification!: (event: { method: string; params?: unknown }) => void
    const state = await busyState(handler => { notification = handler })
    state.primeSelectedThread('queue-thread')
    await state.refreshQueueState()
    expect(state.selectedThreadQueuedMessages.value.map(row => row.id)).toEqual(['queued-row'])
    state.startPolling()
    expect(notification).toBeInstanceOf(Function)
    await state.refreshQueueState()
    notification({ method: 'codexapp/completions/changed', params: { threadId: 'queue-thread', token: 'unread-token' } })
    expect(state.selectedThreadQueuedMessages.value.map(row => row.id)).toEqual(['queued-row'])
    state.stopPolling()
    expect(state.selectedThreadQueuedMessages.value).toEqual([])
    state.startPolling()
    expect(state.selectedThreadQueuedMessages.value).toEqual([])
  })

  it('cancels queued polling timers when polling stops', async () => {
    installTestWindow()
    const timers = new Map<number, TimerHandler>()
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler, timeout?: number) => {
      const id = timers.size + 1
      timers.set(id, callback)
      return id
    }) as typeof window.setTimeout)
    vi.mocked(window.clearTimeout).mockImplementation(((id?: number) => {
      if (typeof id === 'number') timers.delete(id)
    }) as typeof window.clearTimeout)
    gatewayMocks.getThreadQueueState.mockResolvedValue({})
    gatewayMocks.resumeThread.mockResolvedValue(null)
    gatewayMocks.getThreadDetail.mockResolvedValue({ messages: [], inProgress: false, activeTurnId: '', turnIndexByTurnId: {}, hasMoreOlder: false })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    let notify!: (event: { method: string; params: unknown }) => void
    gatewayMocks.subscribeCodexNotifications.mockImplementation(handler => { notify = handler; return vi.fn() })
    const state = useDesktopState()
    state.primeSelectedThread('queue-thread')
    await state.loadMessages('queue-thread')
    state.startPolling()
    notify({ method: 'turn/completed', params: { threadId: 'queue-thread', turn: { id: 'queue-timer-turn' } } })
    state.stopPolling()
    expect(timers.size).toBe(0)
  })
})


describe('local model setting isolation', () => {
  it('keeps model settings separate and never writes global Codex Fast config', async () => {
    installTestWindow()
    const state = useDesktopState()
    state.setSelectedModelId('model-b')
    state.selectedSpeedMode.value = 'other-tier'
    state.setSelectedReasoningEffort('low')
    state.setSelectedModelId('model-a')
    state.setSelectedReasoningEffort('ultra')
    const writing = state.updateSelectedSpeedMode('priority')
    state.setSelectedModelId('model-b')
    await writing
    expect(gatewayMocks.setCodexSpeedMode).not.toHaveBeenCalled()
    expect(state.selectedSpeedMode.value).toBe('other-tier')
    expect(state.selectedReasoningEffort.value).toBe('low')
    state.setSelectedModelId('model-a')
    expect(state.selectedSpeedMode.value).toBe('priority')
    expect(state.selectedReasoningEffort.value).toBe('ultra')
  })
})


describe('runtime reconnect capabilities', () => {
  it('coalesces the startup and ready pending-request snapshots while the read is in flight', async () => {
    installTestWindow()
    let notify!: (event: { method: string; params: unknown }) => void
    let resolveSnapshot!: (rows: unknown[]) => void
    gatewayMocks.subscribeCodexNotifications.mockImplementation(handler => { notify = handler; return vi.fn() })
    gatewayMocks.getPendingServerRequests.mockReset().mockImplementation(() => new Promise(resolve => { resolveSnapshot = resolve }))
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    const state = useDesktopState()
    state.startPolling()
    notify({ method: 'ready', params: {} })
    expect(gatewayMocks.getPendingServerRequests).toHaveBeenCalledTimes(1)
    resolveSnapshot([])
    await Promise.resolve()
    state.stopPolling()
  })

  it('rejects a pending snapshot from a former account without needing stop', async () => {
    installTestWindow()
    let resolveSnapshot!: (rows: unknown[]) => void
    gatewayMocks.subscribeCodexNotifications.mockReturnValue(vi.fn())
    gatewayMocks.getPendingServerRequests.mockReset()
      .mockImplementationOnce(() => new Promise(resolve => { resolveSnapshot = resolve }))
      .mockResolvedValue([])
    const state = useDesktopState()
    state.primeSelectedThread('shared-id')
    state.startPolling()
    await state.refreshAll({ accountChanged: true, includeThreads: false, includeSelectedThreadMessages: false })
    expect(gatewayMocks.getPendingServerRequests).toHaveBeenCalledTimes(2)
    resolveSnapshot([{ id: 41, method: 'item/tool/requestUserInput', params: { threadId: 'shared-id', itemId: 'old-account' } }])
    await Promise.resolve()
    await Promise.resolve()
    expect(state.selectedThreadServerRequests.value).toEqual([])
    state.stopPolling()
  })

  it('starts a new pending read after stop and keeps it joined across the old finally', async () => {
    installTestWindow()
    let notify!: (event: { method: string; params: unknown }) => void
    let resolveOld!: (rows: unknown[]) => void
    let resolveCurrent!: (rows: unknown[]) => void
    gatewayMocks.subscribeCodexNotifications.mockImplementation(handler => { notify = handler; return vi.fn() })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getPendingServerRequests.mockReset()
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveCurrent = resolve }))
      .mockResolvedValue([])
    const state = useDesktopState()
    state.primeSelectedThread('shared-id')
    state.startPolling()
    state.stopPolling()
    state.startPolling()
    expect(gatewayMocks.getPendingServerRequests).toHaveBeenCalledTimes(2)
    resolveOld([])
    await Promise.resolve()
    notify({ method: 'ready', params: {} })
    expect(gatewayMocks.getPendingServerRequests).toHaveBeenCalledTimes(2)
    resolveCurrent([{ id: 41, method: 'item/tool/requestUserInput', params: { threadId: 'shared-id', itemId: 'current' } }])
    await vi.waitFor(() => expect(state.selectedThreadServerRequests.value[0]?.itemId).toBe('current'))
    state.stopPolling()
  })

  it('removes a successful current reply and reports a current reply failure', async () => {
    installTestWindow()
    let notify!: (event: { method: string; params: unknown }) => void
    gatewayMocks.subscribeCodexNotifications.mockImplementation(handler => { notify = handler; return vi.fn() })
    gatewayMocks.getPendingServerRequests.mockReset().mockResolvedValue([])
    gatewayMocks.replyToServerRequest.mockReset().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('current failure'))
    const state = useDesktopState()
    state.primeSelectedThread('shared-id')
    state.startPolling()
    await Promise.resolve()
    notify({ method: 'server/request', params: { id: 41, method: 'item/tool/requestUserInput', params: { threadId: 'shared-id', itemId: 'question' } } })
    expect(await state.respondToPendingServerRequest({ id: 41, result: {} })).toBe(true)
    expect(state.selectedThreadServerRequests.value).toEqual([])
    expect(await state.respondToPendingServerRequest({ id: 42, result: {} })).toBe(false)
    expect(state.error.value).toBe('current failure')
    state.stopPolling()
  })

  it.each(['stop', 'account'])('ignores an old pending reply success or failure after %s', async transition => {
    installTestWindow()
    let notify!: (event: { method: string; params: unknown }) => void
    gatewayMocks.subscribeCodexNotifications.mockImplementation(handler => { notify = handler; return vi.fn() })
    gatewayMocks.getPendingServerRequests.mockReset().mockResolvedValue([])
    const state = useDesktopState()
    state.primeSelectedThread('shared-id')
    state.startPolling()
    await Promise.resolve()
    const request = (itemId: string) => notify({ method: 'server/request', params: { id: 41, method: 'item/tool/requestUserInput', params: { threadId: 'shared-id', itemId } } })
    request('old-question')
    let resolveReply!: () => void
    let rejectReply!: (cause: Error) => void
    gatewayMocks.replyToServerRequest.mockReset()
      .mockImplementationOnce(() => new Promise<void>(resolve => { resolveReply = resolve }))
      .mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectReply = reject }))
    const oldSuccess = state.respondToPendingServerRequest({ id: 41, result: {} })
    const oldFailure = state.respondToPendingServerRequest({ id: 42, result: {} })
    if (transition === 'stop') {
      state.stopPolling()
      state.startPolling()
      await Promise.resolve()
    } else {
      await state.refreshAll({ accountChanged: true, includeThreads: false, includeSelectedThreadMessages: false })
    }
    request('current-question')
    const currentError = state.error.value
    resolveReply()
    rejectReply(new Error('old reply failure'))
    expect(await oldSuccess).toBe(false)
    expect(await oldFailure).toBe(false)
    expect(state.selectedThreadServerRequests.value.find(row => row.id === 41)?.itemId).toBe('current-question')
    expect(state.error.value).toBe(currentError)
    state.stopPolling()
  })

  it('refreshes metadata on a later ready event without duplicating the initial read', async () => {
    installTestWindow()
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({ model: 'gpt-5.5', providerId: '', reasoningEffort: 'low', speedMode: '' })
    gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-5.5'])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    let callback!: (event: { method: string; params: unknown; atIso: string }) => void
    gatewayMocks.subscribeCodexNotifications.mockImplementationOnce(fn => { callback = fn; return () => {} })
    const state = useDesktopState()
    state.startPolling()
    const baseline = gatewayMocks.getAvailableModelIds.mock.calls.length
    callback({ method: 'ready', params: {}, atIso: '' })
    await Promise.resolve()
    expect(gatewayMocks.getAvailableModelIds).toHaveBeenCalledTimes(baseline)
    callback({ method: 'ready', params: {}, atIso: '' })
    await vi.waitFor(() => expect(gatewayMocks.getAvailableModelIds).toHaveBeenCalledTimes(baseline + 1))
    state.stopPolling()
  })

  it('re-syncs queue state on ready so a row auto-sent while away stops rendering as queued', async () => {
    installTestWindow()
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    const queued = { id: 'queue-stale', text: 'sent while away', imageUrls: [], skills: [], fileAttachments: [], delivery: { status: 'queued', revision: 1 } }
    gatewayMocks.getThreadQueueState.mockResolvedValue({ 'queue-thread': [queued] })
    let callback!: (event: { method: string; params: unknown; atIso: string }) => void
    gatewayMocks.subscribeCodexNotifications.mockImplementation(fn => { callback = fn; return () => {} })
    const state = useDesktopState()
    state.primeSelectedThread('queue-thread')
    state.startPolling()
    await state.refreshQueueState()
    expect(state.selectedThreadQueuedMessages.value.map(row => row.id)).toEqual(['queue-stale'])
    // 浏览器离开期间回合已结束、排队消息被自动发送：服务端队列里不再有这一行。
    gatewayMocks.getThreadQueueState.mockResolvedValue({})
    callback({ method: 'ready', params: {}, atIso: '' })
    await vi.waitFor(() => expect(state.selectedThreadQueuedMessages.value).toEqual([]))
    state.stopPolling()
  })
})


describe('explicit question answers', () => {
  it('does not intercept ordinary text or steer as an answer to a pending question', async () => {
    installTestWindow()
    let notify: (event: { method: string; params?: unknown }) => void = () => {}
    gatewayMocks.subscribeCodexNotifications.mockImplementation(handler => { notify = handler; return vi.fn() })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadDetail.mockResolvedValue({ messages: [], inProgress: false, activeTurnId: '', turnIndexByTurnId: {} })
    gatewayMocks.startThreadTurn.mockResolvedValue('t-new')
    const state = useDesktopState()
    state.primeSelectedThread('thread-question')
    await state.loadMessages('thread-question')
    state.startPolling()
    notify({ method: 'server/request', params: { id: 21, method: 'item/tool/requestUserInput', params: { threadId: 'thread-question', turnId: 't', itemId: 'q', isBlocking: false, questions: [{ id: 'scope', question: 'Scope?' }] } } })
    await state.sendMessageToSelectedThread('ordinary text', [], [], 'steer')
    expect(gatewayMocks.replyToServerRequest).not.toHaveBeenCalled()
    expect(gatewayMocks.startThreadTurn).toHaveBeenCalledWith('thread-question', 'ordinary text', [], undefined, undefined, undefined, [], 'default', null, 'immediate', expect.objectContaining({ id: expect.any(String) }))
    state.stopPolling()
  })
})


it('does not lose a live question when an earlier pending snapshot arrives afterward', async () => {
  installTestWindow()
  let notify: (event: { method: string; params?: unknown }) => void = () => {}
  let resolveSnapshot: (rows: unknown[]) => void = () => {}
  gatewayMocks.subscribeCodexNotifications.mockImplementation(handler => { notify = handler; return vi.fn() })
  gatewayMocks.getPendingServerRequests.mockImplementation(() => new Promise(resolve => { resolveSnapshot = resolve }))
  const state = useDesktopState()
  state.primeSelectedThread('question-thread')
  state.startPolling()
  notify({ method: 'server/request', params: { id: 901, method: 'item/tool/requestUserInput', params: { threadId: 'question-thread', turnId: 'turn', itemId: 'item', isBlocking: false, questions: [{ id: 'q', question: 'Scope?' }] } } })
  resolveSnapshot([])
  await Promise.resolve()
  await Promise.resolve()
  expect(state.selectedThreadServerRequests.value.map(request => request.id)).toEqual([901])
  state.stopPolling()
})


describe('native history integration', () => {
  it('keeps conversation history when workspace rollback is rejected', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [{ projectName: 'fixture', threads: [thread('paged', '/tmp/fixture')] }], nextCursor: null })
    gatewayMocks.getThreadDetail.mockResolvedValue({ messages: [{ id: 'message', turnId: 'turn', turnIndex: 0, role: 'user', text: 'preserve this' }], inProgress: false, activeTurnId: '', turnIndexByTurnId: { turn: 0 }, hasMoreOlder: false })
    gatewayMocks.revertThreadFileChanges.mockResolvedValue({ reverted: 0, errors: ['此会话不支持撤回历史。'] })
    const state = useDesktopState()
    state.primeSelectedThread('paged')
    await state.refreshAll()
    await state.loadMessages('paged')
    expect(await state.rollbackSelectedThread('turn')).toBe(false)
    expect(gatewayMocks.revertThreadFileChanges).toHaveBeenCalledExactlyOnceWith('paged', 'turn', '/tmp/fixture')
    expect(gatewayMocks.rollbackThread).not.toHaveBeenCalled()
    expect(state.messages.value.some(message => message.text === 'preserve this')).toBe(true)
    expect(state.error.value).toContain('不支持撤回历史')
  })

  it('retains older pages and empty turns, and passes the cursor unchanged', async () => {
    installTestWindow()
    const msg = (id: string) => ({ id, turnId: id, turnIndex: 0, text: id, role: 'assistant' as const })
    gatewayMocks.getThreadDetail.mockResolvedValue({ messages: [msg('latest')], inProgress: false, activeTurnId: '', turnIndexByTurnId: { latest: 0 }, hasMoreOlder: true, historyPosition: { source: 'native', nextCursor: 'opaque/+' } })
    gatewayMocks.getOlderThreadMessages.mockResolvedValue({ messages: [msg('older')], inProgress: false, activeTurnId: '', turnIndexByTurnId: { older: 0, empty: 1 }, hasMoreOlder: true, historyPosition: { source: 'native', nextCursor: 'opaque-next' } })
    const state = useDesktopState()
    state.primeSelectedThread('paged')
    await state.loadMessages('paged')
    await state.loadOlderMessages('paged')
    expect(gatewayMocks.getOlderThreadMessages).toHaveBeenLastCalledWith('paged', 'latest', undefined, { source: 'native', nextCursor: 'opaque/+' })
    expect(state.messages.value.filter(message => message.turnId).map(message => [message.turnId, message.turnIndex])).toEqual([['older', 0], ['latest', 2]])
    gatewayMocks.getOlderThreadMessages.mockResolvedValue({ messages: [], turnIndexByTurnId: { firstEmpty: 0 }, hasMoreOlder: false, historyPosition: { source: 'native', nextCursor: null } })
    await state.loadOlderMessages('paged')
    expect(gatewayMocks.getOlderThreadMessages).toHaveBeenLastCalledWith('paged', 'older', undefined, { source: 'native', nextCursor: 'opaque-next' })
    expect(state.messages.value.filter(message => message.turnId).map(message => [message.turnId, message.turnIndex])).toEqual([['older', 1], ['latest', 3]])
    expect(state.hasMoreOlderMessages.value).toBe(false)
  })

  it('discards an older history page from the previous account', async () => {
    installTestWindow()
    const message = (id: string) => ({ id, turnId: id, turnIndex: 0, text: id, role: 'assistant' as const })
    let releasePreviousPage!: (page: Awaited<ReturnType<typeof gatewayMocks.getOlderThreadMessages>>) => void
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [{ projectName: 'fixture', threads: [thread('paged', '/tmp/fixture')] }], nextCursor: null })
    gatewayMocks.getThreadDetail
      .mockResolvedValueOnce({ messages: [message('previous-latest')], inProgress: false, activeTurnId: '', turnIndexByTurnId: { 'previous-latest': 0 }, hasMoreOlder: true })
      .mockResolvedValue({ messages: [message('current-latest')], inProgress: false, activeTurnId: '', turnIndexByTurnId: { 'current-latest': 0 }, hasMoreOlder: false })
    gatewayMocks.getOlderThreadMessages.mockImplementationOnce(() => new Promise(resolve => { releasePreviousPage = resolve }))
    const state = useDesktopState()
    state.primeSelectedThread('paged')
    await state.loadMessages('paged')
    const olderLoad = state.loadOlderMessages('paged')
    await vi.waitFor(() => expect(typeof releasePreviousPage).toBe('function'))
    const accountSwitch = state.refreshAll({ accountChanged: true, includeSelectedThreadMessages: true })
    releasePreviousPage({ messages: [message('previous-older')], inProgress: false, activeTurnId: '', turnIndexByTurnId: { 'previous-older': 0 }, hasMoreOlder: true })
    await Promise.all([olderLoad, accountSwitch])

    expect(state.messages.value.map(row => row.text).filter(text => text.startsWith('current-'))).toEqual(['current-latest'])
    expect(state.messages.value.some(row => row.text.startsWith('previous-older'))).toBe(false)
    expect(state.hasMoreOlderMessages.value).toBe(true)
  })

  it('reads a historical question by turn ID when it is outside the latest page', async () => {
    installTestWindow()
    const question = { id: 'q-old', turnId: 'old', turnIndex: 0, role: 'assistant', text: 'choose', questions: [{ title: 'Fruit?', options: ['Pear'] }], questionOrdinal: 0 }
    gatewayMocks.getThreadDetail.mockResolvedValueOnce({ messages: [question], inProgress: false, activeTurnId: '', turnIndexByTurnId: { old: 0 }, hasMoreOlder: false })
    gatewayMocks.getThreadDetail.mockResolvedValue({ messages: [], inProgress: false, activeTurnId: '', turnIndexByTurnId: {} })
    gatewayMocks.getThreadTurnMessages.mockResolvedValue([question])
    gatewayMocks.startThreadTurn.mockResolvedValue('new')
    const state = useDesktopState()
    state.primeSelectedThread('old-question')
    await state.loadMessages('old-question')
    await state.answerAsyncQuestions({ threadId: 'old-question', turnId: 'old', itemId: 'q-old', questionOrdinal: 0, answers: ['Pear'] })
    expect(gatewayMocks.getThreadTurnMessages).toHaveBeenCalledExactlyOnceWith('old-question', 'old')
    expect(gatewayMocks.startThreadTurn).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.startThreadTurn.mock.calls[0][1]).toContain('codexapp:question-reply')
  })

  it('does not write a stale selected thread error after selection changes', async () => {
    installTestWindow()
    let failFirst!: (cause: Error) => void
    gatewayMocks.getThreadDetail
      .mockImplementationOnce(() => new Promise((_, reject) => { failFirst = reject }))
      .mockResolvedValue({ messages: [], inProgress: false, activeTurnId: '', turnIndexByTurnId: {}, hasMoreOlder: false })
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({ model: 'model', providerId: 'codex', reasoningEffort: 'medium', speedMode: '' })
    gatewayMocks.getAvailableModelIds.mockResolvedValue(['model'])
    const state = useDesktopState()
    const oldSelection = state.selectThread('old-thread')
    await vi.waitFor(() => expect(typeof failFirst).toBe('function'))
    const newSelection = state.selectThread('new-thread')
    failFirst(new Error('old thread failed'))
    expect(await oldSelection).toBe('error')
    expect(await newSelection).toBe('ok')
    expect(state.error.value).toBe('')
  })

  it('clears selected thread loading while an older thread finishes loading', async () => {
    installTestWindow()
    let finishOld!: () => void
    gatewayMocks.getThreadDetail
      .mockImplementationOnce(() => new Promise(resolve => { finishOld = () => resolve({ messages: [], inProgress: false, activeTurnId: '', turnIndexByTurnId: {}, hasMoreOlder: false }) }))
      .mockImplementation(async id => ({ messages: [{ id: `${id}-message`, turnId: id, turnIndex: 0, role: 'assistant', text: id }], inProgress: false, activeTurnId: '', turnIndexByTurnId: {}, hasMoreOlder: false }))
    const state = useDesktopState()
    const oldLoad = state.loadMessages('old-loading')
    await vi.waitFor(() => expect(typeof finishOld).toBe('function'))
    state.primeSelectedThread('new-loading')
    const newLoad = state.loadMessages('new-loading')
    expect(state.isLoadingMessages.value).toBe(true)
    await newLoad
    expect(state.isLoadingMessages.value).toBe(false)
    finishOld()
    await oldLoad
    expect(state.isLoadingMessages.value).toBe(false)
  })

  it('ignores duplicate interrupts and preserves a newer selected thread state', async () => {
    installTestWindow()
    let notify!: (notification: { method: string; params: unknown }) => void
    gatewayMocks.subscribeCodexNotifications.mockImplementation(handler => { notify = handler; return vi.fn() })
    let finishInterrupt!: () => void
    gatewayMocks.getThreadDetail.mockResolvedValue({ messages: [], inProgress: true, activeTurnId: 'turn-1', turnIndexByTurnId: {}, hasMoreOlder: false })
    gatewayMocks.interruptThreadTurn.mockImplementation(() => new Promise(resolve => { finishInterrupt = () => resolve('stopped') }))
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    const state = useDesktopState()
    state.primeSelectedThread('old-thread')
    state.startPolling()
    try {
      notify({ method: 'thread/status/changed', params: { threadId: 'old-thread', status: { type: 'inProgress' } } })
      const first = state.interruptSelectedThreadTurn()
      await vi.waitFor(() => expect(typeof finishInterrupt).toBe('function'))
      const second = state.interruptSelectedThreadTurn()
      await expect(second).resolves.toBeUndefined()
      state.primeSelectedThread('new-thread')
      notify({ method: 'thread/status/changed', params: { threadId: 'new-thread', status: { type: 'inProgress' } } })
      finishInterrupt()
      expect(gatewayMocks.getThreadGroupsPage).not.toHaveBeenCalled()
      await first
      expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledTimes(1)
      expect(state.projectGroups.value).toEqual([])
      expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Thinking')
    } finally {
      state.stopPolling()
    }
  })

  it.each(['success', 'failure', 'account-change'])('owns interrupt admission before the missing turn ID read: %s', async outcome => {
    installTestWindow()
    let notify!: (notification: { method: string; params: unknown }) => void
    gatewayMocks.subscribeCodexNotifications.mockImplementation(handler => { notify = handler; return vi.fn() })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    let finish!: (detail: unknown) => void
    let fail!: (error: Error) => void
    gatewayMocks.getThreadDetail.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject }))
    gatewayMocks.interruptThreadTurn.mockResolvedValue(undefined)
    const state = useDesktopState()
    state.primeSelectedThread('missing-turn')
    state.startPolling()
    try {
      notify({ method: 'thread/status/changed', params: { threadId: 'missing-turn', status: { type: 'inProgress' } } })
      const first = state.interruptSelectedThreadTurn()
      const second = state.interruptSelectedThreadTurn()
      expect(state.isInterruptingTurn.value).toBe(true)
      expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(1)
      if (outcome === 'account-change') {
        await state.refreshAll({ accountChanged: true, includeThreads: false, includeSelectedThreadMessages: false })
      }
      state.primeSelectedThread('other-thread')
      if (outcome === 'failure') fail(new Error('Old detail failed'))
      else finish({ activeTurnId: 'turn-1' })
      await Promise.all([first, second])
      expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0)
      expect(state.error.value).not.toBe('Old detail failed')
      expect(state.isInterruptingTurn.value).toBe(false)
    } finally {
      state.stopPolling()
    }
  })

  it('does not let an old interrupt completion clear a new account operation', async () => {
    installTestWindow()
    let notify!: (notification: { method: string; params: unknown }) => void
    gatewayMocks.subscribeCodexNotifications.mockImplementation(handler => { notify = handler; return vi.fn() })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    let finishOldDetail!: (value: unknown) => void
    let finishNewInterrupt!: (value: unknown) => void
    gatewayMocks.getThreadDetail.mockImplementationOnce(() => new Promise(resolve => { finishOldDetail = resolve }))
    gatewayMocks.interruptThreadTurn.mockImplementationOnce(() => new Promise(resolve => { finishNewInterrupt = resolve }))
    const state = useDesktopState()
    state.startPolling()
    try {
      state.primeSelectedThread('old-account-thread')
      notify({ method: 'thread/status/changed', params: { threadId: 'old-account-thread', status: { type: 'inProgress' } } })
      const old = state.interruptSelectedThreadTurn()
      await state.refreshAll({ accountChanged: true, includeThreads: false, includeSelectedThreadMessages: false })
      state.primeSelectedThread('new-account-thread')
      notify({ method: 'turn/started', params: { threadId: 'new-account-thread', turn: { id: 'new-turn' } } })
      const current = state.interruptSelectedThreadTurn()
      finishOldDetail({ activeTurnId: 'old-turn' })
      await old
      expect(state.isInterruptingTurn.value).toBe(true)
      expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledExactlyOnceWith('new-account-thread', 'new-turn')
      state.primeSelectedThread('other-thread')
      finishNewInterrupt(undefined)
      await current
      expect(state.isInterruptingTurn.value).toBe(false)
    } finally {
      state.stopPolling()
    }
  })
})

it('refreshes a fast completed turn even when the thread timestamp and recent snapshot are unchanged', async () => {
  installTestWindow()
  let notify: (notification: { method: string; params: unknown }) => void = () => {}
  gatewayMocks.subscribeCodexNotifications.mockImplementation(handler => { notify = handler; return vi.fn() })
  gatewayMocks.getPendingServerRequests.mockResolvedValue([])
  gatewayMocks.resumeThread.mockResolvedValue(null)
  const detail = { messages: [{ id: 'old', role: 'assistant', text: 'old' }], inProgress: false, activeTurnId: '', turnIndexByTurnId: {}, hasMoreOlder: false }
  gatewayMocks.getThreadDetail.mockResolvedValue(detail)
  const state = useDesktopState()
  state.primeSelectedThread('fast')
  await state.loadMessages('fast')
  state.startPolling()
  gatewayMocks.getThreadDetail.mockResolvedValue({ ...detail, messages: [...detail.messages, { id: 'new', role: 'assistant', text: 'fast result' }] })
  notify({ method: 'turn/completed', params: { threadId: 'fast', turn: { id: 'new-turn', status: 'completed' } } })
  await state.loadMessages('fast')
  expect(state.messages.value.some(message => message.text === 'fast result')).toBe(true)
  expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(2)
})

it('does not let an in-flight older history snapshot swallow a newer completion', async () => {
  installTestWindow()
  let notify: (notification: { method: string; params: unknown }) => void = () => {}
  gatewayMocks.subscribeCodexNotifications.mockImplementation(handler => { notify = handler; return vi.fn() })
  gatewayMocks.getPendingServerRequests.mockResolvedValue([])
  gatewayMocks.resumeThread.mockResolvedValue(null)
  let finish!: (value: unknown) => void
  gatewayMocks.getThreadDetail.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const state = useDesktopState()
  state.primeSelectedThread('race')
  state.startPolling()
  const pending = state.loadMessages('race')
  await Promise.resolve()
  await Promise.resolve()
  notify({ method: 'turn/completed', params: { threadId: 'race', turn: { id: 'new-turn', status: 'completed' } } })
  finish({ messages: [], inProgress: true, activeTurnId: 'old-turn', turnIndexByTurnId: {}, hasMoreOlder: false })
  await pending
  gatewayMocks.getThreadDetail.mockResolvedValue({ messages: [{ id: 'new', role: 'assistant', text: 'after old read' }], inProgress: false, activeTurnId: '', turnIndexByTurnId: {}, hasMoreOlder: false })
  await state.loadMessages('race')
  expect(state.messages.value.some(message => message.text === 'after old read')).toBe(true)
  expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(2)
})

 describe('0.2.11 realtime regression', () => {
  function setup() {
    installTestWindow()
    let notify: (notification: { method: string; params: unknown }) => void = () => {}
    gatewayMocks.subscribeCodexNotifications.mockImplementation(handler => { notify = handler; return vi.fn() })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [{ projectName: 'p', threads: [thread('live', '/p'), thread('other', '/p')] }], nextCursor: null })
    const empty = { messages: [], inProgress: true, activeTurnId: 't1', turnIndexByTurnId: { t1: 0 }, hasMoreOlder: false }
    gatewayMocks.getThreadDetail.mockResolvedValue(empty)
    gatewayMocks.startThreadTurn.mockResolvedValue('t1')
    const state = useDesktopState()
    state.primeSelectedThread('live')
    state.startPolling()
    return { state, notify }
  }

  it('shows confirmed steering immediately, replaces it once, and preserves repeated equal steering text', async () => {
    const { state, notify } = setup()
    await state.loadMessages('live')
    await state.sendMessageToSelectedThread('keep going', [], [], 'steer')
    expect(gatewayMocks.startThreadTurn.mock.calls.at(-1)?.[9]).toBe('steer')
    expect(state.messages.value.filter(row => row.text === 'keep going')).toHaveLength(1)
    const firstId = gatewayMocks.startThreadTurn.mock.calls.at(-1)?.[10].id
    const event = { method: 'item/completed', params: { threadId: 'live', turnId: 't1', item: { id: 'user-native-1', type: 'userMessage', clientUserMessageId: firstId, content: [{ type: 'text', text: 'keep going' }] } } }
    notify(event)
    notify(event)
    expect(state.messages.value.filter(row => row.text === 'keep going')).toHaveLength(1)
    await state.sendMessageToSelectedThread('keep going', [], [], 'steer')
    expect(state.messages.value.filter(row => row.text === 'keep going')).toHaveLength(2)
    state.stopPolling()
  })

  it('shows queue-to-steer delivery before a late history snapshot', async () => {
    const { state } = setup()
    const message = { id: 'queue-1', text: 'queued steer', imageUrls: [], skills: [], fileAttachments: [], delivery: { status: 'queued', revision: 1 } }
    gatewayMocks.getThreadQueueState.mockResolvedValue({ live: [message] })
    await state.loadMessages('live')
    await state.refreshQueueState()
    gatewayMocks.mutateThreadQueueState.mockResolvedValue({ state: {}, delivered: { id: 'queue-1', turnId: 't1' } })
    await state.steerQueuedMessage('queue-1')
    expect(state.messages.value.filter(row => row.text === 'queued steer')).toHaveLength(1)
    state.stopPolling()
  })

  it('assigns queued steering ordinals after already accepted steering deliveries', async () => {
    const { state } = setup()
    await state.sendMessageToSelectedThread('first steer', [], [], 'steer')
    const message = { id: 'queue-2', text: 'second steer', imageUrls: [], skills: [], fileAttachments: [], delivery: { status: 'queued', revision: 1 } }
    gatewayMocks.getThreadQueueState.mockResolvedValue({ live: [message] })
    await state.refreshQueueState()
    gatewayMocks.mutateThreadQueueState.mockResolvedValue({ state: {}, delivered: { id: 'queue-2', turnId: 't1' } })
    await state.steerQueuedMessage('queue-2')
    expect(state.messages.value.find(row => row.text === 'second steer')?.userMessageOrdinal).toBe(1)
    state.stopPolling()
  })

  it('shows steering before the HTTP response and retains it while switching conversations', async () => {
    const { state } = setup()
    await state.loadMessages('live')
    let finish!: (turnId: string) => void
    gatewayMocks.startThreadTurn.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve }))
    const pending = state.sendMessageToSelectedThread('visible immediately', [], [], 'steer')
    expect(state.messages.value.find(row => row.text === 'visible immediately')?.deliveryState?.status).toBe('submitting')
    await vi.waitFor(() => expect(typeof finish).toBe('function'))
    state.primeSelectedThread('other')
    expect(state.messages.value.some(row => row.text === 'visible immediately')).toBe(false)
    state.primeSelectedThread('live')
    expect(state.messages.value.some(row => row.text === 'visible immediately')).toBe(true)
    finish('t1')
    await pending
    expect(state.messages.value.filter(row => row.text === 'visible immediately')).toHaveLength(1)
    expect(state.messages.value.find(row => row.text === 'visible immediately')?.deliveryState?.status).toBe('accepted')
    state.stopPolling()
  })

  it('resets the steering ordinal when the server starts a new turn', async () => {
    const { state } = setup()
    await state.loadMessages('live')
    gatewayMocks.startThreadTurn.mockResolvedValueOnce('t2')
    await state.sendMessageToSelectedThread('start new turn', [], [], 'steer')
    expect(state.messages.value.find(row => row.text === 'start new turn')?.userMessageOrdinal).toBe(0)
    state.stopPolling()
  })

  it('restores a queued steer and reads its final receipt without sending again', async () => {
    const { state } = setup()
    const message = { id: 'queue-restore', text: 'queued visibility', imageUrls: [], skills: [], fileAttachments: [], delivery: { mode: 'steer', status: 'queued', revision: 2, createdAt: 1, updatedAt: 2 } }
    gatewayMocks.getThreadQueueState.mockResolvedValue({ live: [message] })
    await state.loadMessages('live')
    await state.refreshQueueState()
    expect(state.messages.value.find(row => row.text === message.text)?.deliveryState?.status).toBe('queued')
    gatewayMocks.getThreadQueueState.mockResolvedValue({})
    gatewayMocks.getDeliveryStatuses.mockResolvedValue([{ id: message.id, status: 'accepted', turnId: 't1' }])
    await state.refreshQueueState()
    expect(state.messages.value.find(row => row.text === message.text)?.deliveryState?.status).toBe('accepted')
    expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()
    expect(gatewayMocks.mutateThreadQueueState).not.toHaveBeenCalled()
    state.stopPolling()
  })

  it('keeps a queue-to-steer operation visible while pending and after failure or cancellation', async () => {
    const { state } = setup()
    const message = { id: 'queue-pending', text: 'show during steer', imageUrls: [], skills: [], fileAttachments: [], delivery: { mode: 'queue', status: 'queued', revision: 1, createdAt: 1, updatedAt: 1 } }
    gatewayMocks.getThreadQueueState.mockResolvedValue({ live: [message] })
    await state.loadMessages('live')
    await state.refreshQueueState()
    let finish!: (result: unknown) => void
    gatewayMocks.mutateThreadQueueState.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = state.steerQueuedMessage(message.id)
    expect(state.messages.value.some(row => row.text === message.text)).toBe(true)
    await Promise.resolve()
    finish({ state: { live: [{ ...message, delivery: { ...message.delivery, mode: 'steer', status: 'failed', revision: 3, error: 'fixture failure before submission' } }] } })
    await pending
    expect(state.messages.value.find(row => row.text === message.text)?.deliveryState?.status).toBe('failed')
    gatewayMocks.mutateThreadQueueState.mockResolvedValueOnce({ state: {}, removed: message })
    await state.removeQueuedMessage(message.id)
    expect(state.messages.value.find(row => row.text === message.text)?.deliveryState?.status).toBe('cancelled')
    state.stopPolling()
  })

  it('keeps a new running turn when an older completion is replayed and ignores an ended turn start', async () => {
    const { state, notify } = setup()
    await state.refreshAll({ includeSelectedThreadMessages: false })
    state.primeSelectedThread('other')
    notify({ method: 'turn/started', params: { threadId: 'live', turn: { id: 't1' } } })
    notify({ method: 'turn/started', params: { threadId: 'live', turn: { id: 't2' } } })
    notify({ method: 'turn/completed', params: { threadId: 'live', turn: { id: 't1' } } })
    const row = () => state.projectGroups.value.flatMap(group => group.threads).find(row => row.id === 'live')!
    expect(row().inProgress).toBe(true)
    expect(row().unread).toBe(false)
    notify({ method: 'turn/completed', params: { threadId: 'live', turn: { id: 't2' } } })
    expect(row().inProgress).toBe(false)
    expect(row().unread).toBe(false)
    notify({ method: 'codexapp/completions/changed', params: { threadId: 'live', token: 't2' } })
    expect(row().unread).toBe(true)
    notify({ method: 'turn/started', params: { threadId: 'live', turn: { id: 't2' } } })
    expect(row().inProgress).toBe(false)
    state.primeSelectedThread('live')
    expect(row().unread).toBe(false)
    state.stopPolling()
  })

  it('does not let a delayed list snapshot overwrite a newer running notification', async () => {
    const { state, notify } = setup()
    let release!: (value: unknown) => void
    gatewayMocks.getThreadGroupsPage.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    const calls = gatewayMocks.getThreadGroupsPage.mock.calls.length
    const loading = state.refreshAll({ includeSelectedThreadMessages: false })
    await vi.waitFor(() => expect(gatewayMocks.getThreadGroupsPage.mock.calls.length).toBeGreaterThan(calls))
    notify({ method: 'turn/started', params: { threadId: 'live', turn: { id: 'new' } } })
    release({ groups: [{ projectName: 'p', threads: [thread('live', '/p')] }], nextCursor: null })
    await loading
    expect(state.projectGroups.value.flatMap(group => group.threads)[0].inProgress).toBe(true)
    state.stopPolling()
  })
})

it('initializes saved defaults on explicit composer reentry without overwriting later manual choices', () => {
  installTestWindow()
  const state = useDesktopState()
  state.primeSelectedThread('')
  state.setSelectedModelId('legacy-model')
  state.configureWebDefaults({ model: 'new-model', provider: 'codex', effort: 'low', tier: 'priority' }, true)
  expect(state.selectedModelId.value).toBe('legacy-model')
  state.initializeWebConversation('')
  expect(state.selectedModelId.value).toBe('new-model')
  expect(state.selectedSpeedMode.value).toBe('priority')
  state.setSelectedReasoningEffort('high')
  expect(state.selectedReasoningEffort.value).toBe('high')
  state.initializeWebConversation('')
  expect(state.selectedReasoningEffort.value).toBe('low')
})

it('lets the new-thread composer override a saved default model for the pending session', () => {
  installTestWindow()
  const state = useDesktopState()
  const desired = { model: 'gpt-6-astra', provider: 'codex', effort: 'ultra', tier: 'priority' }
  state.configureWebDefaults(desired, true)
  state.initializeWebConversation('')

  state.setSelectedModelIdForThread('__new-thread__', 'gpt-5.6-sol')

  expect(state.selectedModelId.value).toBe('gpt-5.6-sol')
  expect(state.readModelIdForThread('__new-thread__')).toBe('gpt-5.6-sol')
  expect(state.webPreferenceState.value.defaults).toEqual(desired)
  expect(state.webPreferenceState.value.threads).toEqual({})
})

it('restores the preferred model after account catalog changes without rewriting defaults', async () => {
  installTestWindow()
  gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
  gatewayMocks.getCurrentModelConfig.mockResolvedValue({ model: 'gpt-6-astra', providerId: 'codex', reasoningEffort: 'ultra', speedMode: '' })
  gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-6-astra', 'gpt-5.6-sol'])
  const state = useDesktopState()
  state.primeSelectedThread('')
  const desired = { model: 'gpt-6-astra', provider: 'codex', effort: 'ultra', tier: '' }
  state.configureWebDefaults(desired, true)
  state.initializeWebConversation('')
  await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
  expect(state.selectedModelId.value).toBe('gpt-6-astra')
  gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-5.6-luna', 'gpt-5.6-sol'])
  await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
  expect(state.selectedModelId.value).toBe('gpt-5.6-sol')
  expect(state.webPreferenceState.value.defaults).toEqual(desired)
  gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-6-astra', 'gpt-5.6-sol'])
  await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
  expect(state.selectedModelId.value).toBe('gpt-6-astra')
  expect(state.webPreferenceState.value.defaults).toEqual(desired)
  state.stopPolling()
})

describe('completion read acknowledgement while viewing a conversation', () => {
  async function setup(visible: boolean, routeVisible = true) {
    installTestWindow()
    vi.stubGlobal('document', { visibilityState: visible ? 'visible' : 'hidden' })
    let notify!: (notification: { method: string; params: unknown }) => void
    gatewayMocks.subscribeCodexNotifications.mockImplementation(handler => { notify = handler; return vi.fn() })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [{ projectName: 'p', threads: [thread('live', '/p'), thread('other', '/p')] }], nextCursor: null })
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) })
    vi.stubGlobal('fetch', request)
    const state = useDesktopState({ isThreadVisible: () => routeVisible })
    state.primeSelectedThread('live')
    state.startPolling()
    await state.refreshAll({ includeSelectedThreadMessages: false })
    return { state, request, complete: (token: string, threadId = 'live') => notify({ method: 'codexapp/completions/changed', params: { threadId, token } }) }
  }

  it('acknowledges the visible completed turn once and leaves no blue dot after switching away', async () => {
    const { state, request, complete } = await setup(true)
    complete('turn-one')
    complete('turn-one')
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ threadId: 'live', token: 'turn-one' })
    await Promise.resolve()
    state.primeSelectedThread('other')
    expect(state.projectGroups.value[0].threads.find(row => row.id === 'live')?.unread).toBe(false)
    state.stopPolling()
  })

  it.each(['http', 'network'])('retries the same completion after a %s failure', async failure => {
    const { state, request, complete } = await setup(true)
    if (failure === 'http') request.mockResolvedValueOnce({ ok: false, status: 503 })
    else request.mockRejectedValueOnce(new Error('Network unavailable'))
    complete('retry-token')
    await new Promise(resolve => setTimeout(resolve, 0))
    state.markThreadAsRead('live')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(request).toHaveBeenCalledTimes(2)
    state.markThreadAsRead('live')
    expect(request).toHaveBeenCalledTimes(2)
    state.stopPolling()
  })

  it('ignores an old acknowledgement and allows a new request after polling restarts', async () => {
    const { state, request, complete } = await setup(true)
    let finishOld!: (value: unknown) => void
    request.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
    complete('shared-token')
    state.stopPolling()
    state.startPolling()
    await state.refreshAll({ includeSelectedThreadMessages: false })
    complete('shared-token')
    finishOld({ ok: true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(request).toHaveBeenCalledTimes(2)
    state.stopPolling()
  })

  it.each([[false, true], [true, false]])('preserves unread when page visible=%s and conversation route visible=%s', async (visible, routeVisible) => {
    const { state, request, complete } = await setup(visible, routeVisible)
    complete('unseen')
    expect(request).not.toHaveBeenCalled()
    state.primeSelectedThread('other')
    expect(state.projectGroups.value[0].threads.find(row => row.id === 'live')?.unread).toBe(true)
    state.stopPolling()
  })

  it('preserves a background completion while acknowledging the viewed conversation', async () => {
    const { state, request, complete } = await setup(true)
    complete('background', 'other')
    expect(request).not.toHaveBeenCalled()
    expect(state.projectGroups.value[0].threads.find(row => row.id === 'other')?.unread).toBe(true)
    state.stopPolling()
  })

  it('keeps a newer unseen completion when an older visible acknowledgement returns late', async () => {
    const { state, request, complete } = await setup(true)
    let finish!: (value: unknown) => void
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    complete('old-visible')
    state.primeSelectedThread('other')
    complete('new-unseen')
    finish({ ok: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(state.projectGroups.value[0].threads.find(row => row.id === 'live')?.unread).toBe(true)
    state.stopPolling()
  })
})

describe('image delivery optimistic reconciliation', () => {
  it.each(['matching', 'absent', 'different', 'different-ordinal'])('reconciles image echoes with identity=%s', async (identity) => {
    installTestWindow()
    let notify!: (event: { method: string; params: unknown }) => void
    gatewayMocks.subscribeCodexNotifications.mockImplementation(handler => { notify = handler; return vi.fn() })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    const empty = { messages: [], inProgress: false, activeTurnId: '', turnIndexByTurnId: {}, hasMoreOlder: false }
    gatewayMocks.getThreadDetail.mockResolvedValue(empty)
    gatewayMocks.startThreadTurn.mockResolvedValue('image-turn')
    const state = useDesktopState()
    state.primeSelectedThread('image-thread')
    state.startPolling()
    await state.loadMessages('image-thread')
    await state.sendMessageToSelectedThread('看图片', ['http://127.0.0.1:4173/codex-local-image?path=%2Ftmp%2Fimage.png'])
    const deliveryId = gatewayMocks.startThreadTurn.mock.calls.at(-1)?.[10].id
    expect(state.messages.value.filter(row => row.role === 'user')).toHaveLength(1)
    gatewayMocks.getThreadDetail.mockResolvedValue({ ...empty, inProgress: true, activeTurnId: 'image-turn', messages: [{
      id: 'native-image', role: 'user', text: '看图片', turnId: 'image-turn', userMessageOrdinal: identity === 'different-ordinal' ? 1 : 0,
      images: ['/codex-local-image?path=%2Ftmp%2Fimage.png'], fileAttachments: [{ label: 'image.png', path: '/tmp/image.png', fsPath: '/tmp/image.png' }],
      clientUserMessageId: identity === 'matching' ? deliveryId : identity === 'different' ? 'another-delivery' : undefined, messageType: 'userMessage',
    }] })
    notify({ method: 'turn/completed', params: { threadId: 'image-thread', turn: { id: 'image-turn', status: 'completed' } } })
    await state.loadMessages('image-thread')
    const users = state.messages.value.filter(row => row.role === 'user')
    expect(users).toHaveLength(identity === 'different' || identity === 'different-ordinal' ? 2 : 1)
    expect(users.some(row => row.id === 'native-image')).toBe(true)
    expect(gatewayMocks.startThreadTurn).toHaveBeenCalledTimes(1)
    state.stopPolling()
  })
})

it('retries a failed conversation immediately after the account identity changes', async () => {
  installTestWindow()
  gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [{ projectName: 'p', threads: [thread('account-chat', '/p')] }], nextCursor: null })
  gatewayMocks.getCurrentModelConfig.mockResolvedValue({ model: 'gpt-6-astra', providerId: 'openai', reasoningEffort: 'medium', speedMode: '' })
  gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-6-astra', 'gpt-5.6-terra'])
  gatewayMocks.getThreadDetail.mockRejectedValueOnce(new Error('thread not loaded')).mockResolvedValue({ model: 'gpt-6-astra', modelProvider: 'openai', messages: [{ id: 'reply', role: 'assistant', text: 'Recovered history' }], inProgress: false, activeTurnId: '', turnIndexByTurnId: {} })
  const state = useDesktopState()
  state.primeSelectedThread('account-chat')
  await expect(state.loadMessages('account-chat')).rejects.toThrow('not loaded')
  await state.refreshAll({ accountChanged: true, includeSelectedThreadMessages: true, awaitAncillaryRefreshes: true })
  expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(2)
  expect(state.messages.value.some(message => message.text === 'Recovered history')).toBe(true)
})

it('preserves an existing conversation model while a restricted account temporarily uses Terra', async () => {
  installTestWindow({ 'codex-web-local.selected-model-by-context.v1': JSON.stringify({ 'astra-chat': 'gpt-6-astra', 'terra-chat': 'gpt-5.6-terra' }) })
  gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [{ projectName: 'p', threads: [thread('astra-chat', '/p'), thread('terra-chat', '/p')] }], nextCursor: null })
  gatewayMocks.getCurrentModelConfig.mockResolvedValue({ model: 'gpt-5.6-terra', providerId: 'openai', reasoningEffort: 'medium', speedMode: '' })
  gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-5.6-terra'])
  const state = useDesktopState()
  state.primeSelectedThread('astra-chat')
  await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
  expect(state.selectedModelId.value).toBe('gpt-5.6-terra')
  expect(JSON.parse(window.localStorage.getItem('codex-web-local.selected-model-by-context.v1')!)['astra-chat']).toBe('gpt-6-astra')
  gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-6-astra', 'gpt-5.6-terra'])
  await state.refreshAll({ accountChanged: true, includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
  expect(state.selectedModelId.value).toBe('gpt-6-astra')
  expect(state.readModelIdForThread('astra-chat')).toBe('gpt-6-astra')
})

it('discards a delayed failure from the previous account and loads the current identity', async () => {
  installTestWindow()
  gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [{ projectName: 'p', threads: [thread('race-chat', '/p')] }], nextCursor: null })
  gatewayMocks.getCurrentModelConfig.mockResolvedValue({ model: 'gpt-6-astra', providerId: 'openai', reasoningEffort: 'medium', speedMode: '' })
  gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-6-astra'])
  let reject!: (cause: Error) => void
  gatewayMocks.getThreadDetail.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail })).mockResolvedValue({ model: 'gpt-6-astra', modelProvider: 'openai', messages: [{ id: 'new', role: 'assistant', text: 'New account history' }], inProgress: false, activeTurnId: '', turnIndexByTurnId: {} })
  const state = useDesktopState()
  state.primeSelectedThread('race-chat')
  const old = state.loadMessages('race-chat')
  const changed = state.refreshAll({ accountChanged: true, includeSelectedThreadMessages: true, awaitAncillaryRefreshes: true })
  reject(new Error('previous account failed'))
  await Promise.all([old, changed])
  expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(2)
  expect(state.messages.value.some(message => message.text === 'New account history')).toBe(true)
  expect(state.error.value).toBe('')
})

it('discards a stale thread list from the previous account', async () => {
  installTestWindow()
  let releasePrevious!: (page: Awaited<ReturnType<typeof gatewayMocks.getThreadGroupsPage>>) => void
  gatewayMocks.getThreadGroupsPage
    .mockImplementationOnce(() => new Promise(resolve => { releasePrevious = resolve }))
    .mockResolvedValueOnce({
      groups: [{ projectName: 'current', threads: [thread('current-chat', '/current')] }],
      nextCursor: null,
    })
    .mockResolvedValue({
      groups: [{ projectName: 'previous', threads: [thread('previous-chat', '/previous')] }],
      nextCursor: null,
    })
  gatewayMocks.getCurrentModelConfig.mockResolvedValue({ model: 'gpt-6-astra', providerId: 'openai', reasoningEffort: 'medium', speedMode: '' })
  gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-6-astra'])
  let startCurrent!: () => void
  gatewayMocks.getThreadQueueState
    .mockImplementationOnce(() => Promise.resolve())
    .mockImplementationOnce(() => new Promise(resolve => { startCurrent = () => resolve({}) }))
  const state = useDesktopState()
  const previousRefresh = state.refreshAll({ includeSelectedThreadMessages: false })
  await vi.waitFor(() => expect(gatewayMocks.getThreadGroupsPage).toHaveBeenCalledTimes(1))
  await Promise.resolve()
  const currentRefresh = state.refreshAll({ accountChanged: true, includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
  await vi.waitFor(() => expect(typeof startCurrent).toBe('function'))
  releasePrevious({
    groups: [{ projectName: 'previous', threads: [thread('previous-chat', '/previous')] }],
    nextCursor: null,
  })
  startCurrent()
  await Promise.all([previousRefresh, currentRefresh])
  expect(gatewayMocks.getThreadGroupsPage.mock.calls.length).toBeGreaterThan(1)

  expect(state.projectGroups.value.map(group => group.projectName)).toEqual(['current'])
})

it('discards a stale thread-list failure and reloads after an account switch', async () => {
  installTestWindow()
  let failPrevious!: (cause: unknown) => void
  gatewayMocks.getThreadGroupsPage
    .mockImplementationOnce(() => new Promise((_, reject) => { failPrevious = reject }))
    .mockResolvedValueOnce({
      groups: [{ projectName: 'current', threads: [thread('current-chat', '/current')] }],
      nextCursor: null,
    })
  gatewayMocks.getCurrentModelConfig.mockResolvedValue({ model: 'gpt-6-astra', providerId: 'openai', reasoningEffort: 'medium', speedMode: '' })
  gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-6-astra'])
  const state = useDesktopState()
  const previousRefresh = state.refreshAll({ includeSelectedThreadMessages: false })
  await vi.waitFor(() => expect(typeof failPrevious).toBe('function'))
  state.stopPolling()
  const currentRefresh = state.refreshAll({ accountChanged: true, includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
  await vi.waitFor(() => expect(gatewayMocks.getThreadGroupsPage).toHaveBeenCalledTimes(2))
  failPrevious(new Error('previous account failed'))
  await Promise.all([previousRefresh.catch(() => undefined), currentRefresh])

  expect(state.projectGroups.value.map(group => group.projectName)).toEqual(['current'])
  expect(state.isLoadingThreads.value).toBe(false)
  expect(state.error.value).toBe('')
  state.startPolling()
})

it('clears initial thread-list loading immediately on an account switch', async () => {
  installTestWindow()
  let releasePrevious!: (page: { groups: UiProjectGroup[]; nextCursor: string | null }) => void
  gatewayMocks.getThreadGroupsPage
    .mockImplementationOnce(() => new Promise(resolve => { releasePrevious = resolve }))
    .mockResolvedValueOnce({
      groups: [{ projectName: 'current', threads: [thread('current-chat', '/current')] }],
      nextCursor: null,
    })
  gatewayMocks.getCurrentModelConfig.mockResolvedValue({ model: 'gpt-6-astra', providerId: 'openai', reasoningEffort: 'medium', speedMode: '' })
  gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-6-astra'])
  const state = useDesktopState()
  const previousRefresh = state.refreshAll({ includeSelectedThreadMessages: false })
  await vi.waitFor(() => expect(state.isLoadingThreads.value).toBe(true))
  state.stopPolling()
  const currentRefresh = state.refreshAll({ accountChanged: true, includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

  expect(state.isLoadingThreads.value).toBe(false)
  releasePrevious({
    groups: [{ projectName: 'previous', threads: [thread('previous-chat', '/previous')] }],
    nextCursor: null,
  })
  await Promise.all([previousRefresh, currentRefresh])
  await vi.waitFor(() => expect(state.projectGroups.value.map(group => group.projectName)).toEqual(['current']))
  expect(state.isLoadingThreads.value).toBe(false)
  state.startPolling()
})

it('discards a delayed remaining thread page from the previous account', async () => {
  installTestWindow()
  const backgroundTimeouts: Array<() => void> = []
  vi.mocked(window.setTimeout).mockImplementation(((callback: () => void) => {
    backgroundTimeouts.push(callback)
    return backgroundTimeouts.length
  }) as typeof window.setTimeout)
  let releasePreviousPage!: (page: Awaited<ReturnType<typeof gatewayMocks.getThreadGroupsPage>>) => void
  gatewayMocks.getThreadGroupsPage
    .mockImplementationOnce(() => Promise.resolve({
      groups: [{ projectName: 'previous-first', threads: [thread('previous-first-chat', '/previous-first')] }],
      nextCursor: 'previous-remaining',
    }))
    .mockImplementationOnce(() => new Promise(resolve => { releasePreviousPage = resolve }))
    .mockResolvedValueOnce({
      groups: [{ projectName: 'current', threads: [thread('current-chat', '/current')] }],
      nextCursor: null,
    })
    .mockResolvedValue({
      groups: [{ projectName: 'unreachable', threads: [thread('unreachable-chat', '/unreachable')] }],
      nextCursor: null,
    })
  gatewayMocks.getCurrentModelConfig.mockResolvedValue({ model: 'gpt-6-astra', providerId: 'openai', reasoningEffort: 'medium', speedMode: '' })
  gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-6-astra'])
  const state = useDesktopState()
  await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
  expect(backgroundTimeouts).toHaveLength(1)
  backgroundTimeouts[0]()
  await vi.waitFor(() => expect(gatewayMocks.getThreadGroupsPage).toHaveBeenCalledTimes(2))

  const currentRefresh = state.refreshAll({ accountChanged: true, includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
  releasePreviousPage({
    groups: [{ projectName: 'previous-remaining', threads: [thread('previous-remaining-chat', '/previous-remaining')] }],
    nextCursor: null,
  })
  await currentRefresh

  expect(gatewayMocks.getThreadGroupsPage).toHaveBeenCalledTimes(3)
  expect(state.projectGroups.value.map(group => group.projectName)).toEqual(['current'])
  expect(state.isThreadListFullyLoaded.value).toBe(true)
})

it('re-resumes an already cached idle conversation after switching accounts', async () => {
  installTestWindow()
  gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [{ projectName: 'p', threads: [thread('cached-chat', '/p')] }], nextCursor: null })
  gatewayMocks.getCurrentModelConfig.mockResolvedValue({ model: 'gpt-6-astra', providerId: 'openai', reasoningEffort: 'medium', speedMode: '' })
  gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-6-astra'])
  gatewayMocks.getThreadDetail.mockResolvedValue({ model: 'gpt-6-astra', modelProvider: 'openai', messages: [], inProgress: false, activeTurnId: '', turnIndexByTurnId: {} })
  const state = useDesktopState()
  state.primeSelectedThread('cached-chat')
  await state.loadMessages('cached-chat')
  await state.refreshAll({ accountChanged: true, includeSelectedThreadMessages: true, awaitAncillaryRefreshes: true })
  expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(2)
})

it('forks a completed response while its source conversation continues another turn', async () => {
  installTestWindow()
  gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [{ projectName: 'p', threads: [{ ...thread('busy-source', '/p'), inProgress: true }, thread('fork-result', '/p')] }], nextCursor: null })
  gatewayMocks.getThreadDetail.mockImplementation(async (id: string) => ({ model: 'gpt-6-astra', modelProvider: 'openai', messages: id === 'busy-source' ? [{ id: 'answer', role: 'assistant', text: 'Completed answer', turnId: 'completed-turn' }] : [], inProgress: id === 'busy-source', activeTurnId: id === 'busy-source' ? 'running-turn' : '', turnIndexByTurnId: {} }))
  gatewayMocks.forkThreadAtTurn.mockResolvedValue({ threadId: 'fork-result', model: 'gpt-6-astra', modelProvider: 'openai' })
  const state = useDesktopState()
  state.primeSelectedThread('busy-source')
  await state.loadMessages('busy-source')
  expect(await state.forkThreadFromTurn('busy-source', 'completed-turn')).toBe('fork-result')
  expect(gatewayMocks.forkThreadAtTurn).toHaveBeenCalledWith('busy-source', 'completed-turn')
  expect(gatewayMocks.interruptThreadTurn).not.toHaveBeenCalled()
})

it('retains a new idle fork across stale list responses until the server lists it', async () => {
  installTestWindow()
  gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [{ projectName: 'p', threads: [thread('source', '/p')] }], nextCursor: null })
  gatewayMocks.forkThread.mockResolvedValue({ threadId: 'new-fork', model: 'gpt-6-astra' })
  gatewayMocks.getThreadDetail.mockResolvedValue({ messages: [], inProgress: false, activeTurnId: '', turnIndexByTurnId: {} })
  const state = useDesktopState()
  await state.refreshAll({ includeSelectedThreadMessages: false, forceThreadRefresh: true })
  expect(await state.forkThreadById('source')).toBe('new-fork')
  const ids = () => state.projectGroups.value.flatMap(group => group.threads.map(row => row.id))
  expect(ids()).toContain('new-fork')
  await state.refreshAll({ includeSelectedThreadMessages: false, forceThreadRefresh: true })
  expect(ids()).toContain('new-fork')
  gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [{ projectName: 'p', threads: [thread('source', '/p'), thread('new-fork', '/p')] }], nextCursor: null })
  await state.refreshAll({ includeSelectedThreadMessages: false, forceThreadRefresh: true })
  expect(ids().filter(id => id === 'new-fork')).toHaveLength(1)
  gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [{ projectName: 'p', threads: [thread('source', '/p')] }], nextCursor: null })
  await state.refreshAll({ includeSelectedThreadMessages: false, forceThreadRefresh: true })
  await state.archiveThreadById('new-fork')
  expect(ids()).not.toContain('new-fork')
})

describe('interrupt stop admission and request lifecycle', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (cause: Error) => void
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
  }

  function setup() {
    installTestWindow()
    let notify!: (event: { method: string; params: unknown }) => void
    gatewayMocks.subscribeCodexNotifications.mockReset().mockImplementation(handler => { notify = handler; return vi.fn() })
    gatewayMocks.getPendingServerRequests.mockReset().mockResolvedValue([])
    gatewayMocks.getThreadGroupsPage.mockReset().mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getThreadDetail.mockReset().mockResolvedValue({ messages: [], inProgress: true, activeTurnId: 'detail-turn', turnIndexByTurnId: {} })
    gatewayMocks.resumeThread.mockReset().mockResolvedValue({ messages: [], inProgress: true, activeTurnId: 'known-turn', turnIndexByTurnId: {} })
    gatewayMocks.interruptThreadTurn.mockReset().mockResolvedValue(undefined)
    const state = useDesktopState()
    state.primeSelectedThread('source')
    state.startPolling()
    return { state, notify: (event: { method: string; params: unknown }) => notify(event) }
  }

  afterEach(() => {
    gatewayMocks.getThreadDetail.mockReset()
    gatewayMocks.interruptThreadTurn.mockReset()
  })

  it.each(['known-turn', ''])('blocks an interrupt after stop even if an explicit history read reports a running turn: %s', async activeTurnId => {
    const { state } = setup()
    state.stopPolling()
    gatewayMocks.getThreadDetail.mockResolvedValueOnce({ messages: [{ id: 'running', role: 'user', text: 'Running' }], inProgress: true, activeTurnId, turnIndexByTurnId: {} })
    await state.loadMessages('source')
    expect(state.messages.value.some(row => row.id === 'running')).toBe(true)
    const detailReads = gatewayMocks.getThreadDetail.mock.calls.length
    await state.interruptSelectedThreadTurn()
    expect(gatewayMocks.interruptThreadTurn).not.toHaveBeenCalled()
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(detailReads)
    expect(state.isInterruptingTurn.value).toBe(false)
    state.stopPolling()
  })

  it('does not send an old interrupt or retain its recovered turn after a detail read crosses stop/start', async () => {
    const { state, notify } = setup()
    const detail = deferred<unknown>()
    gatewayMocks.getThreadDetail.mockReturnValueOnce(detail.promise)
    notify({ method: 'thread/status/changed', params: { threadId: 'source', status: { type: 'inProgress' } } })
    const previous = state.interruptSelectedThreadTurn()
    state.stopPolling()
    state.startPolling()
    detail.resolve({ activeTurnId: 'old-turn' })
    await previous
    expect(gatewayMocks.interruptThreadTurn).not.toHaveBeenCalled()
    notify({ method: 'thread/status/changed', params: { threadId: 'source', status: { type: 'inProgress' } } })
    await state.interruptSelectedThreadTurn()
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(3)
    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledExactlyOnceWith('source', 'detail-turn')
    state.stopPolling()
  })

  it('does not let an old interrupt finally release the new stop/start request slot', async () => {
    const { state, notify } = setup()
    const previousRequest = deferred<void>()
    const nextRequest = deferred<void>()
    gatewayMocks.interruptThreadTurn.mockReturnValueOnce(previousRequest.promise).mockReturnValueOnce(nextRequest.promise)
    notify({ method: 'turn/started', params: { threadId: 'source', turn: { id: 'old-turn' } } })
    const previous = state.interruptSelectedThreadTurn()
    state.stopPolling()
    state.startPolling()
    notify({ method: 'turn/started', params: { threadId: 'source', turn: { id: 'new-turn' } } })
    const next = state.interruptSelectedThreadTurn()
    previousRequest.resolve()
    await previous
    expect(state.isInterruptingTurn.value).toBe(true)
    expect(gatewayMocks.interruptThreadTurn.mock.calls).toEqual([['source', 'old-turn'], ['source', 'new-turn']])
    nextRequest.resolve()
    await next
    expect(state.isInterruptingTurn.value).toBe(false)
    state.stopPolling()
  })

  it.each(['success', 'failure'])('does not commit an old interrupt %s after stop/start on the same conversation ID', async outcome => {
    const { state, notify } = setup()
    const request = deferred<void>()
    gatewayMocks.interruptThreadTurn.mockReturnValueOnce(request.promise)
    notify({ method: 'turn/started', params: { threadId: 'source', turn: { id: 'old-turn' } } })
    const previous = state.interruptSelectedThreadTurn()
    state.stopPolling()
    state.startPolling()
    notify({ method: 'turn/started', params: { threadId: 'source', turn: { id: 'current-turn' } } })
    const listRequests = gatewayMocks.getThreadGroupsPage.mock.calls.length
    if (outcome === 'success') request.resolve()
    else request.reject(new Error('Old interrupt failed'))
    await previous
    expect(state.error.value).not.toBe('Old interrupt failed')
    expect(gatewayMocks.getThreadGroupsPage).toHaveBeenCalledTimes(listRequests)
    await state.interruptSelectedThreadTurn()
    expect(gatewayMocks.interruptThreadTurn.mock.calls).toEqual([['source', 'old-turn'], ['source', 'current-turn']])
    state.stopPolling()
  })
})

it('snapshots scheduled continuation choices using the same effective model and effort as an ordinary send', async () => {
  installTestWindow({
    'codexapp.web-conversation-preferences.v1': JSON.stringify({ defaults: null, remember: true, threads: {
      scheduled: { source: 'web', saved: { model: 'gpt-6-astra', provider: 'codex', effort: 'high', tier: '' } },
    } }),
  })
  gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
  gatewayMocks.getThreadDetail.mockResolvedValue({ model: 'gpt-6-astra', modelProvider: 'codex', messages: [], inProgress: false, activeTurnId: '', turnIndexByTurnId: {} })
  gatewayMocks.getCurrentModelConfig.mockResolvedValue({ model: 'gpt-5.6-sol', providerId: 'codex', reasoningEffort: 'high', speedMode: '' })
  gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-5.6-sol'])
  gatewayMocks.startThreadTurn.mockResolvedValue('own-turn')
  const state = useDesktopState()
  state.primeSelectedThread('scheduled')
  await state.loadMessages('scheduled')
  await state.refreshAll({ includeThreads: false, includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
  const choice = state.readConversationChoice('scheduled')!
  expect(choice.model).toBe('gpt-5.6-sol')
  expect(gatewayMocks.resumeThread).not.toHaveBeenCalled()
  await state.sendMessageToSelectedThread('继续之前的工作')
  expect(gatewayMocks.startThreadTurn.mock.calls[0][3]).toBe(choice.model)
  expect(gatewayMocks.startThreadTurn.mock.calls[0][4]).toBe(choice.effort)
  expect(state.webPreferenceState.value.threads.scheduled.saved.model).toBe('gpt-6-astra')
  state.stopPolling()
})
