import { normalizeModelCapability } from '../modelCapabilities'
import { applyThreadQueueOperation, type ThreadQueueState } from '../threadQueue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildWorkspaceRootsProjectOrderState,
  collectWorkspaceRootPathsForProjectRemoval,
  filterGroupsByWorkspaceRoots,
  findAdjacentThreadId,
  removeThreadFromGroups,
  useDesktopState,
} from './useDesktopState'
import type { UiProjectGroup } from '../types/codex'
import type { WorkspaceRootsState } from '../api/codexGateway'

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

vi.mock('../api/codexGateway', () => ({
  ...gatewayMocks,
  invalidateModelCatalog: vi.fn(),
  invalidateThreadResumeCache: vi.fn(),
  getAvailableModels: async (options: unknown) => (await gatewayMocks.getAvailableModelIds(options) || []).map((id: string) => normalizeModelCapability(id)! ),
  getBackgroundThreadListLimit: vi.fn(() => 100),
  pickCodexRateLimitSnapshot: vi.fn(() => null),
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
  gatewayMocks.getThreadQueueState.mockResolvedValue({})
  gatewayMocks.getDeliveryStatuses.mockResolvedValue([])
  gatewayMocks.getThreadTitleCache.mockResolvedValue({ titles: {} })
  gatewayMocks.getWorkspaceRootsState.mockRejectedValue(new Error('no workspace roots state'))
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
    gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-5.5'])

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
    gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-5.5'])

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
    gatewayMocks.resumeThread.mockResolvedValue({
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
    gatewayMocks.resumeThread.mockResolvedValue({
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
    gatewayMocks.resumeThread.mockRejectedValue(new Error('thread not found'))

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
    expect(gatewayMocks.resumeThread).toHaveBeenCalledTimes(1)
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
  async function busyState() {
    installTestWindow()
    gatewayMocks.resumeThread.mockResolvedValue(null)
    gatewayMocks.getThreadDetail.mockResolvedValue({ messages: [], inProgress: true, activeTurnId: 'turn-queue', turnIndexByTurnId: {}, hasMoreOlder: false })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.subscribeCodexNotifications.mockReturnValue(() => {})
    const state = useDesktopState()
    state.primeSelectedThread('queue-thread')
    await state.loadMessages('queue-thread')
    return state
  }

  it('keeps saved queues when polling is stopped and restarted for account refresh', async () => {
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
})


describe('explicit question answers', () => {
  it('does not intercept ordinary text or steer as an answer to a pending question', async () => {
    installTestWindow()
    let notify: (event: { method: string; params?: unknown }) => void = () => {}
    gatewayMocks.subscribeCodexNotifications.mockImplementation(handler => { notify = handler; return vi.fn() })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.resumeThread.mockResolvedValue({ messages: [], inProgress: false, activeTurnId: '', turnIndexByTurnId: {} })
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
    gatewayMocks.resumeThread.mockResolvedValue({ messages: [{ id: 'message', turnId: 'turn', turnIndex: 0, role: 'user', text: 'preserve this' }], inProgress: false, activeTurnId: '', turnIndexByTurnId: { turn: 0 }, hasMoreOlder: false })
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
    gatewayMocks.resumeThread.mockResolvedValue({ messages: [msg('latest')], inProgress: false, activeTurnId: '', turnIndexByTurnId: { latest: 0 }, hasMoreOlder: true, historyPosition: { source: 'native', nextCursor: 'opaque/+' } })
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

  it('reads a historical question by turn ID when it is outside the latest page', async () => {
    installTestWindow()
    const question = { id: 'q-old', turnId: 'old', turnIndex: 0, role: 'assistant', text: 'choose', questions: [{ title: 'Fruit?', options: ['Pear'] }], questionOrdinal: 0 }
    gatewayMocks.resumeThread.mockResolvedValue({ messages: [question], inProgress: false, activeTurnId: '', turnIndexByTurnId: { old: 0 }, hasMoreOlder: false })
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
    gatewayMocks.resumeThread.mockResolvedValue(empty)
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

  it('shows steering before the HTTP response and retains it while switching conversations', async () => {
    const { state } = setup()
    await state.loadMessages('live')
    let finish!: (turnId: string) => void
    gatewayMocks.startThreadTurn.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve }))
    const pending = state.sendMessageToSelectedThread('visible immediately', [], [], 'steer')
    expect(state.messages.value.find(row => row.text === 'visible immediately')?.deliveryState?.status).toBe('submitting')
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
    gatewayMocks.resumeThread.mockResolvedValue(empty)
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
  gatewayMocks.resumeThread.mockRejectedValueOnce(new Error('thread not loaded')).mockResolvedValue({ model: 'gpt-6-astra', modelProvider: 'openai', messages: [{ id: 'reply', role: 'assistant', text: 'Recovered history' }], inProgress: false, activeTurnId: '', turnIndexByTurnId: {} })
  const state = useDesktopState()
  state.primeSelectedThread('account-chat')
  await expect(state.loadMessages('account-chat')).rejects.toThrow('not loaded')
  await state.refreshAll({ accountChanged: true, includeSelectedThreadMessages: true, awaitAncillaryRefreshes: true })
  expect(gatewayMocks.resumeThread).toHaveBeenCalledTimes(2)
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
  gatewayMocks.resumeThread.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail })).mockResolvedValue({ model: 'gpt-6-astra', modelProvider: 'openai', messages: [{ id: 'new', role: 'assistant', text: 'New account history' }], inProgress: false, activeTurnId: '', turnIndexByTurnId: {} })
  const state = useDesktopState()
  state.primeSelectedThread('race-chat')
  const old = state.loadMessages('race-chat')
  const changed = state.refreshAll({ accountChanged: true, includeSelectedThreadMessages: true, awaitAncillaryRefreshes: true })
  reject(new Error('previous account failed'))
  await Promise.all([old, changed])
  expect(gatewayMocks.resumeThread).toHaveBeenCalledTimes(2)
  expect(state.messages.value.some(message => message.text === 'New account history')).toBe(true)
  expect(state.error.value).toBe('')
})

it('re-resumes an already cached idle conversation after switching accounts', async () => {
  installTestWindow()
  gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [{ projectName: 'p', threads: [thread('cached-chat', '/p')] }], nextCursor: null })
  gatewayMocks.getCurrentModelConfig.mockResolvedValue({ model: 'gpt-6-astra', providerId: 'openai', reasoningEffort: 'medium', speedMode: '' })
  gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-6-astra'])
  gatewayMocks.resumeThread.mockResolvedValue({ model: 'gpt-6-astra', modelProvider: 'openai', messages: [], inProgress: false, activeTurnId: '', turnIndexByTurnId: {} })
  const state = useDesktopState()
  state.primeSelectedThread('cached-chat')
  await state.loadMessages('cached-chat')
  await state.refreshAll({ accountChanged: true, includeSelectedThreadMessages: true, awaitAncillaryRefreshes: true })
  expect(gatewayMocks.resumeThread).toHaveBeenCalledTimes(2)
})

it('forks a completed response while its source conversation continues another turn', async () => {
  installTestWindow()
  gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [{ projectName: 'p', threads: [{ ...thread('busy-source', '/p'), inProgress: true }, thread('fork-result', '/p')] }], nextCursor: null })
  gatewayMocks.resumeThread.mockImplementation(async (id: string) => ({ model: 'gpt-6-astra', modelProvider: 'openai', messages: id === 'busy-source' ? [{ id: 'answer', role: 'assistant', text: 'Completed answer', turnId: 'completed-turn' }] : [], inProgress: id === 'busy-source', activeTurnId: id === 'busy-source' ? 'running-turn' : '', turnIndexByTurnId: {} }))
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
  gatewayMocks.resumeThread.mockResolvedValue({ messages: [], inProgress: false, activeTurnId: '', turnIndexByTurnId: {} })
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
