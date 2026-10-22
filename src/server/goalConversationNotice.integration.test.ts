import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createCodexBridgeMiddleware, type AppServerProcess } from './codexAppServerBridge'
import { getAccountAuthCoordinator } from './accountAuthCoordinator'
import { AccountNotificationService } from './accountNotificationService'
import { bindConversationNotifications } from './conversationNotificationBinding'
import { defaultNotificationSettings } from '../accountNotifications'
import { createConversationNoticeClassifier, defaultConversationNoticePreferences } from '../conversationNotifications'

it('carries GOAL status through the owning IPC runtime to new subscribers and delivers labeled POST stages only on opt-in', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sidux-goal-notice-'))
  vi.stubEnv('CODEX_HOME', home)
  vi.stubEnv('CODEXUI_CODEX_COMMAND', resolve('src/server/fixtures/account-app-server.cjs'))
  const bridge = createCodexBridgeMiddleware()
  const runtime = (globalThis as unknown as { __codexRemoteSharedBridge__: { appServer: AppServerProcess } }).__codexRemoteSharedBridge__.appServer
  const received: { message: string }[] = []
  const endpoint = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => { received.push(JSON.parse(body)); res.end('{}') })
  })
  const service = new AccountNotificationService(getAccountAuthCoordinator(), fetch, false)
  let unbind = bindConversationNotifications(bridge, service)
  let unsubscribe = () => {}
  try {
    await new Promise<void>(resolve => endpoint.listen(0, '127.0.0.1', resolve))
    await service.save({ settings: { ...defaultNotificationSettings, enabled: true, url: `http://127.0.0.1:${(endpoint.address() as { port: number }).port}` } })
    await service.saveConversationPreferences({ ...defaultConversationNoticePreferences(), postEnabled: true })
    const created = await runtime.rpc('thread/start', { cwd: home }) as { thread: { id: string } }
    const threadId = created.thread.id
    await runtime.rpc('thread/goal/set', { threadId, objective: 'GOAL notice regression', status: 'active' })
    const completed: { params: unknown }[] = []
    unsubscribe = bridge.subscribeNotifications(notification => {
      if (notification.method === 'turn/completed') completed.push(notification)
    })
    const run = async (count: number) => {
      await runtime.rpc('turn/start', { threadId, input: [{ type: 'text', text: `Stage ${count}` }] })
      await vi.waitFor(() => expect(completed).toHaveLength(count))
      await unbind()
    }
    await run(1)
    expect((await service.snapshot()).pendingCount).toBe(0)
    expect(received).toEqual([])
    // This subscriber missed goal/updated, just as a refreshed browser would.
    const afterRefresh = createConversationNoticeClassifier()
    expect(afterRefresh({ method: 'turn/completed', params: completed[0]!.params })?.goalProgress).toBe(true)
    await service.saveConversationPreferences({ ...defaultConversationNoticePreferences(), postEnabled: true, goalProgressEnabled: true })
    unbind = bindConversationNotifications(bridge, service)
    await run(2)
    await service.flush()
    expect(received).toHaveLength(1)
    expect(received[0]?.message).toMatch(/^【Sidux】GOAL 阶段完成：/)
    await service.saveConversationPreferences({ ...defaultConversationNoticePreferences(), postEnabled: true })
    unbind = bindConversationNotifications(bridge, service)
    await runtime.rpc('thread/goal/set', { threadId, status: 'complete' })
    await run(3)
    await service.flush()
    expect(received).toHaveLength(2)
    expect(received[1]?.message).toMatch(/^【Sidux】会话任务已完成：/)
  } finally {
    unsubscribe()
    await unbind()
    await service.close()
    endpoint.closeAllConnections()
    await new Promise<void>(resolve => endpoint.close(() => resolve()))
    await bridge.dispose()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  }
}, 15000)
