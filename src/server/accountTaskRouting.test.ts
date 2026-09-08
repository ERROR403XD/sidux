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
  vi.spyOn(app, 'getRuntimeQuiescenceSnapshot').mockResolvedValue({ idle: true, activeTurnThreadIds: [], queuedThreadIds: [], automationRunIds: [], backgroundThreadIds: [], pendingServerRequestCount: 0, pendingTurnMutationCount: 0 })
  const call = vi.spyOn(app as any, 'call').mockImplementation(async (method: unknown) => method === 'config/read' ? { config: { model_provider: 'openai' } } : {})
  vi.spyOn(app as any, 'sendLine').mockImplementation(() => {})
  return { home, coordinator, a, b, guard, app, call }
}
it('binds automation authentication without changing global auth and blocks ordinary turn injection', async () => {
  const { home, coordinator, a, b, guard, app, call } = await fixture()
  const authBefore = await readFile(home + '/auth.json', 'utf8')
  expect(await app.acquireTaskAccount('run-a', { accountStorageId: b.account.storageId, protected: true })).toBe(true)
  await expect(app.rpc('turn/start', { threadId: 'ordinary' })).rejects.toThrow('等待')
  await app.automationRpc('turn/start', { threadId: 'automation' })
  expect(call).toHaveBeenCalledWith('account/login/start', expect.objectContaining({ type: 'chatgptAuthTokens', chatgptAccountId: 'b' }))
  expect(guard).toHaveBeenLastCalledWith(expect.any(Function), { storageId: b.account.storageId, protected: true })
  expect((await coordinator.store.readState()).activeStorageId).toBe(a.account.storageId)
  expect(await readFile(home + '/auth.json', 'utf8')).toBe(authBefore)
  app.releaseTaskAccount('run-a')
  await vi.waitFor(() => expect(app.taskAccountBusy()).toBe(false))
})
it('waits for task boundaries and interrupts unprotected in-flight turns at the reserve', async () => {
  const { coordinator, a, app, call } = await fixture()
  vi.mocked(app.getRuntimeQuiescenceSnapshot).mockResolvedValueOnce({ idle: false } as any)
  expect(await app.acquireTaskAccount('run-a', {})).toBe(false)
  await app.rpc('account/read', {})
  ;(app as any).activeTurnThreadIds.add('main-thread')
  ;(app as any).activeTurnIds.set('main-thread', 'turn-a')
  const blocked = vi.fn(async () => {})
  app.quotaBlocked = blocked
  await coordinator.interruptProtectedUsage(a.account.storageId)
  expect(call).toHaveBeenCalledWith('turn/interrupt', { threadId: 'main-thread', turnId: 'turn-a' })
  expect(blocked).toHaveBeenCalledWith('main-thread', 'turn-a')
})
