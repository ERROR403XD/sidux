import { createServer, type IncomingMessage } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { BackendQueueProcessor, createBackendQueueRuntimeFixture } from './backendQueueRuntime'
import { ThreadScheduledResume } from './threadScheduledResume'
import { createThreadScheduledResumeRuntime } from './threadScheduledResumeRuntime'
import { createThreadScheduledResumeRoutes } from './routes/threadScheduledResumeRoutes'
import { automaticResumeStartedMethod } from '../threadAutomaticResume'

it('persists HTTP scheduling, inherits unopened history, and delivers once as a normal conversation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sidux-schedule-http-'))
  const rollout = join(home, 'rollout.jsonl')
  await writeFile(rollout, JSON.stringify({ type: 'turn_context', payload: { model: 'historical', effort: 'ultra' } }) + '\n'
    + JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(700_000) } }) + '\n')
  let now = 1000
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const { runtime, probe } = createBackendQueueRuntimeFixture({ rpc: async (method, input) => {
    const params = input as Record<string, unknown>
    calls.push({ method, params })
    if (method === 'thread/read') return { thread: { id: 'thread', path: rollout, status: { type: 'notLoaded' } } }
    if (method === 'thread/turns/list') return { data: [{ id: calls.some(call => call.method === 'turn/start') ? 'own-turn' : 'prior', status: 'inProgress', items: [] }] }
    if (method === 'turn/start') return { turn: { id: 'own-turn' } }
    return {}
  } })
  const queue = new BackendQueueProcessor(runtime, { directory: join(home, 'delivery'), startRecovery: false,
    features: async () => ({ historyPaging: true, resumeInitialPage: true, exactFork: true }), context: async () => 'fixture-context' })
  queue.deliveryContext = async () => 'fixture-context'
  const make = () => new ThreadScheduledResume(home, createThreadScheduledResumeRuntime({ notifyScheduledResumeChanged: () => {} }, queue), () => now, false)
  let scheduler = make()
  const server = createServer(async (req, res) => {
    const route = createThreadScheduledResumeRoutes(scheduler)
    await route(req, res, new URL(req.url!, 'http://localhost'), { readJsonBody: async (request: IncomingMessage) => {
      let body = ''
      for await (const chunk of request) body += chunk
      return JSON.parse(body)
    } } as never)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/codex-api/thread-scheduled-resume`
  try {
    const response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId: 'thread', at: 2000 }) })
    expect(response.status).toBe(200)
    const saved = (await response.json()).data.thread
    expect(saved.attemptId).toBe('')
    expect(saved.choice).toEqual({ model: 'historical', effort: 'ultra', tier: '' })
    expect(calls.some(call => call.method === 'thread/resume' || call.method === 'turn/start')).toBe(false)
    expect(probe.notifications).toEqual([])
    await scheduler.close()
    scheduler = make()
    expect((await (await fetch(base)).json()).data.thread.attemptId).toBe(saved.attemptId)
    now = 2000
    await scheduler.tick()
    const starts = calls.filter(call => call.method === 'turn/start')
    expect(starts).toHaveLength(1)
    expect(probe.notifications.filter(event => event.method === automaticResumeStartedMethod)).toEqual([
      { method: automaticResumeStartedMethod, params: expect.objectContaining({ threadId: 'thread', source: 'scheduled', turnId: 'own-turn' }) },
    ])
    expect(starts[0]!.params).toMatchObject({ model: 'historical', effort: 'ultra', input: [{ type: 'text', text: '继续之前的工作' }] })
    expect(calls.filter(call => call.method === 'thread/resume')).toHaveLength(1)
    expect(await scheduler.snapshot()).toEqual({})
    expect(JSON.parse(await readFile(join(home, 'codexapp-scheduled-resume.json'), 'utf8')).marks).toEqual({})
    await scheduler.close()
    scheduler = make()
    await scheduler.tick()
    expect((await (await fetch(base)).json()).data).toEqual({})
    expect(calls.filter(call => call.method === 'turn/start')).toHaveLength(1)
  } finally {
    await scheduler.close()
    await queue.dispose()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(home, { recursive: true, force: true })
  }
})

async function deliveryFixture() {
  const home = await mkdtemp(join(tmpdir(), 'sidux-schedule-delivery-'))
  const initialTime = Date.now()
  let now = initialTime
  let active = false
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const calls: Array<{ method: string; params: unknown }> = []
  const { runtime } = createBackendQueueRuntimeFixture({ rpc: async (method, params) => {
    calls.push({ method, params })
    if (method === 'thread/read') return { thread: { id: 'thread', model: 'model-a', status: { type: active ? 'inProgress' : 'notLoaded' } } }
    if (method === 'thread/turns/list') return { data: [{ id: 'own-turn', status: 'inProgress', items: [] }] }
    if (method === 'turn/start') return { turn: { id: 'own-turn' } }
    return {}
  } })
  const queue = new BackendQueueProcessor(runtime, {
    directory: join(home, 'delivery'), startRecovery: false,
    features: async () => ({ historyPaging: true, resumeInitialPage: true, exactFork: true }),
    context: async () => 'fixture-context',
  })
  queue.deliveryContext = async () => 'fixture-context'
  const make = () => new ThreadScheduledResume(home, createThreadScheduledResumeRuntime({ notifyScheduledResumeChanged: () => {} }, queue), () => now, false)
  let scheduler = make()
  const unsubscribe = runtime.onNotification(notification => scheduler.observe(notification))
  return {
    home, initialTime, calls, queue,
    choice: { model: 'model-a', effort: 'high', tier: '' },
    get scheduler() { return scheduler },
    setNow(value: number) { now = value },
    setActive(value: boolean) { active = value },
    async restart() {
      await scheduler.close()
      scheduler = make()
      await scheduler.ready
    },
    async cleanup() {
      unsubscribe()
      await scheduler.close()
      await queue.dispose()
      vi.restoreAllMocks()
      await rm(home, { recursive: true, force: true })
    },
  }
}

it('keeps a busy conversation queued and consumes its schedule when actual dispatch is accepted', async () => {
  const f = await deliveryFixture()
  try {
    f.setActive(true)
    await f.scheduler.set('thread', f.initialTime + 1000, f.choice)
    f.setNow(f.initialTime + 1000)
    await f.scheduler.tick()
    const attemptId = (await f.scheduler.snapshot()).thread!.attemptId
    expect(await f.queue.deliveries.result(attemptId)).toMatchObject({ status: 'queued' })
    expect(f.calls.filter(call => call.method === 'turn/start')).toHaveLength(0)
    await f.scheduler.tick()
    expect((await f.scheduler.snapshot()).thread?.attemptId).toBe(attemptId)
    f.setActive(false)
    await f.queue.deliveries.process('thread')
    expect(await f.queue.deliveries.result(attemptId)).toMatchObject({ status: 'accepted', turnId: 'own-turn' })
    await f.scheduler.tick()
    expect(await f.scheduler.snapshot()).toEqual({})
    expect(JSON.parse(await readFile(join(f.home, 'codexapp-scheduled-resume.json'), 'utf8')).marks).toEqual({})
    const reads = f.calls.length
    await f.scheduler.tick()
    expect(f.calls).toHaveLength(reads)
    expect(f.calls.filter(call => call.method === 'turn/start')).toHaveLength(1)
  } finally {
    await f.cleanup()
  }
})

it.each([false, true])('delivers an eight-day schedule once across restart (legacy ID: %s)', async legacy => {
  const f = await deliveryFixture()
  try {
    const at = f.initialTime + 8 * 86400_000
    await f.scheduler.set('thread', at, f.choice)
    await f.scheduler.close()
    if (legacy) {
      const path = join(f.home, 'codexapp-scheduled-resume.json')
      const saved = JSON.parse(await readFile(path, 'utf8'))
      saved.marks.thread.attemptId = `d-${f.initialTime}-legacy`
      await writeFile(path, JSON.stringify(saved))
    }
    await f.restart()
    f.setNow(at)
    const submit = vi.spyOn(f.queue, 'submit')
    await f.scheduler.tick()
    const attemptId = (submit.mock.calls[0]![0] as { message: { id: string } }).message.id
    expect(await f.scheduler.snapshot()).toEqual({})
    expect(attemptId).toMatch(new RegExp(`^d-${at}-`))
    expect(f.calls.filter(call => call.method === 'turn/start')).toHaveLength(1)
    expect(f.calls.find(call => call.method === 'turn/start')?.params).toMatchObject({
      model: 'model-a', effort: 'high', input: [{ type: 'text', text: '继续之前的工作' }],
    })
    await f.restart()
    await f.scheduler.tick()
    expect(await f.scheduler.snapshot()).toEqual({})
    expect(f.calls.filter(call => call.method === 'turn/start')).toHaveLength(1)
  } finally {
    await f.cleanup()
  }
})

it('retries a claimed schedule with its persisted ID after a disconnect before ledger creation', async () => {
  const f = await deliveryFixture()
  try {
    const submit = vi.spyOn(f.queue, 'submit').mockRejectedValueOnce(new Error('synthetic disconnect'))
    await f.scheduler.set('thread', f.initialTime + 1000, f.choice)
    f.setNow(f.initialTime + 1000)
    await f.scheduler.tick()
    const claimed = (await f.scheduler.snapshot()).thread!
    expect(claimed.status).toBe('unknown')
    expect(f.calls.filter(call => call.method === 'turn/start')).toHaveLength(0)
    await f.restart()
    await f.scheduler.tick()
    expect(submit).toHaveBeenCalledTimes(2)
    for (const index of [1, 2]) {
      expect(submit).toHaveBeenNthCalledWith(index, expect.objectContaining({
        message: expect.objectContaining({ id: claimed.attemptId }),
      }))
    }
    expect(await f.scheduler.snapshot()).toEqual({})
    expect(f.calls.filter(call => call.method === 'turn/start')).toHaveLength(1)
  } finally {
    await f.cleanup()
  }
})

it.each(['queued', 'editing', 'failed'] as const)('cancels a %s scheduled delivery so it cannot be resumed or sent', async status => {
  const f = await deliveryFixture()
  try {
    f.setActive(true)
    await f.scheduler.set('thread', f.initialTime + 1000, f.choice)
    f.setNow(f.initialTime + 1000)
    await f.scheduler.tick()
    const queued = (await f.queue.store.records())[0]!
    if (status === 'editing') await f.queue.store.edit(queued.message.id, queued.revision, 'test-editor')
    if (status === 'failed') await f.queue.store.failed(queued.message.id, queued.revision, 'synthetic pre-send failure')
    const pending = (await f.queue.store.records())[0]!
    expect(pending.status).toBe(status)
    await f.scheduler.set('thread', null)
    expect(await f.scheduler.snapshot()).toEqual({})
    expect(await f.queue.store.records()).toEqual([])
    expect(await f.queue.deliveries.result(pending.message.id)).toMatchObject({ status: 'cancelled' })
    await expect(f.queue.store.resume(pending.message.id, pending.revision)).rejects.toThrow('移除')
    f.setActive(false)
    await f.queue.deliveries.process('thread')
    expect(f.calls.filter(call => call.method === 'turn/start')).toHaveLength(0)
  } finally {
    await f.cleanup()
  }
})

it('keeps the schedule marker when concurrent editing invalidates the cancellation revision', async () => {
  const f = await deliveryFixture()
  try {
    f.setActive(true)
    await f.scheduler.set('thread', f.initialTime + 1000, f.choice)
    f.setNow(f.initialTime + 1000)
    await f.scheduler.tick()
    const remove = f.queue.store.remove.bind(f.queue.store)
    vi.spyOn(f.queue.store, 'remove').mockImplementationOnce(async (id, revision) => {
      await f.queue.store.edit(id, revision, 'concurrent-editor')
      return remove(id, revision)
    })
    await expect(f.scheduler.set('thread', null)).rejects.toThrow('状态已变化')
    expect((await f.scheduler.snapshot()).thread?.status).toBe('submitted')
    expect((await f.queue.store.records())[0]?.status).toBe('editing')
    await f.scheduler.set('thread', null)
    expect(await f.scheduler.snapshot()).toEqual({})
    expect(await f.queue.store.records()).toEqual([])
  } finally {
    await f.cleanup()
  }
})
