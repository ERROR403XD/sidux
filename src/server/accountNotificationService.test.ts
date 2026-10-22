import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { AccountNotificationService } from './accountNotificationService'
import { defaultNoticeRule, defaultNotificationSettings, renderNoticeBody, parseResetExpiryLeadTimes } from '../accountNotifications'
import type { AccountAuthCoordinator } from './accountAuthCoordinator'
import { AccountAuthStore, type StoredAccountEntry } from './accountAuthStore'
import { defaultConversationNoticePreferences, type ConversationNoticeState } from '../conversationNotifications'
import { bindConversationNotifications } from './conversationNotificationBinding'
import { automaticResumeStartedMethod } from '../threadAutomaticResume'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
function entry(reset: number, used: number): StoredAccountEntry {
  return { storageId: 'account-a', accountId: 'identity-a', email: 'example@test', quotaStatus: 'ready', quotaSnapshot: { primary: { windowMinutes: 300, resetsAt: reset, usedPercent: used }, secondary: { windowMinutes: 10080, resetsAt: reset, usedPercent: used } } } as StoredAccountEntry
}
async function fixture() {
  const codexHome = await mkdtemp(join(tmpdir(), 'account-notify-'))
  cleanup.push(() => rm(codexHome, { recursive: true, force: true }))
  let state = { accounts: [entry(100, 80)] }
  const coordinator = { store: { codexHome, readState: async () => state, updateState: async (fn: any) => { const next = fn(state); state = next.state; return next.result } }, isAccountOperationInProgress: () => false, refreshAccount: vi.fn() } as unknown as AccountAuthCoordinator
  const send = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => new Response('{}', { status: 200 }))
  const service = new AccountNotificationService(coordinator, send as typeof fetch, false)
  cleanup.push(() => service.close())
  await service.save({ settings: { ...defaultNotificationSettings, enabled: true, url: 'http://127.0.0.1/fixture', quietEnabled: true }, accountId: 'account-a', rule: { ...defaultNoticeRule, fiveHour: true, weekly: true }, protectionPercent: 1 })
  return { service, send, coordinator }
}

const conversationCases: { state: ConversationNoticeState; method: string; extra: object }[] = [
  { state: 'completed', method: 'turn/completed', extra: { turn: { id: 'turn', status: 'completed' } } },
  { state: 'quota', method: 'error', extra: { error: { message: 'usage limit exceeded' } } },
  { state: 'interrupted', method: 'turn/cancelled', extra: { error: { message: 'connection reset' } } },
  { state: 'automation', method: 'turn/completed', extra: { completionKind: 'background', turn: { id: 'turn', status: 'completed' } } },
]

it('persists resume receipts separately from completion and drops pending starts when disabled', async () => {
  const { service, send, coordinator } = await fixture()
  const preferences = defaultConversationNoticePreferences()
  preferences.postEnabled = true
  const readContext = vi.fn(async () => ({ title: '续跑会话', projectName: '项目' }))
  const started = { method: automaticResumeStartedMethod, params: { threadId: 'thread', deliveryId: 'attempt', source: 'scheduled', turnId: 'turn' } }
  await service.saveConversationPreferences(preferences)
  await service.observeConversation(started, readContext)
  expect(readContext).not.toHaveBeenCalled()
  preferences.states.resumeStarted = true
  await service.saveConversationPreferences(preferences)
  await Promise.all([service.observeConversation(started, readContext), service.observeConversation(started, readContext)])
  await service.observeConversation({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } }, readContext)
  await service.close()
  const restarted = new AccountNotificationService(coordinator, send as typeof fetch, false)
  cleanup.push(() => restarted.close())
  await restarted.observeConversation(started, readContext)
  await restarted.flush(Date.parse('2026-09-09T01:00:00Z'))
  expect(send.mock.calls.map(row => JSON.parse(String(row[1]?.body)).message)).toEqual([
    '【Sidux】定时续跑已启动：项目 · 续跑会话', '【Sidux】会话任务已完成：项目 · 续跑会话',
  ])
  expect(readContext).toHaveBeenCalledTimes(2)
  await restarted.observeConversation({ method: automaticResumeStartedMethod, params: { threadId: 'goal', deliveryId: 'goal-attempt', source: 'quota' } }, readContext)
  expect((await restarted.snapshot()).pendingCount).toBe(1)
  preferences.states.resumeStarted = false
  await restarted.saveConversationPreferences(preferences)
  expect((await restarted.snapshot()).pendingCount).toBe(0)
  await restarted.flush(Date.parse('2026-09-09T01:00:00Z'))
  expect(send).toHaveBeenCalledTimes(2)
})
it('suppresses ongoing GOAL stages before context I/O and labels them only when opted in', async () => {
  const { service, send } = await fixture()
  await service.saveConversationPreferences({ ...defaultConversationNoticePreferences(), postEnabled: true })
  const readContext = vi.fn(async () => ({ title: '持续目标', projectName: '项目' }))
  const stage = (id: string, extra = {}) => ({ method: 'turn/completed', params: { threadId: 'goal', goalStatus: 'active', turn: { id, status: 'completed' }, ...extra } })
  await service.observeConversation(stage('silent'), readContext)
  expect(readContext).not.toHaveBeenCalled()
  expect((await service.snapshot()).pendingCount).toBe(0)
  await service.saveConversationPreferences({ ...defaultConversationNoticePreferences(), postEnabled: true, goalProgressEnabled: true })
  await service.observeConversation(stage('stage'), readContext)
  await service.flush(Date.parse('2026-09-09T01:00:00Z'))
  expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body)).message).toBe('【Sidux】GOAL 阶段完成：项目 · 持续目标')
  await service.saveConversationPreferences({ ...defaultConversationNoticePreferences(), postEnabled: true })
  await service.observeConversation(stage('final', { goalStatus: 'complete' }), readContext)
  await service.observeConversation({ method: 'error', params: { threadId: 'goal', turnId: 'quota', error: { message: 'quota exceeded' } } }, readContext)
  await service.observeConversation({ method: 'turn/cancelled', params: { threadId: 'goal', turnId: 'network', error: { message: 'connection reset' } } }, readContext)
  await service.flush(Date.parse('2026-09-09T01:00:00Z'))
  expect(send.mock.calls.map(row => JSON.parse(String(row[1]?.body)).message)).toEqual([
    '【Sidux】GOAL 阶段完成：项目 · 持续目标', '【Sidux】会话任务已完成：项目 · 持续目标', '【Sidux】会话额度受限：项目 · 持续目标', '【Sidux】会话任务已中断：项目 · 持续目标',
  ])
})

it('removes persisted GOAL stage notices when disabled without removing final or account notices', async () => {
  const { service, send, coordinator } = await fixture()
  await service.saveConversationPreferences({ ...defaultConversationNoticePreferences(), postEnabled: true, goalProgressEnabled: true })
  const readContext = async () => ({ title: '目标', projectName: '项目' })
  await service.observeConversation({ method: 'turn/completed', params: { threadId: 'goal', goalStatus: 'active', turn: { id: 'stage', status: 'completed' } } }, readContext)
  await service.observeConversation({ method: 'turn/completed', params: { threadId: 'goal', goalStatus: 'complete', turn: { id: 'final', status: 'completed' } } }, readContext)
  await service.observe(entry(100, 80))
  await service.observe(entry(200, 0))
  expect((await service.snapshot()).pendingCount).toBe(4)
  await service.close()
  const restarted = new AccountNotificationService(coordinator, send as typeof fetch, false)
  cleanup.push(() => restarted.close())
  expect((await restarted.conversationPreferences()).goalProgressEnabled).toBe(true)
  await restarted.saveConversationPreferences({ ...defaultConversationNoticePreferences(), postEnabled: true })
  expect((await restarted.snapshot()).pendingCount).toBe(3)
  await restarted.flush(Date.parse('2026-09-09T01:00:00Z'))
  expect(send).toHaveBeenCalledTimes(3)
  expect(send.mock.calls.every(row => !String(row[1]?.body).includes('GOAL 阶段完成'))).toBe(true)
  expect(send.mock.calls.some(row => String(row[1]?.body).includes('会话任务已完成'))).toBe(true)
})

it('rechecks GOAL preferences after async context reads and keeps category filtering', async () => {
  const { service, send } = await fixture()
  const preferences = { ...defaultConversationNoticePreferences(), postEnabled: true, goalProgressEnabled: true }
  await service.saveConversationPreferences(preferences)
  let finish!: (value: { title: string; projectName: string }) => void
  const readContext = vi.fn(() => new Promise<{ title: string; projectName: string }>(resolve => { finish = resolve }))
  const event = { method: 'turn/completed', params: { threadId: 'goal', goalStatus: 'active', completionKind: 'background', turn: { id: 'stage', status: 'completed' } } }
  const work = service.observeConversation(event, readContext)
  await vi.waitFor(() => expect(readContext).toHaveBeenCalledOnce())
  await service.saveConversationPreferences({ ...preferences, goalProgressEnabled: false })
  finish({ title: '目标', projectName: '项目' })
  await work
  expect((await service.snapshot()).pendingCount).toBe(0)
  await service.saveConversationPreferences({ ...preferences, states: { ...preferences.states, automation: false } })
  await service.observeConversation(event, readContext)
  expect(readContext).toHaveBeenCalledOnce()
  await service.flush(Date.parse('2026-09-09T01:00:00Z'))
  expect(send).not.toHaveBeenCalled()
})

it.each(['quota exceeded', 'connection reset'])('retains an automatic interruption cause after a retryable %s error', async message => {
  const { service, send } = await fixture()
  await service.saveConversationPreferences({ ...defaultConversationNoticePreferences(), postEnabled: true })
  const readContext = vi.fn(async () => ({ title: '自动中断', projectName: '项目' }))
  await service.observeConversation({ method: 'error', params: { threadId: 'thread', turnId: 'turn', willRetry: true, error: { message } } }, readContext)
  await service.observeConversation({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'interrupted', error: null } } }, readContext)
  await service.flush(Date.parse('2026-09-09T01:00:00Z'))
  expect(send).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body)).message).toContain(message === 'quota exceeded' ? '额度受限' : '已中断')
})

it.each(['turn/completed', 'turn/cancelled'])('does not enqueue POST or read context for a manual %s stop', async method => {
  const { service, send } = await fixture()
  await service.saveConversationPreferences({ ...defaultConversationNoticePreferences(), postEnabled: true })
  const readContext = vi.fn(async () => ({ title: '手动停止', projectName: '项目' }))
  await service.observeConversation({ method, params: { threadId: 'thread', turn: { id: 'plain-stop', status: 'interrupted', error: null } } }, readContext)
  await service.observeConversation({ method: 'error', params: { threadId: 'thread', turnId: 'retry-stop', willRetry: true, error: { message: 'quota exceeded' } } }, readContext)
  await service.observeConversation({ method, params: { threadId: 'thread', interruptionReason: 'user', turn: { id: 'retry-stop', status: 'failed', error: { message: 'quota exceeded' } } } }, readContext)
  await service.observeConversation({ method: 'error', params: { threadId: 'thread', turnId: 'retry-stop', interruptionReason: 'user', error: { message: 'connection reset' } } }, readContext)
  expect(readContext).not.toHaveBeenCalled()
  expect((await service.snapshot()).pendingCount).toBe(0)
  await service.flush(Date.parse('2026-09-09T01:00:00Z'))
  expect(send).not.toHaveBeenCalled()
  await service.observeConversation({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'next', status: 'completed' } } }, readContext)
  await service.flush(Date.parse('2026-09-09T01:00:00Z'))
  expect(send).toHaveBeenCalledTimes(1)
})

it.each(conversationCases)('shares the $state selector with POST and does no title read for disabled events', async ({ state, method, extra }) => {
  const { service, send } = await fixture()
  const preferences = defaultConversationNoticePreferences()
  preferences.postEnabled = true
  preferences.states[state] = false
  await service.saveConversationPreferences(preferences)
  const readContext = vi.fn(async () => ({ title: '完成时的标题', projectName: '显示项目' }))
  const notification = { method, params: { threadId: 'thread', turnId: 'turn', ...extra } }
  await service.observeConversation(notification, readContext)
  expect(readContext).not.toHaveBeenCalled()
  preferences.states[state] = true
  await service.saveConversationPreferences(preferences)
  await Promise.all([service.observeConversation(notification, readContext), service.observeConversation(notification, readContext)])
  await service.flush(Date.parse('2026-09-09T01:00:00Z'))
  expect(readContext).toHaveBeenCalledExactlyOnceWith('thread')
  expect(send).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body)).message).toContain('完成时的标题')
})

it('preserves the completion title and receipts across restart and quiet-hour deferral', async () => {
  const { service, send, coordinator } = await fixture()
  await service.saveConversationPreferences({ ...defaultConversationNoticePreferences(), postEnabled: true })
  let projectName = '虚拟项目含引号"和换行\n'
  let title = '标题含周额度 "和换行\n'
  const readContext = vi.fn(async () => ({ title, projectName }))
  const event = { method: 'turn/completed', params: { threadId: 'external-post', completionKind: 'background', turn: { id: 'turn', status: 'completed' } } }
  await service.observeConversation(event, readContext)
  await service.flush(Date.parse('2026-09-08T15:00:00Z'))
  expect(send).not.toHaveBeenCalled()
  await service.close()
  title = '之后改名'
  projectName = '项目也改名'
  const restarted = new AccountNotificationService(coordinator, send as typeof fetch, false)
  cleanup.push(() => restarted.close())
  await restarted.observeConversation(event, readContext)
  await restarted.flush(Date.parse('2026-09-09T01:00:00Z'))
  expect(send).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body)).message).toBe('【Sidux】自动化任务已完成：虚拟项目含引号"和换行\n · 标题含周额度 "和换行\n')
  expect(readContext).toHaveBeenCalledTimes(1)
  expect((await restarted.conversationPreferences()).postEnabled).toBe(true)
})

it('keeps conversation POST opt-in separate from account notices and removes disabled pending statuses', async () => {
  const { service } = await fixture()
  const event = { method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } }
  const readContext = vi.fn(async () => ({ title: '标题', projectName: '' }))
  await service.observeConversation(event, readContext)
  expect(readContext).not.toHaveBeenCalled()
  await service.saveConversationPreferences({ ...defaultConversationNoticePreferences(), postEnabled: true })
  await service.observe(entry(100, 80))
  await service.observe(entry(200, 0))
  await service.observeConversation(event, readContext)
  expect((await service.snapshot()).pendingCount).toBe(3)
  await service.save({ accountId: 'account-a', rule: { ...defaultNoticeRule, fiveHour: true, weekly: true } })
  expect((await service.snapshot()).pendingCount).toBe(3)
  const preferences = await service.conversationPreferences()
  preferences.states.completed = false
  await service.saveConversationPreferences(preferences)
  expect((await service.snapshot()).pendingCount).toBe(2)
})

it('provides the no-project name to both message and custom POST fields', async () => {
  const { service, send } = await fixture()
  await service.save({ settings: { ...defaultNotificationSettings, enabled: true, url: 'http://127.0.0.1/fixture', quietEnabled: false, body: '{"project":"{{project_name}}","title":"{{title}}","message":"{{message}}"}' } })
  await service.saveConversationPreferences({ ...defaultConversationNoticePreferences(), postEnabled: true })
  await service.observeConversation({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } }, async () => ({ title: '无归属会话', projectName: '' }))
  await service.flush()
  expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body))).toEqual({ project: '无项目', title: '无归属会话', message: '【Sidux】会话任务已完成：无项目 · 无归属会话' })
})

it('delivers a titled external automation completion once through the server binding and a real local POST', async () => {
  const received: { message: string }[] = []
  const endpoint = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      received.push(JSON.parse(body))
      res.end('{}')
    })
  })
  await new Promise<void>(resolve => endpoint.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => endpoint.close(error => error ? reject(error) : resolve())))
  const port = (endpoint.address() as { port: number }).port
  const { service, coordinator } = await fixture()
  await service.save({ settings: { ...defaultNotificationSettings, enabled: true, url: `http://127.0.0.1:${port}`, quietEnabled: false } })
  await service.saveConversationPreferences({ ...defaultConversationNoticePreferences(), postEnabled: true })
  await service.close()
  const runtime = new AccountNotificationService(coordinator, fetch, false)
  cleanup.push(() => runtime.close())
  let listener: (notification: { method: string; params: unknown }) => void = () => {}
  const unbind = bindConversationNotifications({
    subscribeNotifications: callback => { listener = callback; return () => {} },
    readConversationNotificationContext: async () => ({ title: '外部 POST 触发的会话标题', projectName: '管理虚拟项目' }),
  }, runtime)
  const event = { method: 'turn/completed', params: { threadId: 'external-post', completionKind: 'background', turn: { id: 'turn', status: 'completed' } } }
  listener(event)
  listener(event)
  await unbind()
  await runtime.flush()
  await runtime.flush()
  expect(received).toEqual([{ message: '【Sidux】自动化任务已完成：管理虚拟项目 · 外部 POST 触发的会话标题' }])
})
it('deduplicates quota recovery, persists quiet-hour deferral and delivers escaped JSON once', async () => {
  const { service, send, coordinator } = await fixture()
  await service.observe(entry(100, 80))
  expect((await service.snapshot()).pendingCount).toBe(0)
  await service.observe(entry(200, 0))
  await service.observe(entry(200, 0))
  expect((await service.snapshot()).pendingCount).toBe(2)
  await service.flush(Date.parse('2026-09-08T15:00:00Z')) // Shanghai 23:00
  expect(send).not.toHaveBeenCalled()
  await service.close()
  const restarted = new AccountNotificationService(coordinator, send as typeof fetch, false)
  cleanup.push(() => restarted.close())
  await restarted.flush(Date.parse('2026-09-09T01:00:00Z'))
  expect(send).toHaveBeenCalledTimes(2)
  expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body)).message).toContain('example@test')
  await restarted.flush(Date.parse('2026-09-09T01:00:00Z'))
  expect(send).toHaveBeenCalledTimes(2)
  expect((await coordinator.store.readState()).accounts[0]?.protectionPercent).toBe(1)
})
it('does not retry an ambiguous POST and disabling a rule removes its pending events', async () => {
  const { service, send } = await fixture()
  await service.observe(entry(100, 80))
  await service.observe(entry(200, 0))
  await service.save({ accountId: 'account-a', rule: { ...defaultNoticeRule, fiveHour: true } })
  expect((await service.snapshot()).pendingCount).toBe(1)
  send.mockRejectedValueOnce(new Error('transport uncertain'))
  await service.flush(Date.parse('2026-09-09T01:00:00Z'))
  await service.flush(Date.parse('2026-09-09T01:00:00Z'))
  expect(send).toHaveBeenCalledTimes(1)
  expect((await service.snapshot()).lastResult).toContain('未确认')
})
it('substitutes nested message strings without turning message content into body configuration', () => {
  const text = 'quote" and\nnewline {{other}}'
  expect(JSON.parse(renderNoticeBody('{"token":"literal","nested":{"text":"{{message}}"}}', { message: text }))).toEqual({ token: 'literal', nested: { text } })
})

it('prefixes test and account POST messages once while preserving custom JSON fields', async () => {
  const { service, send } = await fixture()
  await service.save({
    settings: { ...defaultNotificationSettings, enabled: true, url: 'http://127.0.0.1/fixture', body: '{"source":"custom","nested":{"text":"{{message}}"}}' },
    accountId: 'account-a',
    rule: { ...defaultNoticeRule, fiveHour: true, fiveHourMessage: '【Sidux】{{account}} 已恢复' },
  })
  await service.test()
  await service.observe(entry(100, 80))
  await service.observe(entry(200, 0))
  await service.flush()
  expect(send).toHaveBeenCalledTimes(2)
  const bodies = send.mock.calls.map(row => JSON.parse(String(row[1]?.body)))
  expect(bodies[0]).toEqual({ source: 'custom', nested: { text: expect.stringMatching(/^【Sidux】Sidux 通知测试：/) } })
  expect(bodies[1]).toEqual({ source: 'custom', nested: { text: expect.stringMatching(/^【Sidux】[^【]+已恢复$/) } })
})


it('uses a 45 percentage-point increase rather than full recovery or relative growth', async () => {
  const { service } = await fixture()
  await service.observe(entry(100, 80)) // remaining 20%
  await service.observe(entry(100, 70)) // remaining 30%: relative +50%, absolute +10
  expect((await service.snapshot()).pendingCount).toBe(0)
  await service.observe(entry(100, 25.1)) // +44.9 points
  expect((await service.snapshot()).pendingCount).toBe(0)
  await service.observe(entry(100, 80))
  await service.observe(entry(100, 35)) // +45 points, only 65% remaining
  expect((await service.snapshot()).pendingCount).toBe(2)
  await service.observe(entry(100, 35))
  await service.observe(entry(100, 0)) // +35, reaches 100% but is not a recovery event
  expect((await service.snapshot()).pendingCount).toBe(2)
})
it('suppresses actual reset usage for ten minutes without consulting credit count', async () => {
  const { service } = await fixture()
  await service.observe(entry(100, 80))
  await service.observe({ ...entry(100, 20), lastResetUsedAtIso: new Date().toISOString() })
  expect((await service.snapshot()).pendingCount).toBe(0)
  await service.observe(entry(100, 80))
  await service.observe({ ...entry(100, 35), lastResetUsedAtIso: new Date(Date.now() - 600_001).toISOString(), resetCredits: { availableCount: 0, credits: [] } })
  expect((await service.snapshot()).pendingCount).toBe(2)
})
it('normalizes legacy generic weekly wording in saved notification templates', async () => {
  const { service } = await fixture()
  await service.save({ accountId: 'account-a', rule: { ...defaultNoticeRule, weeklyMessage: '{{account}} 的周额度已恢复' } })
  expect((await service.snapshot()).accounts['account-a']?.weeklyMessage).toBe('{{account}} 的主额度已恢复')
})

it('includes the exact decimal 45-point boundary without rounding smaller increases up', async () => {
  const { service } = await fixture()
  await service.observe(entry(100, 90.1))
  await service.observe(entry(100, 45.101))
  expect((await service.snapshot()).pendingCount).toBe(0)
  await service.observe(entry(100, 90.1))
  await service.observe(entry(100, 45.1))
  expect((await service.snapshot()).pendingCount).toBe(2)
})

it('normalizes comma, Chinese comma and whitespace separators while preserving connected day-hour tokens', () => {
  expect(parseResetExpiryLeadTimes('7d，3d 12h').text).toBe('7d, 3d, 12h')
  expect(parseResetExpiryLeadTimes('1h, 3h, 1d12h, 3d, 7d')).toEqual({ text: '7d, 3d, 1d12h, 3h, 1h', hours: [168, 72, 36, 3, 1] })
  expect(parseResetExpiryLeadTimes('3d 12h').hours).toEqual([72, 12])
  expect(parseResetExpiryLeadTimes('3d12h').hours).toEqual([84])
  expect(() => parseResetExpiryLeadTimes('0h')).toThrow()
  expect(() => parseResetExpiryLeadTimes('1.5d')).toThrow()
})
it('sends each expiry threshold once across restart, catches up only one threshold, and cancels expired notices', async () => {
  const { service, send, coordinator } = await fixture()
  const now = Date.now()
  const expiresAt = now + 8 * 86400_000
  const account = { ...entry(100, 80), resetCredits: { availableCount: 1, credits: [{ id: 'credit-a', expiresAt: expiresAt / 1000, status: 'available', resetType: 'codex' }] } }
  await service.save({ settings: { ...defaultNotificationSettings, enabled: true, url: 'http://127.0.0.1/fixture', body: '{"message":"{{message}}","lead":"{{lead_time}}"}' }, accountId: 'account-a', rule: { ...defaultNoticeRule, resetExpiry: true, resetExpiryLeadTimes: '7d，3d 12h' } })
  expect((await service.snapshot()).accounts['account-a']?.resetExpiryLeadTimes).toBe('7d, 3d, 12h')
  await service.checkExpiries([account], now)
  expect((await service.snapshot()).pendingCount).toBe(0)
  await service.checkExpiries([account], now + 86400_000)
  await service.checkExpiries([account], now + 86400_000)
  expect((await service.snapshot()).pendingCount).toBe(1)
  await service.flush(now + 86400_000)
  expect(send).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body)).lead).toBe('7d')
  await service.close()
  const restarted = new AccountNotificationService(coordinator, send as typeof fetch, false)
  cleanup.push(() => restarted.close())
  await restarted.checkExpiries([account], now + 86400_000)
  expect((await restarted.snapshot()).pendingCount).toBe(0)
  await restarted.checkExpiries([account], expiresAt - 3600_000)
  expect((await restarted.snapshot()).pendingCount).toBe(1)
  await restarted.checkExpiries([account], expiresAt)
  expect((await restarted.snapshot()).pendingCount).toBe(0)
})

it('drops queued expiry reminders when a reset credit is consumed or its account rule is disabled', async () => {
  const { service, send } = await fixture()
  const now = Date.now()
  const account = { ...entry(100, 80), resetCredits: { availableCount: 1, credits: [{ id: 'credit-a', expiresAt: (now + 86400_000) / 1000, status: 'available', resetType: 'codex' }] } }
  await service.save({ accountId: 'account-a', rule: { ...defaultNoticeRule, resetExpiry: true } })
  await service.checkExpiries([account], now)
  expect((await service.snapshot()).pendingCount).toBe(1)
  await service.checkExpiries([{ ...account, resetCredits: { availableCount: 0, credits: [] } }], now)
  expect((await service.snapshot()).pendingCount).toBe(0)
  await service.checkExpiries([{ ...account, resetCredits: { ...account.resetCredits, credits: [{ ...account.resetCredits.credits[0]!, id: 'credit-b' }] } }], now)
  expect((await service.snapshot()).pendingCount).toBe(1)
  await service.save({ accountId: 'account-a', rule: { ...defaultNoticeRule, resetExpiry: false } })
  expect((await service.snapshot()).pendingCount).toBe(0)
  expect(send).not.toHaveBeenCalled()
})

function withCredits(count: number, timestamp = '2026-09-10T00:00:00Z'): StoredAccountEntry {
  return { ...entry(100, 80), quotaUpdatedAtIso: timestamp, resetCredits: { availableCount: count, credits: null } }
}
it('notifies only reset count increases, preserving the baseline and pending notice across restart', async () => {
  const { service, send, coordinator } = await fixture()
  await service.save({ accountId: 'account-a', rule: { ...defaultNoticeRule, resetIncrease: true } })
  await service.observe(withCredits(1))
  expect((await service.snapshot()).pendingCount).toBe(0)
  await service.observe(withCredits(3, '2026-09-10T01:00:00Z'))
  await service.observe(withCredits(3, '2026-09-10T01:00:00Z'))
  expect((await service.snapshot()).pendingCount).toBe(1)
  await service.flush(Date.parse('2026-09-10T15:00:00Z'))
  expect(send).not.toHaveBeenCalled()
  await service.close()
  const restarted = new AccountNotificationService(coordinator, send as typeof fetch, false)
  cleanup.push(() => restarted.close())
  await restarted.observe(withCredits(3, '2026-09-10T02:00:00Z'))
  await restarted.flush(Date.parse('2026-09-11T01:00:00Z'))
  expect(send).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(send.mock.calls[0]![1]!.body)).message).toContain('增加 2 次，当前可用 3 次')
  await restarted.observe(withCredits(2, '2026-09-10T03:00:00Z'))
  expect((await restarted.snapshot()).pendingCount).toBe(0)
  await restarted.observe(withCredits(3, '2026-09-10T04:00:00Z'))
  expect((await restarted.snapshot()).pendingCount).toBe(1)
})
it('ignores unknown, failed and stale reset snapshots instead of interpreting them as zero', async () => {
  const { service } = await fixture()
  await service.save({ accountId: 'account-a', rule: { ...defaultNoticeRule, resetIncrease: true } })
  await service.observe(withCredits(3, '2026-09-10T02:00:00Z'))
  await service.observe({ ...entry(100, 80), resetCredits: null })
  await service.observe({ ...withCredits(0, '2026-09-10T03:00:00Z'), quotaStatus: 'error' })
  await service.observe(withCredits(0, '2026-09-10T01:00:00Z'))
  await service.observe(withCredits(3, '2026-09-10T04:00:00Z'))
  expect((await service.snapshot()).pendingCount).toBe(0)
})
it('tracks reset counts without a quota window and renders count variables in nested POST fields', async () => {
  const { service, send } = await fixture()
  await service.save({ settings: { ...defaultNotificationSettings, enabled: true, url: 'http://127.0.0.1/fixture', body: '{"message":"{{message}}","counts":{"added":"{{increase}}","before":"{{previous}}","now":"{{remaining}}"}}' }, accountId: 'account-a', rule: { ...defaultNoticeRule, resetIncrease: true } })
  await service.observe({ ...withCredits(0), quotaSnapshot: null })
  await service.observe({ ...withCredits(2), quotaSnapshot: null })
  await service.flush()
  expect(send).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(send.mock.calls[0]![1]!.body)).counts).toEqual({ added: '2', before: '0', now: '2' })
})
it('drops pending reset increases on disable and does not report increases observed while disabled', async () => {
  const { service } = await fixture()
  await service.save({ accountId: 'account-a', rule: { ...defaultNoticeRule, resetIncrease: true } })
  await service.observe(withCredits(0))
  await service.observe(withCredits(1))
  expect((await service.snapshot()).pendingCount).toBe(1)
  await service.save({ accountId: 'account-a', rule: { ...defaultNoticeRule, resetIncrease: false } })
  expect((await service.snapshot()).pendingCount).toBe(0)
  await service.observe(withCredits(2))
  await service.save({ accountId: 'account-a', rule: { ...defaultNoticeRule, resetIncrease: true } })
  await service.observe(withCredits(2))
  expect((await service.snapshot()).pendingCount).toBe(0)
})
it('validates new rule fields and upgrades saved legacy rules with increase notices disabled', async () => {
  const { service } = await fixture()
  await expect(service.save({ accountId: 'account-a', rule: { ...defaultNoticeRule, resetIncrease: 'yes' } as any })).rejects.toThrow('增加提醒选项')
  await expect(service.save({ accountId: 'account-a', rule: { ...defaultNoticeRule, resetIncreaseMessage: 3 } as any })).rejects.toThrow('增加提醒内容')
  const { resetIncrease: _enabled, resetIncreaseMessage: _message, ...legacy } = defaultNoticeRule
  await service.save({ accountId: 'account-a', rule: legacy })
  expect((await service.snapshot()).accounts['account-a']?.resetIncrease).toBe(false)
})
it('separates count baselines by account and makes concurrent identical observations produce one event', async () => {
  const { service, coordinator } = await fixture()
  await coordinator.store.updateState((state: any) => ({ state: { ...state, accounts: [...state.accounts, { ...entry(100, 80), storageId: 'account-b' }] }, result: undefined }))
  for (const accountId of ['account-a', 'account-b']) await service.save({ accountId, rule: { ...defaultNoticeRule, resetIncrease: true } })
  await service.observe(withCredits(0))
  await service.observe({ ...withCredits(3), storageId: 'account-b' })
  await Promise.all([service.observe(withCredits(1)), service.observe(withCredits(1))])
  expect((await service.snapshot()).pendingCount).toBe(1)
})

it('delivers a reset increase through real loopback HTTP exactly once without touching reset APIs', async () => {
  const { createServer } = await import('node:http')
  const bodies: unknown[] = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += String(chunk)
    bodies.push(JSON.parse(body))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"received":true}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const { service, send } = await fixture()
    send.mockImplementation((url, options) => fetch(url, options))
    const address = server.address() as import('node:net').AddressInfo
    await service.save({ settings: { ...defaultNotificationSettings, enabled: true, url: `http://127.0.0.1:${address.port}/notice` }, accountId: 'account-a', rule: { ...defaultNoticeRule, resetIncrease: true } })
    await service.observe(withCredits(0))
    await service.observe(withCredits(1))
    await service.observe(withCredits(1))
    await service.flush()
    await service.flush()
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toEqual({ message: expect.stringContaining('增加 1 次，当前可用 1 次') })
    expect((await service.snapshot()).lastResult).toBe('通知已发送')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

// Uses real persisted account metadata and fake credentials, with the auth gate held busy.
it('saves and clears a local alias while logged out without touching credentials, epochs or revisions', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'account-alias-'))
  cleanup.push(() => rm(codexHome, { recursive: true, force: true }))
  const store = new AccountAuthStore(codexHome)
  const raw = JSON.stringify({ tokens: { account_id: 'alias-fixture', access_token: 'fixture', refresh_token: 'fixture' } })
  const { account } = await store.upsertCredential(raw, { activate: true, authStatus: 'reauth_required' })
  const before = await store.readState()
  const coordinator = { store, isAccountOperationInProgress: () => true, refreshAccount: vi.fn() } as unknown as AccountAuthCoordinator
  const send = vi.fn()
  const service = new AccountNotificationService(coordinator, send, false)
  cleanup.push(() => service.close())
  await service.save({ accountId: account.storageId, rule: defaultNoticeRule, alias: '  备用账号  ' })
  const after = await store.readState()
  expect(after).toEqual({ ...before, accounts: [{ ...before.accounts[0], alias: '备用账号' }] })
  expect(await readFile(store.activeAuthPath, 'utf8')).toBe(raw)
  expect(await readFile(store.credentialPath(account.storageId), 'utf8')).toBe(raw)
  expect((await new AccountAuthStore(codexHome).readState()).accounts[0]?.alias).toBe('备用账号')
  await expect(service.save({ accountId: account.storageId, rule: defaultNoticeRule, alias: 'x'.repeat(81), protectionPercent: 12 })).rejects.toThrow('80')
  expect(await store.readState()).toEqual(after)
  await service.save({ accountId: account.storageId, rule: defaultNoticeRule, alias: '   ' })
  expect(await store.readState()).toEqual(before)
  expect(coordinator.refreshAccount).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
})

it('keeps local aliases out of external notification text', async () => {
  const { service, send } = await fixture()
  await service.observe({ ...entry(100, 80), alias: 'local only' })
  await service.observe({ ...entry(200, 0), alias: 'local only' })
  await service.flush(Date.parse('2026-09-09T01:00:00Z'))
  expect(send).toHaveBeenCalledTimes(2)
  for (const call of send.mock.calls) {
    expect(String(call[1]?.body)).toContain('example@test')
    expect(String(call[1]?.body)).not.toContain('local only')
  }
})

it('flags only an actual reserve change for connection enforcement, not alias or notification edits', async () => {
  const { service } = await fixture()
  const rule = { ...defaultNoticeRule, resetIncrease: true }
  expect((await service.save({ accountId: 'account-a', rule, alias: 'local', protectionPercent: 1 })).protectionChanged).toBe(false)
  expect((await service.save({ accountId: 'account-a', rule, alias: 'renamed' })).protectionChanged).toBe(false)
  expect((await service.save({ accountId: 'account-a', rule, protectionPercent: 2 })).protectionChanged).toBe(true)
  expect((await service.save({ accountId: 'account-a', rule, protectionPercent: 2 })).protectionChanged).toBe(false)
  expect((await service.save({ accountId: 'account-a', rule, protectionPercent: 0 })).protectionChanged).toBe(true)
})
