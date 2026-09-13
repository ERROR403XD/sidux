import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AppServerProcess } from './codexAppServerBridge'
import { getAccountAuthCoordinator } from './accountAuthCoordinator'
import { AutomationPreparation } from './automationPreparation'
import { createAutomationRuntime } from './automationRuntime'

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'preparation-ipc-'))
  const pause = join(home, 'pause.json')
  vi.stubEnv('CODEX_HOME', home)
  vi.stubEnv('CODEXUI_CODEX_COMMAND', resolve('src/server/fixtures/account-app-server.cjs'))
  vi.stubEnv('CODEXAPP_FIXTURE_PAUSE_FILE', pause)
  const coordinator = getAccountAuthCoordinator()
  const credential = (id: string) => JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: id, refresh_token: 'fixture', access_token: 'header.' + Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: id, user_id: id } })).toString('base64url') + '.signature' } })
  const a = await coordinator.store.upsertCredential(credential('a'), { activate: true })
  const b = await coordinator.store.upsertCredential(credential('b'))
  vi.spyOn(coordinator, 'refreshAccount').mockImplementation(async id => (await coordinator.store.readState()).accounts.find(account => account.storageId === id)!)
  const authBefore = await readFile(join(home, 'auth.json'), 'utf8')
  const app = new AppServerProcess()
  const scopes = new Map<string, AutomationPreparation>()
  const flights: Promise<unknown>[] = []
  function acquire(id: string, targetThreadId?: string, timeoutMs = 10000) {
    const scope = new AutomationPreparation(timeoutMs)
    scopes.set(id, scope)
    app.beginTaskPreparation(id, scope)
    const result = app.acquireTaskAccount(id, { accountStorageId: b.account.storageId, targetThreadId }, scope).catch(error => error)
    flights.push(result)
    return { scope, result }
  }
  const markers = async () => (await readdir(home)).filter(name => name.endsWith('.waiting'))
  async function cleanup() {
    await rm(pause, { force: true })
    for (const scope of scopes.values()) scope.cancel(new Error('fixture cleanup'))
    await Promise.all(flights)
    for (const [id, scope] of scopes) { await scope.settle(); app.endTaskPreparation(id); app.releaseTaskAccount(id) }
    const workers = [...(app as any).sessionWorkers.values()] as AppServerProcess[]
    app.stopTaskRouting()
    app.dispose()
    await Promise.all([app, ...workers].map(worker => (worker as any).closingSession))
    // Child exit does not settle metadata writes already queued in this process.
    // Finish those writes before deleting the isolated account directory.
    await (coordinator.store as unknown as { mutationChain: Promise<unknown> }).mutationChain
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  }
  return { home, pause, app, coordinator, a: a.account.storageId, b: b.account.storageId, authBefore, acquire, markers, cleanup }
}

it('times out four fresh IPC login workers, waits for actual exit and frees capacity without touching a live ordinary conversation', async () => {
  const f = await fixture()
  try {
    const primary = await f.app.rpc('thread/start', { cwd: f.home }) as any
    await f.app.rpc('turn/start', { threadId: primary.thread.id, input: [{ type: 'text', text: 'STALL primary' }] })
    const primaryWorker = (f.app as any).threadWorker(primary.thread.id)
    const primaryPid = primaryWorker.process.pid
    await writeFile(f.pause, JSON.stringify({ method: 'account/login/start', phase: 'after', account: 'b' }))
    const rows = Array.from({ length: 4 }, (_, i) => f.acquire(`run-${i}`, undefined, 1200))
    await vi.waitFor(async () => expect(await f.markers()).toHaveLength(4), { timeout: 1000 })
    const pids = await Promise.all((await f.markers()).map(async name => JSON.parse(await readFile(join(f.home, name), 'utf8')).pid))
    expect(await f.app.acquireTaskAccount('fifth', { accountStorageId: f.b })).toBe(false)
    const results = await Promise.all(rows.map(row => row.result))
    expect(results.every(result => result instanceof Error)).toBe(true)
    for (let i = 0; i < rows.length; i++) {
      await rows[i]!.scope.settle()
      expect(rows[i]!.scope.signal.aborted).toBe(true)
      f.app.endTaskPreparation(`run-${i}`)
      f.app.releaseTaskAccount(`run-${i}`)
    }
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
    expect(primaryWorker.process.pid).toBe(primaryPid)
    expect((await f.app.rpc('thread/read', { threadId: primary.thread.id, includeTurns: true }) as any).thread.turns[0].status).toBe('inProgress')
    expect(f.coordinator.executions.snapshot().some(row => row.storageId === f.b && row.busy)).toBe(false)
    await rm(f.pause)
    expect(await f.app.acquireTaskAccount('healthy', { accountStorageId: f.b })).toBe(true)
    const created = await f.app.automationRpc('thread/start', { cwd: f.home }, 'healthy') as any
    await f.app.automationRpc('turn/start', { threadId: created.thread.id, input: [{ type: 'text', text: 'healthy' }] }, 'healthy')
    await vi.waitFor(async () => expect(JSON.stringify(await f.app.automationRpc('thread/read', { threadId: created.thread.id, includeTurns: true }))).toContain('OUTPUT:b'))
    f.app.releaseTaskAccount('healthy')
    expect(await readFile(join(f.home, 'auth.json'), 'utf8')).toBe(f.authBefore)
  } finally { await f.cleanup() }
}, 10000)

it('keeps an existing conversation and its lease while a non-cancellable login awaits acknowledgement; unrelated work stays usable', async () => {
  const f = await fixture()
  try {
    const primary = await f.app.rpc('thread/start', { cwd: f.home }) as any
    await f.app.rpc('turn/start', { threadId: primary.thread.id, input: [{ type: 'text', text: 'complete normally' }] })
    await vi.waitFor(async () => expect((await f.app.rpc('thread/read', { threadId: primary.thread.id, includeTurns: true }) as any).thread.turns[0].status).toBe('completed'))
    const worker = (f.app as any).threadWorker(primary.thread.id)
    const pid = worker.process.pid
    await writeFile(f.pause, JSON.stringify({ method: 'account/login/start', phase: 'after', account: 'b' }))
    const held = f.acquire('shared', primary.thread.id, 200)
    await vi.waitFor(async () => expect(await f.markers()).toHaveLength(1))
    await vi.waitFor(() => expect(held.scope.signal.aborted).toBe(true))
    let settled = false
    void held.result.then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(settled).toBe(false)
    expect(worker.process.pid).toBe(pid)
    expect(f.coordinator.executions.snapshot()).toContainEqual(expect.objectContaining({ storageId: f.b, ownerId: 'shared', busy: true }))
    await expect(f.app.rpc('turn/start', { threadId: primary.thread.id, input: [{ type: 'text', text: 'must remain blocked' }] })).rejects.toThrow('自动化')
    const other = await f.app.rpc('thread/start', { cwd: f.home }) as any
    await f.app.rpc('turn/start', { threadId: other.thread.id, input: [{ type: 'text', text: 'unrelated ordinary work' }] })
    await vi.waitFor(async () => expect(JSON.stringify(await f.app.rpc('thread/read', { threadId: other.thread.id, includeTurns: true }))).toContain('OUTPUT:a'))
    await rm(f.pause)
    expect(await held.result).toBe(held.scope.signal.reason)
    await held.scope.settle()
    f.app.endTaskPreparation('shared')
    f.app.releaseTaskAccount('shared')
    expect(worker.process.pid).toBe(pid)
    await f.app.rpc('turn/start', { threadId: primary.thread.id, input: [{ type: 'text', text: 'primary resumes A' }] })
    await vi.waitFor(async () => expect((await f.app.rpc('thread/read', { threadId: primary.thread.id, includeTurns: true }) as any).thread.turns.at(-1).items.at(-1).text).toBe('OUTPUT:a'))
    expect(await readFile(join(f.home, 'auth.json'), 'utf8')).toBe(f.authBefore)
  } finally { await f.cleanup() }
}, 10000)

it('rejects a late quota read before it can allocate a worker or log into the account', async () => {
  const f = await fixture()
  const lateAccount = (await f.coordinator.store.readState()).accounts.find(row => row.storageId === f.b)!
  let release!: (value: typeof lateAccount) => void
  try {
    vi.mocked(f.coordinator.refreshAccount).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const held = f.acquire('quota-read', undefined, 100)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(await held.result).toBe(held.scope.signal.reason)
    await held.scope.settle()
    f.app.endTaskPreparation('quota-read')
    release(lateAccount)
    await Promise.resolve()
    expect((f.app as any).sessionWorkers.size).toBe(0)
    expect(f.coordinator.executions.snapshot()).toEqual([])
    expect(await f.app.acquireTaskAccount('later', { accountStorageId: f.a })).toBe(true)
    f.app.releaseTaskAccount('later')
    expect(await readFile(join(f.home, 'auth.json'), 'utf8')).toBe(f.authBefore)
  } finally { release?.(lateAccount); await f.cleanup() }
}, 10000)

it('keeps the actual shared read pending and coalesces timed-out retries until the native reply arrives', async () => {
  const f = await fixture()
  try {
    await f.app.rpc('config/read', {})
    await writeFile(f.pause, JSON.stringify({ method: 'config/read', phase: 'before' }))
    for (let i = 0; i < 5; i++) {
      // Exercise the shared read directly. Account-worker startup is unrelated
      // to this deadline and must not consume it on a busy test host.
      const scope = new AutomationPreparation(100)
      const result = await f.app.rpc('config/read', {}, undefined, scope).catch(error => error)
      expect(result).toBe(scope.signal.reason)
      await scope.settle()
    }
    const pending = [...(f.app as any).pending.values()].filter((request: any) => request.method === 'config/read')
    expect(pending).toHaveLength(1)
    expect((f.app as any).preparationReads.size).toBe(1)
    await rm(f.pause)
    await vi.waitFor(() => expect((f.app as any).preparationReads.size).toBe(0))
    expect((await f.app.rpc('config/read', {}) as any).config.model).toBe('fixture')
    expect(await readFile(join(f.home, 'auth.json'), 'utf8')).toBe(f.authBefore)
  } finally { await f.cleanup() }
}, 10000)

it('closes a fresh empty thread stalled while naming it and rejects the late prepared result before any turn is submitted', async () => {
  const f = await fixture()
  try {
    const held = f.acquire('naming', undefined, 250)
    expect(await held.result).toBe(true)
    await writeFile(f.pause, JSON.stringify({ method: 'thread/name/set', phase: 'after' }))
    const rpc = vi.fn((method: string, params: unknown, runId?: string) => f.app.automationRpc(method, params, runId))
    const runtime = createAutomationRuntime({ rpc, accountBusy: () => false, hasQueuedMessages: async () => false, pendingRequests: () => [], readHistory: async () => ({}), buildParams: async () => ({}) })
    const result = await held.scope.effect(() => runtime.createThread(f.home, 'prepared name', {}, 'naming')).catch(error => error)
    expect(result).toBe(held.scope.signal.reason)
    await held.scope.settle()
    f.app.endTaskPreparation('naming')
    f.app.releaseTaskAccount('naming')
    expect(held.scope.discardedThreadIds.size).toBe(1)
    const id = [...held.scope.discardedThreadIds][0]!
    expect(JSON.parse(await readFile(join(f.home, `fixture-thread-${id}.json`), 'utf8')).turns).toEqual([])
    expect(rpc.mock.calls.map(([method]) => method)).toEqual(['thread/start', 'thread/name/set'])
    await expect(f.app.automationRpc('turn/start', { threadId: id }, 'naming')).rejects.toThrow('已释放')
    expect(await readFile(join(f.home, 'auth.json'), 'utf8')).toBe(f.authBefore)
  } finally { await f.cleanup() }
}, 10000)
