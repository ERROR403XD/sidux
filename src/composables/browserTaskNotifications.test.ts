import { afterEach, expect, it, vi } from 'vitest'
import { browserNotificationsEnabled, createBrowserTaskNotifications } from './browserTaskNotifications'
import { conversationNoticePreferences } from './conversationNoticePreferences'
import { defaultConversationNoticePreferences, type ConversationNoticeState } from '../conversationNotifications'
import { callRpc } from '../api/rpcGateway'
import { getWorkspaceRootsState } from '../api/projectGateway'
import { t } from './useUiLanguage'
import { automaticResumeStartedMethod } from '../threadAutomaticResume'

vi.mock('../api/rpcGateway', () => ({ callRpc: vi.fn() }))
vi.mock('../api/projectGateway', () => ({ getWorkspaceRootsState: vi.fn(async () => ({ order: [], active: [], labels: {}, projectOrder: [] })) }))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  conversationNoticePreferences.value = defaultConversationNoticePreferences()
})
it('notifies once for completion, interruption and quota failure, suppressing retries and duplicate terminal events', () => {
  const delivered: { title: string; options: NotificationOptions }[] = []
  vi.stubGlobal('Notification', class {
    static permission = 'granted'
    constructor(title: string, options: NotificationOptions) { delivered.push({ title, options }) }
  })
  vi.stubGlobal('navigator', {})
  browserNotificationsEnabled.value = true
  const notify = createBrowserTaskNotifications(() => ({ title: 'Test conversation', projectName: '项目显示名' }))
  const send = (method: string, turnId: string, extra = {}) => notify({ method, params: { threadId: 'thread', turnId, ...extra }, atIso: '' })
  send('error', 'retry', { willRetry: true, error: { message: 'quota' } })
  send('turn/completed', 'done', { turn: { id: 'done', status: 'completed' } })
  send('turn/completed', 'done', { turn: { id: 'done', status: 'completed' } })
  send('turn/cancelled', 'cancelled', { error: { message: 'connection reset' } })
  send('error', 'quota', { error: { message: 'usage limit exceeded' } })
  send('turn/completed', 'quota', { turn: { id: 'quota', status: 'failed' } })
  expect(delivered.map(row => row.options.tag)).toEqual(['sidux:thread:done', 'sidux:thread:cancelled', 'sidux:thread:quota'])
  expect(delivered.every(row => row.options.body === '项目显示名 · Test conversation')).toBe(true)
  expect(delivered[2]?.title).toMatch(/额度|quota/i)
  browserNotificationsEnabled.value = false
  send('turn/cancelled', 'disabled')
  expect(delivered).toHaveLength(3)
  browserNotificationsEnabled.value = true
})

function notificationFixture() {
  const titles: string[] = []
  vi.stubGlobal('Notification', class {
    static permission = 'granted'
    constructor(title: string) { titles.push(title) }
  })
  vi.stubGlobal('navigator', {})
  browserNotificationsEnabled.value = true
  const notify = createBrowserTaskNotifications(() => ({ title: 'Test conversation', projectName: '项目显示名' }))
  return {
    titles,
    send(method: string, threadId: string, turnId: string, extra = {}) {
      notify({ method, params: { threadId, turnId, ...extra }, atIso: '' })
    },
  }
}

it('notifies opted-in resumptions once per delivery without suppressing completion of the same turn', () => {
  const f = notificationFixture()
  f.send(automaticResumeStartedMethod, 'thread', 'silent', { deliveryId: 'disabled', source: 'quota' })
  expect(f.titles).toEqual([])
  expect(callRpc).not.toHaveBeenCalled()
  conversationNoticePreferences.value.states.resumeStarted = true
  f.send(automaticResumeStartedMethod, 'thread', 'turn', { deliveryId: 'attempt', source: 'scheduled' })
  f.send(automaticResumeStartedMethod, 'thread', 'turn', { deliveryId: 'attempt', source: 'scheduled' })
  f.send('turn/completed', 'thread', 'turn', { turn: { id: 'turn', status: 'completed' } })
  f.send(automaticResumeStartedMethod, 'goal', '', { deliveryId: 'first', source: 'quota' })
  f.send(automaticResumeStartedMethod, 'goal', '', { deliveryId: 'first', source: 'quota' })
  f.send(automaticResumeStartedMethod, 'goal', '', { deliveryId: 'second', source: 'quota' })
  expect(f.titles).toEqual([t('定时续跑已启动'), t('会话任务已完成'), t('额度恢复续跑已启动'), t('额度恢复续跑已启动')])
  conversationNoticePreferences.value.states.resumeStarted = false
  f.send(automaticResumeStartedMethod, 'thread', 'later', { deliveryId: 'later', source: 'quota' })
  expect(f.titles).toHaveLength(4)
})

it('silences GOAL stages by default, labels opted-in stages, and still delivers the final completion', () => {
  const f = notificationFixture()
  f.send('thread/goal/updated', 'thread', '', { goal: { status: 'active' } })
  f.send('turn/completed', 'thread', 'silent-stage', { turn: { id: 'silent-stage', status: 'completed' } })
  expect(f.titles).toEqual([])
  expect(callRpc).not.toHaveBeenCalled()
  conversationNoticePreferences.value.goalProgressEnabled = true
  f.send('turn/completed', 'thread', 'enabled-stage', { turn: { id: 'enabled-stage', status: 'completed' } })
  expect(f.titles).toEqual([t('GOAL 阶段完成')])
  conversationNoticePreferences.value.goalProgressEnabled = false
  f.send('thread/goal/updated', 'thread', '', { goal: { status: 'complete' } })
  f.send('turn/completed', 'thread', 'final', { turn: { id: 'final', status: 'completed' } })
  expect(f.titles).toEqual([t('GOAL 阶段完成'), t('会话任务已完成')])
})

it('uses enriched GOAL state after refresh and respects completion categories when progress is enabled', () => {
  const f = notificationFixture()
  const stage = (turnId: string, extra = {}) => f.send('turn/completed', 'thread', turnId, { goalStatus: 'active', turn: { id: turnId, status: 'completed' }, ...extra })
  stage('after-refresh')
  expect(f.titles).toEqual([])
  conversationNoticePreferences.value.goalProgressEnabled = true
  conversationNoticePreferences.value.states.completed = false
  stage('category-disabled')
  stage('automation', { completionKind: 'background' })
  expect(f.titles).toEqual([t('GOAL 阶段完成')])
  conversationNoticePreferences.value.states.automation = false
  stage('automation-disabled', { completionKind: 'background' })
  expect(f.titles).toHaveLength(1)
})

it('cancels a GOAL stage notification when disabled while metadata is loading', async () => {
  const titles: string[] = []
  vi.stubGlobal('Notification', class {
    static permission = 'granted'
    constructor(title: string) { titles.push(title) }
  })
  vi.stubGlobal('navigator', {})
  let finish!: (value: unknown) => void
  vi.mocked(callRpc).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  browserNotificationsEnabled.value = true
  conversationNoticePreferences.value.goalProgressEnabled = true
  const notify = createBrowserTaskNotifications(() => undefined)
  notify({ method: 'turn/completed', params: { threadId: 'external-goal', goalStatus: 'active', turn: { id: 'stage', status: 'completed' } }, atIso: '' })
  await vi.waitFor(() => expect(callRpc).toHaveBeenCalledOnce())
  conversationNoticePreferences.value.goalProgressEnabled = false
  finish({ thread: { title: 'GOAL' } })
  await vi.waitFor(() => expect(getWorkspaceRootsState).toHaveBeenCalledOnce())
  expect(titles).toEqual([])
})

it.each(['turn/completed', 'turn/cancelled'])('retains a retryable quota cause until an error-free %s interruption', method => {
  const f = notificationFixture()
  f.send('error', 'thread', 'turn', { willRetry: true, error: { message: 'usage limit exceeded' } })
  expect(f.titles).toEqual([])
  const terminal = { turn: { id: 'turn', status: 'interrupted', error: null } }
  f.send(method, 'thread', 'turn', terminal)
  f.send(method, 'thread', 'turn', terminal)
  expect(f.titles).toHaveLength(1)
  expect(f.titles[0]).toMatch(/额度|quota/i)
})

it('reports successful recovery as completion and does not carry its quota cause into another turn', () => {
  const f = notificationFixture()
  f.send('error', 'thread', 'recovered', { willRetry: true, error: { message: 'quota' } })
  f.send('turn/completed', 'thread', 'recovered', { turn: { id: 'recovered', status: 'completed', error: null } })
  f.send('turn/cancelled', 'thread', 'next', { error: { message: 'connection reset' } })
  expect(f.titles).toHaveLength(2)
  expect(f.titles[0]).toMatch(/已完成|completed/i)
  expect(f.titles[1]).toMatch(/已中断|interrupted/i)
})

it('associates quota causes with both the conversation and turn', () => {
  const f = notificationFixture()
  f.send('error', 'thread', 'quota-turn', { willRetry: true, error: { message: 'rate limit exceeded' } })
  f.send('turn/cancelled', 'thread', 'other-turn', { error: { message: 'connection reset' } })
  f.send('turn/cancelled', 'other-thread', 'quota-turn', { error: { message: 'connection reset' } })
  f.send('turn/cancelled', 'thread', 'quota-turn')
  expect(f.titles).toHaveLength(3)
  expect(f.titles[0]).toMatch(/已中断|interrupted/i)
  expect(f.titles[1]).toMatch(/已中断|interrupted/i)
  expect(f.titles[2]).toMatch(/额度|quota/i)
})

it('does not classify a retryable network failure as a quota interruption', () => {
  const f = notificationFixture()
  f.send('error', 'thread', 'turn', { willRetry: true, error: { message: 'connection reset' } })
  expect(f.titles).toEqual([])
  f.send('turn/cancelled', 'thread', 'turn')
  expect(f.titles).toHaveLength(1)
  expect(f.titles[0]).toMatch(/已中断|interrupted/i)
})

const terminalCases: { state: ConversationNoticeState; method: string; extra: object }[] = [
  { state: 'completed', method: 'turn/completed', extra: { turn: { id: 'turn', status: 'completed' } } },
  { state: 'quota', method: 'error', extra: { error: { message: 'usage limit exceeded' } } },
  { state: 'interrupted', method: 'turn/cancelled', extra: { error: { message: 'connection reset' } } },
  { state: 'automation', method: 'turn/completed', extra: { completionKind: 'background', turn: { id: 'turn', status: 'completed' } } },
]
it.each(['turn/completed', 'turn/cancelled'])('does not notify or read metadata for a manual %s stop', method => {
  const f = notificationFixture()
  f.send(method, 'thread', 'plain-stop', { turn: { id: 'plain-stop', status: 'interrupted', error: null } })
  f.send('error', 'thread', 'retry-stop', { willRetry: true, error: { message: 'quota exceeded' } })
  f.send(method, 'thread', 'retry-stop', { interruptionReason: 'user', turn: { id: 'retry-stop', status: 'interrupted', error: { message: 'quota exceeded' } } })
  f.send('error', 'thread', 'retry-stop', { interruptionReason: 'user', error: { message: 'connection reset' } })
  expect(f.titles).toEqual([])
  expect(callRpc).not.toHaveBeenCalled()
  expect(getWorkspaceRootsState).not.toHaveBeenCalled()
  f.send('turn/completed', 'thread', 'next', { turn: { id: 'next', status: 'completed' } })
  expect(f.titles).toHaveLength(1)
})

it.each(terminalCases)('filters $state notifications independently of the POST channel switch', ({ state, method, extra }) => {
  const f = notificationFixture()
  conversationNoticePreferences.value.postEnabled = false
  conversationNoticePreferences.value.states[state] = false
  f.send(method, 'thread', 'turn', extra)
  expect(f.titles).toEqual([])
  conversationNoticePreferences.value.states[state] = true
  f.send(method, 'another-thread', 'turn', extra)
  expect(f.titles).toHaveLength(1)
})

it('captures the completion title before waiting for the cross-tab lock', async () => {
  let title = '完成时的标题'
  let projectName = '完成时的项目'
  let releaseLock: (() => void) | undefined
  const delivered: NotificationOptions[] = []
  vi.stubGlobal('Notification', class {
    static permission = 'granted'
    constructor(_title: string, options: NotificationOptions) { delivered.push(options) }
  })
  vi.stubGlobal('navigator', { locks: { request: vi.fn((_key, callback) => new Promise(resolve => { releaseLock = () => resolve(callback()) })) } })
  browserNotificationsEnabled.value = true
  const notify = createBrowserTaskNotifications(() => ({ title, projectName }))
  notify({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } }, atIso: '' })
  title = '之后改名'
  projectName = '之后项目改名'
  releaseLock!()
  await vi.waitFor(() => expect(delivered).toHaveLength(1))
  expect(delivered[0]?.body).toBe('完成时的项目 · 完成时的标题')
  expect(callRpc).not.toHaveBeenCalled()
})

it('reads metadata without history when an external automation conversation is absent from the sidebar', async () => {
  const delivered: NotificationOptions[] = []
  vi.stubGlobal('Notification', class {
    static permission = 'granted'
    constructor(_title: string, options: NotificationOptions) { delivered.push(options) }
  })
  vi.stubGlobal('navigator', {})
  vi.mocked(callRpc).mockResolvedValueOnce({ thread: { title: '外部 POST 自动化标题' } })
  browserNotificationsEnabled.value = true
  const notify = createBrowserTaskNotifications(() => undefined)
  const event = { method: 'turn/completed', params: { threadId: 'external', completionKind: 'background', turn: { id: 'turn', status: 'completed' } }, atIso: '' }
  notify(event)
  notify(event)
  await vi.waitFor(() => expect(delivered).toHaveLength(1))
  expect(delivered[0]?.body).toBe(`${t('无项目')} · 外部 POST 自动化标题`)
  expect(callRpc).toHaveBeenCalledExactlyOnceWith('thread/read', { threadId: 'external', includeTurns: false })
})

it.each([
  ['/code/Sidux', '项目别名'],
  ['/root/Documents/Codex/2026-10-18/task', '虚拟管理项目'],
  ['/root/Documents/Codex/2026-10-18/ungrouped', '无项目'],
])('includes the project name for unlisted automation at %s', async (cwd, projectName) => {
  const delivered: NotificationOptions[] = []
  vi.stubGlobal('Notification', class {
    static permission = 'granted'
    constructor(_title: string, options: NotificationOptions) { delivered.push(options) }
  })
  vi.stubGlobal('navigator', {})
  vi.mocked(getWorkspaceRootsState).mockResolvedValueOnce({
    order: ['/code/Sidux'], active: [], projectOrder: [], labels: { '/code/Sidux': '项目别名' },
    virtualProjects: [{ id: 'virtual:fixture', label: '虚拟管理项目', cwds: ['/root/Documents/Codex/2026-10-18/task'] }],
  })
  vi.mocked(callRpc).mockResolvedValueOnce({ thread: { title: '外部任务', cwd } })
  browserNotificationsEnabled.value = true
  const notify = createBrowserTaskNotifications(() => undefined)
  notify({ method: 'turn/completed', params: { threadId: 'external', completionKind: 'background', turn: { id: 'turn', status: 'completed' } }, atIso: '' })
  await vi.waitFor(() => expect(delivered).toHaveLength(1))
  expect(delivered[0]?.body).toBe(`${projectName === '无项目' ? t('无项目') : projectName} · 外部任务`)
})

it('serializes missing metadata reads during a burst of external completions', async () => {
  vi.stubGlobal('Notification', class { static permission = 'granted' })
  vi.stubGlobal('navigator', {})
  const finish: Array<(value: unknown) => void> = []
  vi.mocked(callRpc).mockImplementation(() => new Promise(resolve => { finish.push(resolve as (value: unknown) => void) }))
  browserNotificationsEnabled.value = true
  const notify = createBrowserTaskNotifications(() => undefined)
  for (const threadId of ['one', 'two', 'three']) {
    notify({ method: 'turn/completed', params: { threadId, completionKind: 'background', turn: { id: 'turn', status: 'completed' } }, atIso: '' })
  }
  await vi.waitFor(() => expect(callRpc).toHaveBeenCalledTimes(1))
  finish[0]!({ thread: { title: 'one' } })
  await vi.waitFor(() => expect(callRpc).toHaveBeenCalledTimes(2))
  finish[1]!({ thread: { title: 'two' } })
  await vi.waitFor(() => expect(callRpc).toHaveBeenCalledTimes(3))
  finish[2]!({ thread: { title: 'three' } })
  await Promise.resolve()
})
