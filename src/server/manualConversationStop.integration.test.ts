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
import { defaultConversationNoticePreferences } from '../conversationNotifications'

it('forwards manual-stop intent through the HTTP bridge and owning IPC worker without sending POST', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sidux-manual-stop-'))
  vi.stubEnv('CODEX_HOME', home)
  vi.stubEnv('CODEXUI_CODEX_COMMAND', resolve('src/server/fixtures/account-app-server.cjs'))
  const bridge = createCodexBridgeMiddleware()
  const runtime = (globalThis as unknown as { __codexRemoteSharedBridge__: { appServer: AppServerProcess } }).__codexRemoteSharedBridge__.appServer
  const send = vi.fn(async () => new Response('{}', { status: 200 }))
  const service = new AccountNotificationService(getAccountAuthCoordinator(), send as typeof fetch, false)
  const unbind = bindConversationNotifications(bridge, service)
  const events: Array<{ method: string; params: unknown }> = []
  const unsubscribe = bridge.subscribeNotifications(event => events.push(event))
  const server = createServer((req, res) => {
    void bridge(req, res, () => { res.statusCode = 404; res.end() })
  })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    await service.save({ settings: { ...defaultNotificationSettings, enabled: true, url: 'http://127.0.0.1/fixture' } })
    await service.saveConversationPreferences({ ...defaultConversationNoticePreferences(), postEnabled: true })
    const created = await runtime.rpc('thread/start', { cwd: home }) as { thread: { id: string } }
    const threadId = created.thread.id
    const started = await runtime.rpc('turn/start', { threadId, input: [{ type: 'text', text: 'STALL' }] }) as { turn: { id: string } }
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const response = await fetch(`${base}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'turn/interrupt', params: { threadId, turnId: started.turn.id } }),
    })
    expect(response.status).toBe(200)
    const terminal = events.find(event => event.method === 'turn/completed' && (event.params as any).threadId === threadId)
    expect(terminal?.params).toMatchObject({ interruptionReason: 'user', turn: { id: started.turn.id, status: 'interrupted' } })
    await unbind()
    expect((await service.snapshot()).pendingCount).toBe(0)
    await service.flush()
    expect(send).not.toHaveBeenCalled()
  } finally {
    unsubscribe()
    await unbind()
    await service.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await bridge.dispose()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  }
}, 15000)
