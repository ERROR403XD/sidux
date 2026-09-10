import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AppServerProcess } from './codexAppServerBridge.js'
import { getAccountAuthCoordinator } from './accountAuthCoordinator.js'
import { AutomationEngine } from './automationEngine.js'
import { createAutomationRuntime } from './automationRuntime.js'
import { serializeAutomationToml } from './automationDefinition.js'

let home: string
let app: AppServerProcess | undefined
let engine: AutomationEngine | undefined
afterEach(async () => {
  await engine?.dispose()
  app?.stopTaskRouting()
  app?.dispose()
  engine = undefined
  app = undefined
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (home) await rm(home, { recursive: true, force: true })
})

it.each([
  ['cron', false, 'manual'],
  ['cron', true, 'manual'],
  ['heartbeat', false, 'manual'],
  ['heartbeat', true, 'manual'],
  ['cron', true, 'schedule'],
] as const)('delivers %s via %s fixed selection on %s through the engine and IPC worker', async (kind, fixed, trigger) => {
  home = await mkdtemp(join(tmpdir(), 'automation-dispatch-'))
  vi.stubEnv('CODEX_HOME', home)
  vi.stubEnv('CODEXUI_CODEX_COMMAND', resolve('src/server/fixtures/account-app-server.cjs'))
  const coordinator = getAccountAuthCoordinator()
  const credential = (id: string) => JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    account_id: id,
    refresh_token: 'fixture',
    access_token: 'header.' + Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600,
      'https://api.openai.com/auth': { chatgpt_account_id: id, user_id: id },
    })).toString('base64url') + '.signature',
  } })
  const a = await coordinator.store.upsertCredential(credential('a'), { activate: true })
  const b = await coordinator.store.upsertCredential(credential('b'))
  vi.spyOn(coordinator, 'refreshAccount').mockImplementation(async id => (await coordinator.store.readState()).accounts.find(account => account.storageId === id)!)
  const authBefore = await readFile(join(home, 'auth.json'), 'utf8')
  app = new AppServerProcess()
  const runtimeApp = app
  const targetThreadId = kind === 'heartbeat'
    ? ((await app.rpc('thread/start', { cwd: home })) as { thread: { id: string } }).thread.id
    : null
  const target = targetThreadId || home
  let now = Date.parse('2026-09-10T01:00:30Z')
  const marker = `AUTOMATION_0215_${kind}_${fixed}_${trigger}`
  await mkdir(join(home, 'automations', 'dispatch'), { recursive: true })
  await writeFile(join(home, 'automations', 'dispatch', 'automation.toml'), serializeAutomationToml({
    id: 'dispatch', name: marker, kind, prompt: marker, rrule: 'FREQ=MINUTELY',
    status: trigger === 'schedule' ? 'ACTIVE' : 'PAUSED', targetThreadId,
    cwds: kind === 'cron' ? [home] : [], createdAtMs: now, updatedAtMs: now,
    nextRunAtMs: null, extraTomlLines: [], model: 'fixture', reasoningEffort: 'low',
    ...(fixed ? { accountStorageId: b.account.storageId } : {}),
  }))
  const rpc = vi.fn((method: string, params: unknown, runId?: string) => runtimeApp.automationRpc(method, params, runId))
  const runtime = createAutomationRuntime({
    rpc,
    acquireAccount: (id, settings) => runtimeApp.acquireTaskAccount(id, settings),
    releaseAccount: id => runtimeApp.releaseTaskAccount(id),
    accountStorageId: id => runtimeApp.taskAccountStorageId(id),
    accountBusy: () => false, hasQueuedMessages: async () => false,
    pendingRequests: () => runtimeApp.listPendingServerRequests(),
    readHistory: id => runtimeApp.automationRpc('thread/read', { threadId: id, includeTurns: true }),
    buildParams: async (threadId, text) => ({ threadId, input: [{ type: 'text', text }] }),
  })
  engine = new AutomationEngine(home, runtime, () => now, false)
  const runningEngine = engine
  runtimeApp.onNotification(notification => runningEngine.notification(notification))
  await engine.readyPromise
  if (trigger === 'schedule') now += 60_000
  else {
    const first = await engine.manual('dispatch', target, 'one-request')
    expect((await engine.manual('dispatch', target, 'one-request')).runId).toBe(first.runId)
  }
  await engine.tick()
  await vi.waitFor(async () => {
    await runningEngine.refresh()
    expect(runningEngine.runs('dispatch').data[0]?.status).toBe('completed')
  })
  const run = engine.runs('dispatch').data[0]!
  expect(run).toMatchObject({ trigger, executionAccountStorageId: fixed ? b.account.storageId : a.account.storageId })
  const thread = (await runtimeApp.automationRpc('thread/read', { threadId: run.threadId, includeTurns: true })) as any
  expect(thread.thread.turns).toHaveLength(1)
  expect(thread.thread.turns[0].items[0].content[0].text).toContain(marker)
  expect(thread.thread.turns[0].items[0].content[0].text).toContain(`[CodexApp automation run:${run.runId}]`)
  expect(thread.thread.turns[0].items.at(-1).text).toBe(fixed ? 'OUTPUT:b' : 'OUTPUT:a')
  expect(rpc.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1)
  expect(rpc.mock.calls.filter(([method]) => method === 'thread/resume')).toHaveLength(0)
  expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe(authBefore)
  expect(engine.snapshot()).toMatchObject({ activeCount: 0, queuedCount: 0 })
  if (kind === 'cron' && fixed && trigger === 'manual') {
    vi.spyOn(runtime, 'start').mockRejectedValueOnce(Object.assign(new Error('401 fixture rejection'), { rpcRejected: true }))
    const rejected = await engine.manual('dispatch', target, 'rejected-request')
    await engine.tick()
    expect(engine.runs('dispatch').data[0]).toMatchObject({ runId: rejected.runId, status: 'failed', errorCode: 'AUTH_REQUIRED' })
    await engine.tick()
    expect(rpc.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1)
    const retry = await engine.manual('dispatch', target, 'retry-request', rejected.runId)
    expect(retry).toMatchObject({ trigger: 'retry', retryOf: rejected.runId, attempt: 2 })
    expect((await engine.manual('dispatch', target, 'retry-request', rejected.runId)).runId).toBe(retry.runId)
    await engine.tick()
    await vi.waitFor(async () => {
      await runningEngine.refresh()
      expect(runningEngine.runs('dispatch').data[0]).toMatchObject({ runId: retry.runId, status: 'completed' })
    })
    expect(rpc.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(2)
  }
}, 15_000)
