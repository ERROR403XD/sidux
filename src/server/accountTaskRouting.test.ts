import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { AppServerProcess } from './codexAppServerBridge.js'
import { getAccountAuthCoordinator } from './accountAuthCoordinator.js'
const originalHome = process.env.CODEX_HOME
const homes: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  if (originalHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalHome
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})
async function fixture() {
  const home = await mkdtemp(tmpdir() + '/account-task-')
  homes.push(home)
  process.env.CODEX_HOME = home
  const coordinator = getAccountAuthCoordinator()
  const credential = (id: string) => JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: id, refresh_token: 'fixture', access_token: 'header.' + Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: id, user_id: id } })).toString('base64url') + '.signature' } })
  const a = await coordinator.store.upsertCredential(credential('a'), { activate: true })
  const b = await coordinator.store.upsertCredential(credential('b'))
  vi.spyOn(coordinator, 'refreshAccount').mockImplementation(async id => ({ ...(await coordinator.store.readState()).accounts.find(row => row.storageId === id)!, quotaStatus: 'ready', quotaSnapshot: { limitId: null, limitName: null, credits: null, planType: null, primary: { usedPercent: 50, windowMinutes: 300, resetsAt: null }, secondary: { usedPercent: 50, windowMinutes: 10080, resetsAt: null } } }))
  const guard = vi.fn(async () => {})
  coordinator.setSubmissionGuard(guard)
  const app = new AppServerProcess()
  vi.spyOn(app, 'dispose').mockImplementation(() => { (app as any).initialized = false; (app as any).quotaReadCache = null })
  vi.spyOn(app, 'getRuntimeQuiescenceSnapshot').mockResolvedValue({ idle: true, activeTurnThreadIds: [], queuedThreadIds: [], automationRunIds: [], backgroundThreadIds: [], pendingServerRequestCount: 0, pendingTurnMutationCount: 0 })
  const call = vi.spyOn(AppServerProcess.prototype as any, 'call').mockImplementation(async (method: unknown) => method === 'config/read' ? { config: { model_provider: 'openai' } } : method === 'thread/start' ? { thread: { id: 'automation' } } : {})
  vi.spyOn(AppServerProcess.prototype as any, 'sendLine').mockImplementation(() => {})
  return { home, coordinator, a, b, guard, app, call }
}
it('runs a selected automation account beside a busy primary without changing global auth', async () => {
  const { home, coordinator, a, b, guard, app, call } = await fixture()
  const authBefore = await readFile(home + '/auth.json', 'utf8')
  expect(await app.acquireTaskAccount('run-a', { accountStorageId: b.account.storageId, protected: true })).toBe(true)
  await app.rpc('turn/start', { threadId: 'ordinary' })
  await app.automationRpc('thread/start', { cwd: '/tmp' }, 'run-a')
  await expect(app.rpc('turn/start', { threadId: 'automation' })).rejects.toThrow('等待')
  await app.automationRpc('turn/start', { threadId: 'automation' }, 'run-a')
  expect(call).toHaveBeenCalledWith('account/login/start', expect.objectContaining({ type: 'chatgptAuthTokens', chatgptAccountId: 'b' }))
  expect(guard).toHaveBeenLastCalledWith(expect.any(Function), { storageId: b.account.storageId, protected: true })
  expect((await coordinator.store.readState()).activeStorageId).toBe(a.account.storageId)
  expect(await readFile(home + '/auth.json', 'utf8')).toBe(authBefore)
  app.releaseTaskAccount('run-a')
  expect(app.taskAccountBusy()).toBe(false)
  app.stopTaskRouting()
})
it('coalesces simultaneous runtime quota reads and invalidates the short cache on a rolling update', async () => {
  const { app, call } = await fixture()
  let resolve!: (value: unknown) => void
  const quota = new Promise(done => { resolve = done })
  call.mockImplementation(async (method: unknown) => method === 'account/rateLimits/read' ? quota : {})
  const first = app.rpc('account/rateLimits/read', null)
  const second = app.rpc('account/rateLimits/read', null)
  await vi.waitFor(() => expect(call.mock.calls.filter(([method]) => method === 'account/rateLimits/read')).toHaveLength(1))
  resolve({ rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } } })
  expect(await first).toEqual(await second)
  await app.rpc('account/rateLimits/read', null)
  expect(call.mock.calls.filter(([method]) => method === 'account/rateLimits/read')).toHaveLength(1)
  await app.observeAccountQuota({ rateLimits: { primary: { usedPercent: 99 } } })
  await app.rpc('account/rateLimits/read', null)
  expect(call.mock.calls.filter(([method]) => method === 'account/rateLimits/read')).toHaveLength(2)
})
it('ignores unrelated primary work and interrupts only the unprotected account at the reserve', async () => {
  const { coordinator, a, app, call } = await fixture()
  vi.mocked(app.getRuntimeQuiescenceSnapshot).mockResolvedValueOnce({ idle: false } as any)
  expect(await app.acquireTaskAccount('run-a', {})).toBe(true)
  app.releaseTaskAccount('run-a')
  await app.rpc('account/read', {})
  ;(app as any).activeTurnThreadIds.add('main-thread')
  ;(app as any).activeTurnIds.set('main-thread', 'turn-a')
  const blocked = vi.fn(async () => {})
  app.quotaBlocked = blocked
  await coordinator.interruptProtectedUsage(a.account.storageId)
  expect(call).toHaveBeenCalledWith('turn/interrupt', { threadId: 'main-thread', turnId: 'turn-a' })
  expect(blocked).toHaveBeenCalledWith('main-thread', 'turn-a')
  app.stopTaskRouting()
})

it('routes colliding native approval IDs to the correct isolated account while the primary remains independent', async () => {
  const { app, a, b } = await fixture()
  await app.acquireTaskAccount('a-run', { accountStorageId: a.account.storageId })
  await app.acquireTaskAccount('b-run', { accountStorageId: b.account.storageId })
  const workers = (app as any).taskRuns as Map<string, AppServerProcess>
  const first = workers.get('a-run')!, second = workers.get('b-run')!
  ;(first as any).handleServerRequest(1, 'item/commandExecution/requestApproval', { threadId: 'thread-a' })
  ;(second as any).handleServerRequest(1, 'item/commandExecution/requestApproval', { threadId: 'thread-b' })
  const requests = app.listPendingServerRequests()
  expect(new Set(requests.map(request => request.id)).size).toBe(2)
  const replyA = vi.spyOn(first as any, 'sendServerRequestReply')
  const replyB = vi.spyOn(second as any, 'sendServerRequestReply')
  await app.respondToServerRequest({ id: requests.find(request => (request.params as any).threadId === 'thread-b')!.id, result: { decision: 'decline' } })
  expect(replyA).not.toHaveBeenCalled()
  expect(replyB).toHaveBeenCalledWith(1, { result: { decision: 'decline' } })
  app.stopTaskRouting()
})

it('keeps unrelated task runtimes after removing an account and admits a later run after quota failure', async () => {
  const { app, coordinator, a, b } = await fixture()
  await app.acquireTaskAccount('a-run', { accountStorageId: a.account.storageId })
  await app.acquireTaskAccount('b-run', { accountStorageId: b.account.storageId })
  const workers = (app as any).taskRuns as Map<string, AppServerProcess>
  const second = workers.get('b-run')!
  const stopB = vi.spyOn(second, 'dispose')
  await coordinator.removeAccount(a.account.storageId, app)
  expect(workers.has('a-run')).toBe(false)
  expect(workers.get('b-run')).toBe(second)
  expect(stopB).not.toHaveBeenCalled()
  await app.automationRpc('thread/start', { cwd: '/tmp' }, 'b-run')
  app.releaseTaskAccount('b-run')
  expect(await app.acquireTaskAccount('b-next', { accountStorageId: b.account.storageId, targetThreadId: 'automation' })).toBe(true)
  expect(workers.get('b-next')).toBe(second)
  app.stopTaskRouting()
})

it('interrupts quota retry loops once and leaves unrelated turns running', async () => {
  const { app, call } = await fixture()
  ;(app as any).emitNotification({ method: 'turn/started', params: { threadId: 'limited', turn: { id: 'turn-limited' } } })
  ;(app as any).emitNotification({ method: 'turn/started', params: { threadId: 'other', turn: { id: 'turn-other' } } })
  for (let i = 0; i < 2; i++) (app as any).emitNotification({ method: 'error', params: { threadId: 'limited', turnId: 'turn-limited', willRetry: true, error: { message: 'Usage limit reached', codexErrorInfo: 'usageLimitExceeded' } } })
  expect(call.mock.calls.filter(([method]) => method === 'turn/interrupt')).toEqual([['turn/interrupt', { threadId: 'limited', turnId: 'turn-limited' }]])
})

it('does not scan historical threads to decide whether the primary account can switch', async () => {
  const { app, call } = await fixture()
  const snapshot = await AppServerProcess.prototype.getRuntimeQuiescenceSnapshot.call(app, false, true)
  expect(snapshot.idle).toBe(true)
  expect(call.mock.calls.some(([method]) => method === 'thread/list')).toBe(false)
})

it('marks an accepted turn active before its start notification and preserves an earlier terminal event', async () => {
  const { app, call } = await fixture()
  call.mockImplementation(async (method: unknown) => method === 'turn/start' ? { turn: { id: 'accepted', status: 'inProgress' } } : {})
  await app.rpc('turn/start', { threadId: 'new-thread' })
  expect(app.liveActivity().activeTurnThreadIds).toContain('new-thread')
  const worker = (app as any).threadWorker('new-thread')
  worker.emitNotification({ method: 'turn/completed', params: { threadId: 'new-thread', turn: { id: 'accepted', status: 'completed' } } })
  expect(app.liveActivity().activeTurnThreadIds).not.toContain('new-thread')
  call.mockImplementation(async (method: unknown) => {
    if (method === 'turn/start') {
      worker.emitNotification({ method: 'turn/completed', params: { threadId: 'new-thread', turn: { id: 'early', status: 'completed' } } })
      return { turn: { id: 'early', status: 'inProgress' } }
    }
    return {}
  })
  await app.rpc('turn/start', { threadId: 'new-thread' })
  expect(app.liveActivity().activeTurnThreadIds).not.toContain('new-thread')
  app.stopTaskRouting()
})
