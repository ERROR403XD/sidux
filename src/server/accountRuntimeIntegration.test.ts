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
    const idleThread = await app.rpc('thread/start', { cwd: home }) as any
    await app.rpc('turn/start', { threadId: idleThread.thread.id, input: [{ type: 'text', text: 'COMPLETE' }] })
    await vi.waitFor(async () => {
      const result = await app.rpc('thread/read', { threadId: idleThread.thread.id }) as any
      expect(result.thread.turns.at(-1).status).toBe('completed')
    })
    for (const runId of ['first-b', 'second-b']) {
      expect(await app.acquireTaskAccount(runId, { accountStorageId: b.account.storageId, ...(runId === 'first-b' ? { targetThreadId: idleThread.thread.id } : {}) })).toBe(true)
      const created = runId === 'first-b'
        ? await app.automationRpc('thread/resume', { threadId: idleThread.thread.id }, runId) as any
        : await app.automationRpc('thread/start', { cwd: home }, runId) as any
      await app.automationRpc('turn/start', { threadId: created.thread.id, input: [{ type: 'text', text: 'COMPLETE' }] }, runId)
      await vi.waitFor(async () => {
        const result = await app.automationRpc('thread/read', { threadId: created.thread.id, includeTurns: true }, runId) as any
        expect(result.thread.turns.at(-1).status).toBe('completed')
        expect(result.thread.turns.at(-1).items.at(-1).text).toBe('OUTPUT:b')
      })
      const worker = (app as any).taskRuns.get(runId)
      app.releaseTaskAccount(runId)
      expect(worker.ownedThreadIds.has(created.thread.id)).toBe(true)
      expect((await worker.rpc('thread/loaded/list', {})).data).toContain(created.thread.id)
      if (runId === 'first-b') {
        await app.rpc('thread/resume', { threadId: created.thread.id })
        const returned = await app.rpc('thread/read', { threadId: created.thread.id }) as any
        expect(returned.thread.turns.at(-1).items.at(-1).text).toBe('OUTPUT:b')
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
