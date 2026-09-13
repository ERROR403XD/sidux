import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutomationEngine, type AutomationRuntime } from './automationEngine'
import { serializeAutomationToml } from './automationDefinition'
import { AutomationHistory } from './automationHistory'

afterEach(() => vi.restoreAllMocks())
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

it.each(['manual', 'schedule'] as const)('retains %s admission during a dispatch save and executes it once after restart', async trigger => {
  const home = await mkdtemp(join(tmpdir(), 'codexapp-review-save-'))
  const acquired = deferred<boolean>()
  const archiveRelease = deferred<void>()
  const archiveEntered = deferred<void>()
  let engine: AutomationEngine | undefined
  let tick: Promise<void> | undefined
  try {
    let now = Date.parse('2026-09-13T00:00:30Z')
    const directory = join(home, 'automations', 'test')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'automation.toml'), serializeAutomationToml({
      id: 'test', name: 'Isolated review fixture', kind: 'cron', prompt: 'Fixture only',
      status: 'ACTIVE', rrule: 'FREQ=MINUTELY', cwds: [home],
      targetThreadId: null, extraTomlLines: [], createdAtMs: now, updatedAtMs: now, nextRunAtMs: null,
    }))
    const runtime: AutomationRuntime = {
      accountBusy: () => false, canStart: async () => true,
      acquireAccount: vi.fn(() => acquired.promise),
      createThread: vi.fn(async () => ({ threadId: `review-thread-${vi.mocked(runtime.start).mock.calls.length}` })),
      prepare: async () => ({}), start: vi.fn(async () => ({ turnId: 'review-turn' })),
      inspect: async () => ({ status: 'running' }), interrupt: async () => {},
    }
    engine = new AutomationEngine(home, runtime, () => now, false)
    await engine.readyPromise
    expect(engine.snapshot().ready).toBe(true)
    const first = await engine.manual('test', home, 'first-request')
    tick = engine.tick()
    await vi.waitFor(() => expect(runtime.acquireAccount).toHaveBeenCalledTimes(1))

    // Delay one actual storage operation, without replacing scheduling logic.
    // The next save originates in dispatch after account acquisition, outside
    // the control queue. Its captured hot list contains only the first run.
    const originalArchive = AutomationHistory.prototype.archive
    let holdNext = true
    vi.spyOn(AutomationHistory.prototype, 'archive').mockImplementation(async function (this: AutomationHistory, runs) {
      if (holdNext) {
        holdNext = false
        archiveEntered.resolve()
        await archiveRelease.promise
      }
      return originalArchive.call(this, runs)
    })
    acquired.resolve(true)
    await archiveEntered.promise
    if (trigger === 'schedule') now += 31_000
    const admitted = trigger === 'manual' ? engine.manual('test', home, 'second-request') : engine.tick()
    await vi.waitFor(() => expect(engine!.runs('test').data).toHaveLength(2))
    const added = engine.runs('test').data.find(run => run.runId !== first.runId)!
    archiveRelease.resolve()
    const response = await admitted
    if (trigger === 'manual') expect(response).toMatchObject({ runId: added.runId, status: 'queued' })
    const acknowledged = added
    await tick
    const saved = JSON.parse(await readFile(join(home, 'codexapp-automations', 'state.json'), 'utf8'))
    const memoryHasAcknowledged = engine.runs('test').data.some(run => run.runId === acknowledged.runId)
    const diskHasAcknowledged = saved.runs.some((run: { runId: string }) => run.runId === acknowledged.runId)
    const historyHasAcknowledged = (await engine.historyPage('test', null, 100)).data.some(run => run.runId === acknowledged.runId)
    expect(memoryHasAcknowledged).toBe(true)
    expect(diskHasAcknowledged).toBe(true)
    expect(historyHasAcknowledged).toBe(true)
    expect(vi.mocked(runtime.start)).toHaveBeenCalledTimes(1)
    if (trigger === 'manual') expect((await engine.manual('test', home, 'second-request')).runId).toBe(added.runId)
    engine.notification({ method: 'turn/completed', params: {
      threadId: 'review-thread-0', turn: { id: 'review-turn', status: 'completed' },
    } })
    await engine.refresh()
    expect(engine.runs('test').data.find(run => run.runId === first.runId)?.status).toBe('completed')
    await engine.dispose()
    engine = new AutomationEngine(home, runtime, () => now, false)
    await engine.readyPromise
    expect(engine.runs('test').data.find(run => run.runId === added.runId)?.status).toBe('queued')
    await engine.tick()
    await engine.tick()
    expect(runtime.start).toHaveBeenCalledTimes(2)
    expect(engine.runs('test').data.find(run => run.runId === added.runId)?.status).toBe('running')
  } finally {
    acquired.resolve(true)
    archiveRelease.resolve()
    await tick?.catch(() => {})
    await engine?.dispose()
    await rm(home, { recursive: true, force: true })
  }
})
