import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createCodexBridgeMiddleware } from './codexAppServerBridge'
import { TelegramThreadBridge } from './telegramThreadBridge'

it('persists the switch with credentials and chat IDs, migrates legacy config, and rejects disabled tests', async () => {
  const home = await mkdtemp(join(tmpdir(), 'telegram-config-'))
  vi.stubEnv('CODEX_HOME', home)
  vi.stubEnv('CODEXUI_CODEX_COMMAND', resolve('src/server/fixtures/account-app-server.cjs'))
  const start = vi.spyOn(TelegramThreadBridge.prototype, 'start').mockImplementation(() => {})
  const token = vi.spyOn(TelegramThreadBridge.prototype, 'configureToken').mockImplementation(() => {})
  const enabled = vi.spyOn(TelegramThreadBridge.prototype, 'configureNotifications')
  const send = vi.spyOn(TelegramThreadBridge.prototype, 'sendTestNotification').mockResolvedValue()
  const middleware = createCodexBridgeMiddleware()
  const server = createServer((request, response) => {
    void middleware(request, response, () => { response.writeHead(404).end() })
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture did not start')
  const base = `http://127.0.0.1:${address.port}/codex-api/telegram`
  const path = join(home, 'telegram-bridge.json')
  const legacy = { botToken: 'fixture-token', allowedUserIds: [123], chatIds: [123, 456] }
  const getConfig = async () => (await (await fetch(`${base}/config`)).json()).data
  const post = (route: string, body: unknown) => fetch(`${base}/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  try {
    expect((await getConfig()).notificationsEnabled).toBe(false)
    await writeFile(path, JSON.stringify(legacy))
    expect((await getConfig()).notificationsEnabled).toBe(true)
    expect((await post('configure-bot', { ...legacy, notificationsEnabled: false })).status).toBe(200)
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ ...legacy, notificationsEnabled: false, quietEnabled: false, quietStart: '22:00', quietEnd: '08:00' })
    expect((await getConfig()).notificationsEnabled).toBe(false)
    expect(enabled).toHaveBeenLastCalledWith(false)
    expect((await post('test', { language: 'zh-CN' })).status).toBe(400)
    expect(send).not.toHaveBeenCalled()
    // An older client saving only credentials must not turn notifications back on.
    expect((await post('configure-bot', legacy)).status).toBe(200)
    expect((await getConfig()).notificationsEnabled).toBe(false)
    expect((await post('configure-bot', { ...legacy, notificationsEnabled: true })).status).toBe(200)
    expect((await getConfig()).notificationsEnabled).toBe(true)
    expect(enabled).toHaveBeenLastCalledWith(true)
    expect((await post('test', { language: 'en' })).status).toBe(200)
    expect(send).toHaveBeenCalledExactlyOnceWith([123], 'CodexApp test notification')
    expect(token).toHaveBeenLastCalledWith('fixture-token')
    expect(start).toHaveBeenCalled()
    const quiet = { quietEnabled: true, quietStart: '23:00', quietEnd: '07:30', timezone: 'America/New_York' }
    expect((await post('notification-preferences', quiet)).status).toBe(200)
    expect(await getConfig()).toMatchObject({ ...quiet, botToken: legacy.botToken, allowedUserIds: legacy.allowedUserIds, notificationsEnabled: true })
    expect((await post('notification-preferences', { quietEnd: '99:00' })).status).toBe(400)
    expect((await getConfig()).quietEnd).toBe('07:30')
  } finally {
    await middleware.dispose()
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  }
}, 15000)
