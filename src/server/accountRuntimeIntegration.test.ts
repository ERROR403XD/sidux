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
    const inventory = await app.rpc('thread/list', {}) as any
    expect(inventory.data.find((thread: any) => thread.id === primary.thread.id).status.type).toBe('active')
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

it('refreshes B in the same native session while A stalls, retaining loaded turns and the active credential', async () => {
  const home = await mkdtemp(tmpdir() + '/account-refresh-ipc-0214-')
  vi.stubEnv('CODEX_HOME', home)
  vi.stubEnv('CODEXUI_CODEX_COMMAND', resolve('src/server/fixtures/account-app-server.cjs'))
  const coordinator = getAccountAuthCoordinator()
  const token = (id: string) => 'header.' + Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: id, user_id: id } })).toString('base64url') + '.signature'
  const credential = (id: string) => JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: id, refresh_token: 'refresh-' + id, access_token: token(id) } })
  const a = await coordinator.store.upsertCredential(credential('a'), { activate: true })
  const b = await coordinator.store.upsertCredential(credential('b'))
  vi.spyOn(coordinator, 'refreshAccount').mockImplementation(async id => (await coordinator.store.readState()).accounts.find(account => account.storageId === id)!)
  const refresh = vi.fn(async (_url: unknown, options: RequestInit) => {
    expect(new URLSearchParams(String(options.body)).get('refresh_token')).toBe('refresh-b')
    return new Response(JSON.stringify({ access_token: token('b'), refresh_token: 'rotated-b' }), { status: 200 })
  })
  vi.stubGlobal('fetch', refresh)
  const app = new AppServerProcess()
  try {
    const authBefore = await readFile(home + '/auth.json', 'utf8')
    const primary = await app.rpc('thread/start', { cwd: home }) as any
    await app.rpc('turn/start', { threadId: primary.thread.id, input: [{ type: 'text', text: 'STALL' }] })
    await app.acquireTaskAccount('b-refresh', { accountStorageId: b.account.storageId })
    const created = await app.automationRpc('thread/start', { cwd: home }, 'b-refresh') as any
    const worker = (app as any).taskRuns.get('b-refresh')
    const before = await worker.rpc('account/read', {})
    for (const text of ['COMPLETE', 'REFRESH']) {
      await app.automationRpc('turn/start', { threadId: created.thread.id, input: [{ type: 'text', text }] }, 'b-refresh')
      await vi.waitFor(async () => {
        const result = await app.automationRpc('thread/read', { threadId: created.thread.id }, 'b-refresh') as any
        expect(result.thread.turns.at(-1).status).toBe('completed')
        expect(result.thread.turns.at(-1).items.at(-1).text).toBe('OUTPUT:b')
      })
    }
    const after = await worker.rpc('account/read', {})
    expect(after.pid).toBe(before.pid)
    expect((await worker.rpc('thread/loaded/list', {})).data).toContain(created.thread.id)
    expect((await worker.rpc('thread/read', { threadId: created.thread.id })).thread.turns).toHaveLength(2)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect((await coordinator.store.readCredential(b.account.storageId)).auth.tokens?.refresh_token).toBe('rotated-b')
    expect(await readFile(home + '/auth.json', 'utf8')).toBe(authBefore)
    expect((await coordinator.store.readState()).activeStorageId).toBe(a.account.storageId)
    expect(app.liveActivity().activeTurnThreadIds).toContain(primary.thread.id)
  } finally {
    app.stopTaskRouting()
    app.dispose()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  }
}, 15000)

it('isolates a custom automation from a busy OpenAI session and never changes its authentication', async () => {
  const { getCustomConnectionStore } = await import('./customConnectionStore')
  const home = await mkdtemp(tmpdir() + '/custom-account-ipc-0217-')
  vi.stubEnv('CODEX_HOME', home)
  vi.stubEnv('CODEXUI_CODEX_COMMAND', resolve('src/server/fixtures/account-app-server.cjs'))
  const coordinator = getAccountAuthCoordinator()
  const credential = JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: 'primary', refresh_token: 'fixture', access_token: 'header.' + Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'primary', user_id: 'primary' } })).toString('base64url') + '.signature' } })
  const a = await coordinator.store.upsertCredential(credential, { activate: true })
  const app = new AppServerProcess()
  try {
    const before = await readFile(home + '/auth.json', 'utf8')
    const primary = await app.rpc('thread/start', { cwd: home }) as any
    await app.rpc('turn/start', { threadId: primary.thread.id, input: [{ type: 'text', text: 'STALL' }] })
    const connections = getCustomConnectionStore()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/models') ? { data: [{ id: 'external' }] } : { output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }] }))))
    const draft = { alias: 'External', provider: 'custom', baseUrl: 'https://fixture.test/v1', apiKey: 'fixture-external', model: 'external', wireApi: 'responses' as const }
    const test = await connections.test(draft)
    await connections.save(draft, test.token)
    const custom = connections.snapshot().connections[0]
    const getCredential = vi.spyOn(coordinator, 'getApiCredential')
    expect(await app.acquireTaskAccount('custom-run', { accountStorageId: custom.storageId })).toBe(true)
    const created = await app.automationRpc('thread/start', { cwd: home }, 'custom-run') as any
    await app.automationRpc('turn/start', { threadId: created.thread.id, input: [{ type: 'text', text: 'COMPLETE' }], effort: 'high', serviceTier: 'priority' }, 'custom-run')
    await vi.waitFor(async () => {
      const result = await app.automationRpc('thread/read', { threadId: created.thread.id }, 'custom-run') as any
      expect(result.thread.turns.at(-1).items.at(-1).text).toBe('OUTPUT:custom')
    })
    expect(getCredential).not.toHaveBeenCalledWith(custom.storageId)
    expect(app.liveActivity().activeTurnThreadIds).toContain(primary.thread.id)
    expect(await readFile(home + '/auth.json', 'utf8')).toBe(before)
    expect((await coordinator.store.readState()).activeStorageId).toBe(a.account.storageId)
    app.releaseTaskAccount('custom-run')
    await connections.select(custom.storageId)
    const externalChat = await app.rpc('thread/start', { cwd: home }) as any
    await app.rpc('turn/start', { threadId: externalChat.thread.id, input: [{ type: 'text', text: 'COMPLETE' }] })
    await vi.waitFor(async () => expect(((await app.rpc('thread/read', { threadId: externalChat.thread.id })) as any).thread.turns.at(-1).items.at(-1).text).toBe('OUTPUT:custom'))
    expect(app.liveActivity().activeTurnThreadIds).toContain(primary.thread.id)
    await connections.select(null)
    expect(await readFile(home + '/auth.json', 'utf8')).toBe(before)
  } finally {
    app.stopTaskRouting()
    app.dispose()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  }
}, 15000)
