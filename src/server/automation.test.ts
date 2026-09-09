import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { parseAutomationToml, serializeAutomationToml } from './automationDefinition.js'
import { createAutomationSchedule } from './automationSchedule.js'
import { AutomationEngine, type AutomationRuntime, type AutomationInspection } from './automationEngine.js'
import { AutomationStore } from './automationStore.js'
import { createAutomationRuntime } from './automationRuntime.js'

const roots: string[] = []
const engines: AutomationEngine[] = []
afterEach(async () => { for (const engine of engines.splice(0)) await engine.dispose(); for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })

describe('automation definitions and time', () => {
  it('roundtrips multiline prompts, quoted paths and unknown TOML tables', () => {
    const raw = `id='test'\nname='日历'\nkind='cron'\nprompt='''第一行\n第二行 /a\\b'''\nrrule='FREQ=WEEKLY;BYDAY=MO;BYHOUR=1;BYMINUTE=0'\ncwds=['/space here', '/a\\b']\n[scheduler]\nprivate_flag=true\n`
    const value = parseAutomationToml(raw)!
    expect(value.prompt).toBe('第一行\n第二行 /a\\b')
    expect(parse(serializeAutomationToml(value)).scheduler).toEqual({ private_flag: true })
    expect(parseAutomationToml(serializeAutomationToml(value))?.cwds).toEqual(value.cwds)
    expect(parseAutomationToml(`id='unclosed`)).toBeNull()
  })
  it('calculates Monday 01:00 Shanghai independently of host timezone', () => {
    const schedule = createAutomationSchedule('FREQ=WEEKLY;BYDAY=MO;BYHOUR=1;BYMINUTE=0', 'Asia/Shanghai', Date.parse('2026-09-06T00:00:00Z'))
    expect(new Date(schedule.next(Date.parse('2026-09-06T00:00:00Z'))!).toISOString()).toBe('2026-09-06T17:00:00.000Z')
    expect(schedule.next(Date.parse('2026-09-06T17:00:00Z'))).toBe(Date.parse('2026-09-13T17:00:00Z'))
  })
  it('skips nonexistent DST time and runs repeated wall times once', () => {
    const spring = createAutomationSchedule('FREQ=DAILY;BYHOUR=2;BYMINUTE=30', 'America/New_York', Date.parse('2026-03-01T00:00:00Z'))
    expect(new Date(spring.next(Date.parse('2026-03-07T12:00:00Z'))!).toISOString()).toBe('2026-03-09T06:30:00.000Z')
    const fall = createAutomationSchedule('FREQ=DAILY;BYHOUR=1;BYMINUTE=30', 'America/New_York', Date.parse('2026-10-01T00:00:00Z'))
    expect(fall.next(Date.parse('2026-11-01T00:00:00Z'))).toBe(Date.parse('2026-11-01T05:30:00Z'))
    expect(fall.next(Date.parse('2026-11-01T05:30:00Z'))).toBe(Date.parse('2026-11-02T06:30:00Z'))
  })
  it('keeps a stable elapsed interval anchor across long gaps', () => {
    const anchor = Date.parse('2020-01-01T00:00:00Z')
    const schedule = createAutomationSchedule('FREQ=MINUTELY;INTERVAL=7', 'Asia/Shanghai', anchor)
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect((schedule.next(now)! - anchor) % 420000).toBe(0)
    expect(schedule.previous(now)).toBeLessThanOrEqual(now)
  })
  it.each(['FREQ=MONTHLY', 'FREQ=DAILY;INTERVAL=0', 'FREQ=DAILY;BYHOUR=25', 'FREQ=DAILY;BYDAY=2MO', 'FREQ=MINUTELY;BYMINUTE=30', 'FREQ=DAILY;COUNT=2'])('rejects unsupported rules: %s', (rule) => {
    expect(() => createAutomationSchedule(rule, 'Asia/Shanghai', Date.now())).toThrow()
  })
})

async function fixture(options: { rule?: string; heartbeat?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'automation-0190-')); roots.push(home)
  const dir = join(home, 'automations', 'test'); await mkdir(dir, { recursive: true })
  let now = Date.parse('2026-09-06T00:00:30Z')
  const definition = { id: 'test', name: '虚构日历', kind: options.heartbeat ? 'heartbeat' : 'cron', prompt: 'Write a fictional calendar fixture', status: 'ACTIVE', rrule: options.rule ?? 'FREQ=MINUTELY', targetThreadId: options.heartbeat ? 'thread-existing' : null, cwds: options.heartbeat ? [] : [home], extraTomlLines: [], createdAtMs: now - 86400000, updatedAtMs: now, nextRunAtMs: null } as const
  const path = join(dir, 'automation.toml')
  await writeFile(path, serializeAutomationToml({ ...definition, cwds: [...definition.cwds], extraTomlLines: [] }))
  let inspection: AutomationInspection = { status: 'running', turnId: 'turn-1' }
  const runtime: AutomationRuntime = {
    accountBusy: vi.fn(() => false), canStart: vi.fn(async () => true),
    createThread: vi.fn(async () => ({ threadId: 'thread-1', model: 'test-model' })),
    prepare: vi.fn(async () => ({})), start: vi.fn(async () => ({ turnId: 'turn-1' })),
    inspect: vi.fn(async () => inspection), interrupt: vi.fn(async () => {}),
  }
  const make = async () => { const engine = new AutomationEngine(home, runtime, () => now, false); engines.push(engine); await engine.readyPromise; return engine }
  const engine = await make()
  return { home, path, engine, make, runtime, advance: (ms: number) => { now += ms }, inspect: (value: AutomationInspection) => { inspection = value } }
}

describe('durable automation execution', () => {
  it('archives records beyond the scheduling window without losing manual idempotency or retry links', async () => {
    const f = await fixture()
    const original = await f.engine.manual('test', f.home, 'archive-idempotency')
    await f.engine.tick()
    f.engine.notification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } })
    await f.engine.refresh()
    f.advance(31 * 86400000); await f.engine.refresh()
    expect(f.engine.runs('test').data.find(run => run.runId === original.runId)).toBeUndefined()
    expect((await f.engine.historyPage('test', null, 100)).data.find(run => run.runId === original.runId)?.status).toBe('completed')
    const duplicate = await f.engine.manual('test', f.home, 'archive-idempotency')
    expect(duplicate.runId).toBe(original.runId)
    const retry = await f.engine.manual('test', f.home, 'archive-retry', original.runId)
    expect(retry.retryOf).toBe(original.runId); expect(retry.attempt).toBe(2)
  })

  it('treats an unloaded interrupted process as interrupted, and correlates only its own run marker', async () => {
    const f = await fixture()
    const run = await f.engine.manual('test', f.home, 'runtime-inspection')
    run.threadId = 'thread-1'; run.turnId = 'turn-1'
    const response = { thread: { status: { type: 'notLoaded' }, turns: [{ id: 'turn-1', status: 'inProgress', items: [] as unknown[] }] } }
    const runtime = createAutomationRuntime({ rpc: async () => response, accountBusy: () => false, hasQueuedMessages: async () => false, pendingRequests: () => [], readHistory: async () => response, buildParams: async () => ({}) })
    expect((await runtime.inspect(run)).status).toBe('interrupted')
    run.turnId = null
    response.thread.turns[0]!.status = 'completed'
    response.thread.turns[0]!.items = [{ type: 'userMessage', content: [{ type: 'text', text: 'unrelated prompt' }] }]
    expect((await runtime.inspect(run)).status).toBe('unknown')
    response.thread.turns[0]!.items = [{ type: 'userMessage', id: run.runId, clientId: 'other-run', content: [] }]
    expect((await runtime.inspect(run)).status).toBe('unknown')
    response.thread.turns[0]!.items = [{ type: 'userMessage', id: 'native-item', clientId: run.runId, content: [] }]
    expect(await runtime.inspect(run)).toEqual({ status: 'completed', turnId: 'turn-1' })
    response.thread.turns[0]!.items = [{ type: 'userMessage', content: [{ type: 'text', text: `[CodexApp automation run:${run.runId}]` }] }]
    expect(await runtime.inspect(run)).toEqual({ status: 'completed', turnId: 'turn-1' })
  })
  it('records explicit upstream rejection immediately without replaying it', async () => {
    const f = await fixture()
    vi.mocked(f.runtime.start).mockRejectedValue(Object.assign(new Error('401 invalid token'), { rpcRejected: true }))
    await f.engine.manual('test', f.home, 'rejected'); await f.engine.tick()
    expect(f.engine.runs('test').data[0]?.status).toBe('failed')
    expect(f.engine.runs('test').data[0]?.errorCode).toBe('AUTH_REQUIRED')
    await f.engine.tick(); expect(f.runtime.start).toHaveBeenCalledTimes(1)
  })
  it('records nested server approval requests and never auto-approves them', async () => {
    const f = await fixture()
    await f.engine.manual('test', f.home, 'approval'); await f.engine.tick()
    f.engine.notification({ method: 'server/request', params: { id: 1, params: { threadId: 'thread-1', turnId: 'turn-1' } } })
    await f.engine.refresh()
    expect(f.engine.runs('test').data[0]?.status).toBe('waiting_input')
    f.engine.notification({ method: 'server/request/resolved', params: { threadId: 'thread-1' } })
    await f.engine.refresh()
    expect(f.engine.runs('test').data[0]?.status).toBe('running')
  })
  it('fails closed for corrupt persistent state instead of resetting the schedule', async () => {
    const f = await fixture(); await f.engine.dispose()
    await writeFile(join(f.home, 'codexapp-automations', 'state.json'), 'broken-json')
    const restarted = await f.make()
    expect(restarted.snapshot().ready).toBe(false)
    await restarted.tick(); expect(f.runtime.start).not.toHaveBeenCalled()
  })
  it('adopts old definitions only from the next future occurrence and persists completion', async () => {
    const f = await fixture()
    await f.engine.tick(); expect(f.runtime.start).not.toHaveBeenCalled()
    expect(f.engine.snapshot().definitions[0]?.nextRunAtMs).toBe(Date.parse('2026-09-06T00:01:00Z'))
    f.advance(30000); await f.engine.tick()
    expect(f.runtime.start).toHaveBeenCalledTimes(1)
    expect(f.engine.runs('test').data[0]?.status).toBe('running')
    f.inspect({ status: 'completed', turnId: 'turn-1' }); f.advance(30000); await f.engine.tick()
    expect(f.engine.runs('test').data[0]?.status).toBe('completed')
    expect(JSON.parse(await readFile(join(f.home, 'codexapp-automations', 'state.json'), 'utf8')).runs[0].status).toBe('completed')
  })
  it('deduplicates manual requests and does not call start twice while active', async () => {
    const f = await fixture()
    const first = await f.engine.manual('test', f.home, 'request-1')
    expect((await f.engine.manual('test', f.home, 'request-1')).runId).toBe(first.runId)
    await f.engine.tick(); await f.engine.tick()
    expect(f.runtime.start).toHaveBeenCalledTimes(1)
    expect(f.engine.activity()).toEqual(['thread-1'])
  })
  it('does not replay ambiguous start responses, including after restart', async () => {
    const f = await fixture()
    vi.mocked(f.runtime.start).mockRejectedValue(new Error('ECONNRESET after submission'))
    await f.engine.manual('test', f.home, 'lost-response'); await f.engine.tick()
    expect(f.engine.runs('test').data[0]?.status).toBe('starting')
    await f.engine.dispose()
    f.inspect({ status: 'completed', turnId: 'turn-1' })
    const restarted = await f.make()
    expect(restarted.runs('test').data[0]?.status).toBe('completed')
    await restarted.tick(); expect(f.runtime.start).toHaveBeenCalledTimes(1)
  })
  it('keeps only one waiting schedule and records coalesced occurrences', async () => {
    const f = await fixture()
    f.advance(30000); await f.engine.tick()
    f.advance(60000); await f.engine.tick()
    f.advance(180000); await f.engine.tick()
    const runs = f.engine.runs('test').data
    expect(runs.filter((run) => run.status === 'queued')).toHaveLength(1)
    expect(runs.some((run) => run.status === 'skipped')).toBe(true)
    expect(f.runtime.start).toHaveBeenCalledTimes(1)
  })
  it('catches up only latest missed run and prevents backward-clock repeats', async () => {
    const f = await fixture()
    await f.engine.dispose(); f.advance(3600000)
    const restarted = await f.make(); await restarted.tick()
    expect(f.runtime.start).toHaveBeenCalledTimes(1)
    expect(restarted.runs('test').data.filter((run) => run.status === 'running')).toHaveLength(1)
    f.advance(-1800000); await restarted.tick(); expect(f.runtime.start).toHaveBeenCalledTimes(1)
  })
  it('marks occurrences older than 24h missed without running them', async () => {
    const f = await fixture({ rule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=1;BYMINUTE=0' })
    await f.engine.dispose(); f.advance(3 * 86400000)
    const restarted = await f.make(); await restarted.tick()
    expect(f.runtime.start).not.toHaveBeenCalled()
    expect(restarted.runs('test').data.some((run) => run.status === 'missed')).toBe(true)
  })
  it('waits for heartbeat target and account operations, and drain blocks new runs', async () => {
    const f = await fixture({ heartbeat: true })
    vi.mocked(f.runtime.canStart).mockResolvedValue(false)
    await f.engine.manual('test', 'thread-existing', 'wait'); await f.engine.tick()
    expect(f.runtime.start).not.toHaveBeenCalled()
    vi.mocked(f.runtime.canStart).mockResolvedValue(true); vi.mocked(f.runtime.accountBusy).mockReturnValue(true)
    await f.engine.tick(); expect(f.runtime.start).not.toHaveBeenCalled()
    await f.engine.drain(); await expect(f.engine.manual('test', 'thread-existing', 'new')).rejects.toThrow('交接')
    vi.mocked(f.runtime.accountBusy).mockReturnValue(false); await f.engine.tick()
    expect(f.runtime.start).toHaveBeenCalledTimes(1)
  })
  it('exposes invalid definitions and cancels queued jobs when deleted', async () => {
    const f = await fixture()
    await f.engine.manual('test', f.home, 'queued')
    await writeFile(f.path, 'invalid!'); await f.engine.refresh()
    expect(f.engine.snapshot().definitions[0]?.error).toContain('无效')
    expect(f.engine.runs('test').data[0]?.status).toBe('cancelled')
    await rm(f.path); await f.engine.refresh()
    expect(f.engine.snapshot().definitions).toHaveLength(0)
  })
  it('retries only definitely unsubmitted transient failures and limits attempts', async () => {
    const f = await fixture()
    vi.mocked(f.runtime.prepare).mockRejectedValue(new Error('ECONNRESET'))
    await f.engine.manual('test', f.home, 'retry')
    await f.engine.tick(); f.advance(5000); await f.engine.tick(); f.advance(10000); await f.engine.tick()
    expect(f.engine.runs('test').data[0]?.status).toBe('failed')
    expect(f.runtime.prepare).toHaveBeenCalledTimes(3)
    expect(f.runtime.start).not.toHaveBeenCalled()
  })
  it('does not persist raw credential error messages', async () => {
    const f = await fixture()
    vi.mocked(f.runtime.prepare).mockRejectedValue(new Error('401 Bearer secret-sentinel'))
    await f.engine.manual('test', f.home, 'auth'); await f.engine.tick()
    const state = await readFile(join(f.home, 'codexapp-automations', 'state.json'), 'utf8')
    expect(state).toContain('AUTH_REQUIRED'); expect(state).not.toContain('secret-sentinel')
  })
  it('acquires only one lease per home and releases on dispose', async () => {
    const f = await fixture()
    const second = await f.make()
    expect(second.snapshot().ready).toBe(false)
    expect(second.snapshot().error).toContain('调度锁')
    await f.engine.dispose()
    const third = await f.make(); expect(third.snapshot().ready).toBe(true)
    const store = new AutomationStore(join(f.home, 'codexapp-automations'))
    expect(await store.acquire(Date.now())).toBe(false)
  })
})

it('recomputes existing schedules when the global timezone changes and ignores legacy per-task timezone', async () => {
  const f = await fixture({ rule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' })
  await mkdir(join(f.home, 'account-activation'), { recursive: true })
  await writeFile(f.path, (await readFile(f.path, 'utf8')) + '\ntimezone = "America/New_York"\n')
  await writeFile(join(f.home, 'account-activation/state.json'), JSON.stringify({ settings: { timezone: 'UTC' } }))
  await f.engine.refresh()
  expect(f.engine.snapshot().definitions[0]?.timezone).toBe('UTC')
  const before = f.engine.snapshot().definitions[0]?.nextRunAtMs
  await writeFile(join(f.home, 'account-activation/state.json'), JSON.stringify({ settings: { timezone: 'Asia/Shanghai' } }))
  await f.engine.refresh()
  expect(f.engine.snapshot().definitions[0]?.timezone).toBe('Asia/Shanghai')
  expect(f.engine.snapshot().definitions[0]?.nextRunAtMs).not.toBe(before)
})

it('dispatches another account while the first account is still acquiring, and removal cancels only the selected work', async () => {
  const f = await fixture()
  const second = parseAutomationToml(await readFile(f.path, 'utf8'))!
  second.id = 'second'
  second.accountStorageId = 'b'.repeat(64)
  await mkdir(join(f.home, 'automations', 'second'))
  await writeFile(join(f.home, 'automations', 'second', 'automation.toml'), serializeAutomationToml(second))
  let finishAcquire!: (ready: boolean) => void
  const held = new Promise<boolean>(done => { finishAcquire = done })
  f.runtime.acquireAccount = vi.fn(async (_id, settings) => settings.accountStorageId ? true : held)
  const first = await f.engine.manual('test', f.home, 'held-account')
  const other = await f.engine.manual('second', f.home, 'other-account')
  const tick = f.engine.tick()
  await vi.waitFor(() => expect(f.runtime.start).toHaveBeenCalledOnce())
  await f.engine.cancelAccount('a'.repeat(64), true, [first.runId])
  expect(f.engine.runs('test').data[0]?.status).toBe('cancelled')
  expect(f.engine.runs('second').data.find(run => run.runId === other.runId)?.status).toBe('running')
  finishAcquire(true)
  await tick
  expect(f.runtime.start).toHaveBeenCalledOnce()
  expect(f.engine.runs('test').data[0]?.status).toBe('cancelled')
})

it('keeps the acquired default account fixed when a different primary is removed', async () => {
  const f = await fixture()
  const selected = 'b'.repeat(64)
  f.runtime.acquireAccount = async () => true
  f.runtime.accountStorageId = () => selected
  const run = await f.engine.manual('test', f.home, 'fixed-execution-account')
  await f.engine.tick()
  await f.engine.cancelAccount('a'.repeat(64), true, [])
  expect(f.engine.runs('test').data.find(row => row.runId === run.runId)).toMatchObject({ status: 'running', executionAccountStorageId: selected })
  await f.engine.cancelAccount(selected, false, [run.runId])
  expect(f.engine.runs('test').data.find(row => row.runId === run.runId)?.status).toBe('cancelled')
})
