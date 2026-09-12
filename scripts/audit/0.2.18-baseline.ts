/** Baseline characterization probes. These intentionally confirm known defects;
 * do not add them to the regular regression suite. No accounts or network sends.
 * Run with esbuild as described in the 0.2 baseline review document.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { AutomationEngine, type AutomationRuntime } from '../../src/server/automationEngine'
import { serializeAutomationToml } from '../../src/server/automationDefinition'
import { ThreadQuotaResume } from '../../src/server/threadQuotaResume'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function fixture(count: number, runtime: AutomationRuntime) {
  const home = await mkdtemp(join(tmpdir(), 'codexapp-0218-audit-'))
  let now = Date.parse('2026-09-12T00:00:30Z')
  for (let i = 0; i < count; i++) {
    const id = `audit-${i}`
    const folder = join(home, 'automations', id)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'automation.toml'), serializeAutomationToml({
      id, name: 'Synthetic audit', kind: 'heartbeat', prompt: 'Synthetic only', status: 'PAUSED',
      rrule: 'FREQ=MINUTELY', targetThreadId: `synthetic-${i}`, cwds: [], extraTomlLines: [],
      createdAtMs: now, updatedAtMs: now, nextRunAtMs: null,
    }))
  }
  const engine = new AutomationEngine(home, runtime, () => now, false)
  await engine.readyPromise
  assert.equal(engine.snapshot().ready, true)
  return { home, engine, advance: (ms: number) => { now += ms }, cleanup: async () => { await engine.dispose(); await rm(home, { recursive: true, force: true }) } }
}
function runtime(): AutomationRuntime {
  return {
    accountBusy: () => false, canStart: async () => true,
    createThread: async () => ({ threadId: 'unused' }),
    prepare: async (threadId: string) => ({ threadId }),
    start: async () => ({ turnId: 'synthetic-turn' }),
    inspect: async () => ({ status: 'running' }), interrupt: async () => {},
  }
}
async function slowInspection() {
  const adapter = runtime()
  const entered = deferred<void>()
  const gate = deferred<void>()
  adapter.inspect = async () => { entered.resolve(); await gate.promise; return { status: 'running' } }
  const f = await fixture(2, adapter)
  try {
    await f.engine.manual('audit-0', 'synthetic-0', 'first')
    await f.engine.tick()
    f.advance(31000)
    const tick = f.engine.tick()
    await entered.promise
    let manualCompleted = false
    let drainCompleted = false
    const begin = performance.now()
    const manual = f.engine.manual('audit-1', 'synthetic-1', 'second').then(() => { manualCompleted = true })
    const drain = f.engine.drain().then(() => { drainCompleted = true })
    await delay(100)
    assert.equal(manualCompleted, false)
    assert.equal(drainCompleted, false)
    gate.resolve()
    await Promise.all([tick, manual, drain])
    return { confirmed: true, syntheticInspectionDelayMs: 100, observedControlWaitMs: Math.round(performance.now() - begin), manualAndDrainBlockedUntilInspectionSettled: true }
  } finally { gate.resolve(); await f.cleanup() }
}
async function hangingAcquisition() {
  const adapter = runtime()
  const gate = deferred<boolean>()
  const allEntered = deferred<void>()
  let calls = 0
  adapter.acquireAccount = async () => { if (++calls === 4) allEntered.resolve(); return gate.promise }
  const f = await fixture(5, adapter)
  try {
    for (let i = 0; i < 5; i++) await f.engine.manual(`audit-${i}`, `synthetic-${i}`, `request-${i}`)
    const tick = f.engine.tick()
    await allEntered.promise
    f.advance(2 * 3600000)
    await f.engine.tick()
    assert.equal(f.engine.snapshot().activeCount, 4)
    assert.equal(f.engine.snapshot().queuedCount, 1)
    assert.equal(calls, 4)
    let disposed = false
    const disposal = f.engine.dispose().then(() => { disposed = true })
    await delay(30)
    assert.equal(disposed, false)
    gate.resolve(false)
    await Promise.all([tick, disposal])
    return { confirmed: true, virtualElapsedHours: 2, acquiring: 4, queued: 1, disposeWaitsForUnboundedAcquisition: true, scope: 'engine adapter contract; real network stall not injected' }
  } finally { gate.resolve(false); await f.cleanup() }
}
async function activationIdleGap() {
  const require = createRequire(join(process.cwd(), 'package.json'))
  const { checkIdle } = require('./scripts/check-codexapp-idle.cjs')
  const originalFetch = globalThis.fetch
  const requested: string[] = []
  globalThis.fetch = async (input, init) => {
    const route = new URL(String(input)).pathname
    requested.push(route)
    let payload: unknown
    if (route === '/codex-api/runtime/activity') payload = { data: { activeTurnThreadIds: [], pendingOperationCount: 0 } }
    else if (route === '/codex-api/automation-runtime') payload = { data: { ready: true, activeCount: 0, queuedCount: 0 } }
    else if (route === '/codex-api/thread-queue-state') payload = { data: {} }
    else if (route === '/codex-api/server-requests/pending') payload = { data: [] }
    else if (route === '/codex-api/api-proxy/status') payload = { data: { settings: { enabled: false }, activity: { connections: 0, activeRequests: 0 } } }
    else if (route === '/codex-api/meta/methods') payload = { data: [] }
    else if (route === '/codex-api/rpc') { assert.equal(JSON.parse(String(init?.body)).method, 'thread/list'); payload = { result: { data: [], nextCursor: null } } }
    else if (route === '/codex-api/api-proxy/activation') payload = { data: { runs: [{ status: 'sending' }], settings: { enabled: true } } }
    else throw new Error('Unexpected path ' + route)
    return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const result = await checkIdle('http://synthetic.invalid')
    assert.equal(result.idle, true)
    assert.equal(requested.includes('/codex-api/api-proxy/activation'), false)
    return { confirmed: true, syntheticActivationStatus: 'sending', reportedIdle: result.idle, activationEndpointRead: false, requested }
  } finally { globalThis.fetch = originalFetch }
}
async function continuationStarvation() {
  const home = await mkdtemp(join(tmpdir(), 'codexapp-0218-resume-audit-'))
  const marks = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`thread-${i}`, { status: 'waiting', blockedTurnId: 'failed-turn', attemptId: null }]))
  await writeFile(join(home, 'codexapp-quota-resume.json'), JSON.stringify({ version: 1, marks }))
  const inspected: string[] = []
  const submitted: string[] = []
  const resume = new ThreadQuotaResume(home, {
    inspect: async id => { inspected.push(id); return { active: id !== 'thread-8', status: 'failed', turnId: 'failed-turn', error: 'quota' } },
    available: async () => true, submit: async id => { submitted.push(id) }, cancel: async () => {}, changed: () => {},
  }, false)
  try {
    for (let n = 0; n < 3; n++) await resume.tick()
    assert.equal(inspected.includes('thread-8'), false)
    assert.equal(submitted.length, 0)
    return { confirmed: true, waiting: 9, firstEightBusy: true, ticks: 3, inspections: inspected.length, ninthInspected: false, submissions: 0 }
  } finally { await resume.close(); await rm(home, { recursive: true, force: true }) }
}
async function main() {
  const report = { baseline: 'f9a3b9494893', slowInspection: await slowInspection(), hangingAcquisition: await hangingAcquisition(), activationIdleGap: await activationIdleGap(), continuationStarvation: await continuationStarvation() }
  await writeFile('output/0218/audit-probes.json', JSON.stringify(report, null, 2) + '\n')
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
