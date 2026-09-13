import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutomationEngine, type AutomationRuntime } from '../../src/server/automationEngine'
import { serializeAutomationToml } from '../../src/server/automationDefinition'
import { AutomationHistory } from '../../src/server/automationHistory'
import { createDeliveryId } from '../../src/delivery'
import { rememberWebDelivery, submitRememberedDelivery, readPendingWebDeliveries } from '../../src/api/deliveryOutbox'
import { readConversationDeliveryCache } from '../../src/api/conversationDeliveryCache'
import { useConversationDeliveries } from '../../src/composables/useConversationDeliveries'
import { useThreadInterruptions } from '../../src/composables/useThreadInterruptions'
import { createRenderer, defineComponent } from 'vue'

const observations: Record<string, unknown> = {}
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await writeFile('output/0219-review/probe-observations.json', JSON.stringify(observations, null, 2) + '\n')
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

// These tests assert the observed defects for review reproduction. A green
// result confirms a defect exists; it is not an acceptance test of correct behavior.
it('REPRO: a public manual request is acknowledged but erased by an in-flight dispatch save', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codexapp-review-save-'))
  const acquired = deferred<boolean>()
  const archiveRelease = deferred<void>()
  const archiveEntered = deferred<void>()
  let engine: AutomationEngine | undefined
  let tick: Promise<void> | undefined
  try {
    const now = Date.parse('2026-09-13T00:00:30Z')
    const directory = join(home, 'automations', 'test')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'automation.toml'), serializeAutomationToml({
      id: 'test', name: 'Isolated review fixture', kind: 'cron', prompt: 'Fixture only',
      status: 'ACTIVE', rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0', cwds: [home],
      targetThreadId: null, extraTomlLines: [], createdAtMs: now, updatedAtMs: now, nextRunAtMs: null,
    }))
    const runtime: AutomationRuntime = {
      accountBusy: () => false, canStart: async () => true,
      acquireAccount: vi.fn(() => acquired.promise),
      createThread: async () => ({ threadId: 'review-thread' }),
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
    vi.spyOn(AutomationHistory.prototype, 'archive').mockImplementation(async function (runs) {
      if (holdNext) {
        holdNext = false
        archiveEntered.resolve()
        await archiveRelease.promise
      }
      return originalArchive.call(this, runs)
    })
    acquired.resolve(true)
    await archiveEntered.promise
    const manual = engine.manual('test', home, 'second-request')
    await vi.waitFor(() => expect(engine!.runs('test').data).toHaveLength(2))
    archiveRelease.resolve()
    const acknowledged = await manual
    await tick
    const saved = JSON.parse(await readFile(join(home, 'codexapp-automations', 'state.json'), 'utf8'))
    const memoryHasAcknowledged = engine.runs('test').data.some(run => run.runId === acknowledged.runId)
    const diskHasAcknowledged = saved.runs.some((run: { runId: string }) => run.runId === acknowledged.runId)
    const historyHasAcknowledged = (await engine.historyPage('test', null, 100)).data.some(run => run.runId === acknowledged.runId)
    const sameRequest = await engine.manual('test', home, 'second-request')
    observations.automationSaveRace = {
      manualReturned: acknowledged.status,
      firstRunStillPresent: engine.runs('test').data.some(run => run.runId === first.runId),
      memoryHasAcknowledged, diskHasAcknowledged, historyHasAcknowledged,
      sameRequestReturnedSameRun: sameRequest.runId === acknowledged.runId,
      actualStartCount: vi.mocked(runtime.start).mock.calls.length,
      isolation: 'temporary CODEX_HOME, real engine and storage; deferred fixture runtime and one delayed archive call',
    }
    expect(memoryHasAcknowledged).toBe(false)
    expect(diskHasAcknowledged).toBe(false)
    expect(historyHasAcknowledged).toBe(false)
    expect(sameRequest.runId).not.toBe(acknowledged.runId)
  } finally {
    acquired.resolve(true)
    archiveRelease.resolve()
    await tick?.catch(() => {})
    await engine?.dispose()
    await rm(home, { recursive: true, force: true })
  }
})

it('REPRO: acknowledged steer disappears on reload when display-cache writes run out of space', async () => {
  const saved = new Map<string, string>()
  let writesFail = false
  vi.stubGlobal('localStorage', {
    get length() { return saved.size },
    key: (index: number) => [...saved.keys()][index] ?? null,
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (writesFail) throw new Error('QuotaExceededError')
      saved.set(key, value)
    },
    removeItem: (key: string) => saved.delete(key),
  })
  const message = { id: createDeliveryId(), text: 'review queued steer', imageUrls: [], skills: [],
    fileAttachments: [], collaborationMode: 'default' as const, model: 'fixture-model' }
  const tracker = useConversationDeliveries()
  tracker.begin('review-thread', message)
  const pending = rememberWebDelivery('delivery', {
    protocol: 2, threadId: 'review-thread', mode: 'steer', message,
  })
  writesFail = true
  tracker.refresh()
  expect(tracker.project('review-thread', [])).toHaveLength(1)
  const fetch = vi.fn(async () => new Response(JSON.stringify({ data: {
    id: pending.id, status: 'accepted', turnId: 'review-turn',
  } })))
  vi.stubGlobal('fetch', fetch)
  const ack = await submitRememberedDelivery(pending)
  const restored = useConversationDeliveries()
  restored.refresh()
  observations.steerStorageFull = {
    ack: ack.data.status,
    requestCount: fetch.mock.calls.length,
    pendingOutboxCount: readPendingWebDeliveries().length,
    displayCacheCount: readConversationDeliveryCache().length,
    visibleRowsAfterReloadBeforeNativeHistory: restored.project('review-thread', []).length,
  }
  expect(ack.data.status).toBe('accepted')
  expect(restored.project('review-thread', [])).toHaveLength(0)
})

it('REPRO: a stalled interruption snapshot prevents reconnect refresh and keeps all ignore actions busy', async () => {
  const snapshot = deferred<Response>()
  const fetch = vi.fn((url: string) => url.endsWith('thread-interruptions')
    ? snapshot.promise : Promise.resolve(new Response('{}')))
  vi.stubGlobal('fetch', fetch)
  const renderer = createRenderer<any, any>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    insert() {}, remove() {}, setText() {}, setElementText() {}, parentNode: () => null,
    nextSibling: () => null, patchProp() {},
  })
  let state!: ReturnType<typeof useThreadInterruptions>
  const app = renderer.createApp(defineComponent({
    setup() { state = useThreadInterruptions(); return () => null },
  }))
  app.mount({})
  try {
    state.observe({ method: 'ready' })
    state.observe({ method: 'codexapp/interruptions/changed', params: {
      threadId: 'review-thread', issues: [{ turnId: 'review-turn', kind: 'error' }],
    } })
    let settled = false
    const ignoring = state.ignoreThread('review-thread').then(() => { settled = true })
    await vi.waitFor(() => expect(fetch.mock.calls.filter(([url]) => url.endsWith('ignored-quota-errors'))).toHaveLength(1))
    state.observe({ method: 'ready' })
    state.observe({ method: 'codexapp/interruptions/changed', params: { threadId: 'review-thread', issues: [] } })
    state.observe({ method: 'codexapp/interruptions/changed', params: {
      threadId: 'second-thread', issues: [{ turnId: 'second-turn', kind: 'quota' }],
    } })
    await state.ignoreThread('second-thread')
    await Promise.resolve()
    observations.interruptionSnapshotHang = {
      snapshotRequestsAfterReconnect: fetch.mock.calls.filter(([url]) => url.endsWith('thread-interruptions')).length,
      successfulIgnorePosts: fetch.mock.calls.filter(([url]) => url.endsWith('ignored-quota-errors')).length,
      ignoringBusyDespitePostSuccessAndSse: state.ignoring.value,
      firstIgnoreSettled: settled,
      secondThreadStillHasIssue: state.issues.value['second-thread']?.length === 1,
      faultModel: 'initial GET held open; subsequent POST and SSE healthy; no request timeout in source',
    }
    expect(settled).toBe(false)
    expect(state.ignoring.value).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
    snapshot.resolve(new Response(JSON.stringify({ data: {} })))
    await ignoring
    expect(state.ignoring.value).toBe(false)
  } finally {
    snapshot.resolve(new Response(JSON.stringify({ data: {} })))
    app.unmount()
  }
})
