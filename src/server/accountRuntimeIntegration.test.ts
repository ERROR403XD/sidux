import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AppServerProcess } from './codexAppServerBridge.js'
import { getAccountAuthCoordinator } from './accountAuthCoordinator.js'

it('executes B through an actual isolated IPC process while A stalls, then removes A and completes B again', async () => {
  const home = await mkdtemp(tmpdir() + '/account-ipc-0214-')
  vi.stubEnv('CODEX_HOME', home)
  vi.stubEnv('CODEXUI_CODEX_COMMAND', resolve('src/server/fixtures/account-app-server.cjs'))
  const coordinator = getAccountAuthCoordinator()
  const credential = (id: string) => JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: id, refresh_token: 'fixture', access_token: 'header.' + Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: id, user_id: id } })).toString('base64url') + '.signature' } })
  const a = await coordinator.store.upsertCredential(credential('a'), { activate: true })
  const b = await coordinator.store.upsertCredential(credential('b'))
  vi.spyOn(coordinator, 'refreshAccount').mockImplementation(async id => (await coordinator.store.readState()).accounts.find(account => account.storageId === id)!)
  const app = new AppServerProcess()
  try {
    const before = await readFile(home + '/auth.json', 'utf8')
    const primary = await app.rpc('thread/start', { cwd: home }) as any
    await app.rpc('turn/start', { threadId: primary.thread.id, input: [{ type: 'text', text: 'STALL' }] })
    expect((await app.getAccountSwitchSnapshot()).idle).toBe(false)
    for (const runId of ['first-b', 'second-b']) {
      expect(await app.acquireTaskAccount(runId, { accountStorageId: b.account.storageId })).toBe(true)
      const created = await app.automationRpc('thread/start', { cwd: home }, runId) as any
      await app.automationRpc('turn/start', { threadId: created.thread.id, input: [{ type: 'text', text: 'COMPLETE' }] }, runId)
      await vi.waitFor(async () => {
        const result = await app.automationRpc('thread/read', { threadId: created.thread.id, includeTurns: true }, runId) as any
        expect(result.thread.turns[0].status).toBe('completed')
        expect(result.thread.turns[0].items.at(-1).text).toBe('OUTPUT:b')
      })
      app.releaseTaskAccount(runId)
      if (runId === 'first-b') {
        expect(await readFile(home + '/auth.json', 'utf8')).toBe(before)
        await coordinator.removeAccount(a.account.storageId, app)
        expect(await coordinator.store.readActiveCredential()).toBeNull()
      }
    }
    expect((await coordinator.store.readState()).accounts.map(account => account.storageId)).toEqual([b.account.storageId])
  } finally {
    app.stopTaskRouting()
    app.dispose()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  }
}, 15000)
