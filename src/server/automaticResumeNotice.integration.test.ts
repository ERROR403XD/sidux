import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { defaultNotificationSettings } from '../accountNotifications'
import { defaultConversationNoticePreferences } from '../conversationNotifications'
import { automaticResumeStartedMethod } from '../threadAutomaticResume'
import { createDeliveryId } from '../delivery'
import { getAccountAuthCoordinator } from './accountAuthCoordinator'
import { AccountNotificationService } from './accountNotificationService'
import { bindConversationNotifications } from './conversationNotificationBinding'
import { createCodexBridgeMiddleware, type AppServerProcess } from './codexAppServerBridge'
import type { BackendQueueProcessor } from './backendQueueRuntime'
import type { ThreadScheduledResume } from './threadScheduledResume'
import { createThreadQuotaResumeRuntime } from './threadQuotaResumeRuntime'

it('delivers startup notices through IPC and consumes a scheduled GOAL while it is still active', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sidux-resume-notice-'))
  vi.stubEnv('CODEX_HOME', home)
  vi.stubEnv('CODEXUI_CODEX_COMMAND', resolve('src/server/fixtures/account-app-server.cjs'))
  const bridge = createCodexBridgeMiddleware()
  const shared = (globalThis as unknown as { __codexRemoteSharedBridge__: {
    appServer: AppServerProcess; backendQueueProcessor: BackendQueueProcessor; scheduledResume: ThreadScheduledResume
  } }).__codexRemoteSharedBridge__
  const send = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => new Response('{}'))
  const service = new AccountNotificationService(getAccountAuthCoordinator(), send, false)
  const stopNotices = bindConversationNotifications(bridge, service)
  const starts: unknown[] = []
  const completed: unknown[] = []
  const unsubscribe = bridge.subscribeNotifications(notification => {
    if (notification.method === automaticResumeStartedMethod) starts.push(notification.params)
    if (notification.method === 'turn/completed') completed.push(notification.params)
  })
  try {
    await service.save({ settings: { ...defaultNotificationSettings, enabled: true, quietEnabled: false, url: 'http://127.0.0.1/fixture' } })
    const preferences = defaultConversationNoticePreferences()
    preferences.postEnabled = true
    preferences.states.resumeStarted = true
    await service.saveConversationPreferences(preferences)
    const created = await shared.appServer.rpc('thread/start', { cwd: home }) as { thread: { id: string } }
    const threadId = created.thread.id
    await shared.scheduledResume.set(threadId, Date.now() + 100, { model: 'fixture', effort: 'high', tier: '' })
    expect(starts).toEqual([])
    await vi.waitFor(() => expect(starts).toHaveLength(1))
    await vi.waitFor(() => expect(completed).toHaveLength(1))
    await vi.waitFor(async () => expect(await shared.scheduledResume.snapshot()).toEqual({}))
    expect(starts[0]).toMatchObject({ threadId, source: 'scheduled', turnId: expect.any(String) })

    await shared.appServer.rpc('thread/goal/set', { threadId, objective: 'Scheduled GOAL still running', status: 'paused' })
    await shared.scheduledResume.set(threadId, Date.now() + 100, { model: 'fixture', effort: 'high', tier: '' })
    await vi.waitFor(() => expect(starts).toHaveLength(2))
    await vi.waitFor(async () => expect(await shared.scheduledResume.snapshot()).toEqual({}))
    expect(await shared.appServer.rpc('thread/goal/get', { threadId })).toMatchObject({ goal: { status: 'active' } })
    expect(starts[1]).toMatchObject({ threadId, source: 'scheduled' })
    expect(completed).toHaveLength(1)

    await shared.appServer.rpc('thread/goal/set', { threadId, objective: 'Continue the same goal', status: 'usageLimited' })
    const quotaRuntime = createThreadQuotaResumeRuntime(shared.appServer, shared.backendQueueProcessor)
    await quotaRuntime.submit(threadId, createDeliveryId())
    expect(starts).toHaveLength(3)
    expect(starts[2]).toMatchObject({ threadId, source: 'quota' })
    expect(starts[2]).not.toHaveProperty('turnId')
    expect(completed).toHaveLength(1)
    await stopNotices()
    await service.flush()
    const messages = send.mock.calls.map(call => JSON.parse(String(call[1]?.body)).message)
    // Very short native turns can finish while the accepted receipt is being flushed.
    expect(messages).toHaveLength(4)
    expect(messages).toEqual(expect.arrayContaining([
      expect.stringMatching(/^【Sidux】定时续跑已启动：/),
      expect.stringMatching(/^【Sidux】会话任务已完成：/),
      expect.stringMatching(/^【Sidux】额度恢复续跑已启动：/),
    ]))
  } finally {
    unsubscribe()
    await stopNotices()
    await service.close()
    await bridge.dispose()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  }
}, 15000)
