import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ThreadScheduledResume } from './threadScheduledResume'
import type { ScheduledResumeMark } from '../threadScheduledResume'
import { automaticResumeStartedMethod } from '../threadAutomaticResume'

const homes: string[] = []
const services: ThreadScheduledResume[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()))
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'sidux-scheduled-'))
  homes.push(home)
  let now = 1000
  const choice = { model: 'model-a', effort: 'high', tier: 'priority' }
  const runtime = {
    prepare: vi.fn(async () => ({ choice, contextId: 'fixture-context' })),
    submit: vi.fn(async (_threadId: string, _mark: ScheduledResumeMark): Promise<'submitted' | 'started'> => 'submitted'),
    inspect: vi.fn(async (_threadId: string, _mark: ScheduledResumeMark) => ({ status: 'submitted' as const, turnId: 'own-turn' })),
    cancel: vi.fn(async () => {}), changed: vi.fn(),
  }
  const create = () => {
    const service = new ThreadScheduledResume(home, runtime, () => now, false)
    services.push(service)
    return service
  }
  return { home, runtime, choice, create, setNow: (value: number) => { now = value } }
}

it('consumes the persisted schedule immediately when submission confirms startup', async () => {
  const f = await fixture()
  const service = f.create()
  await service.set('thread', 2000, f.choice)
  f.runtime.submit.mockResolvedValueOnce('started')
  f.setNow(2000)
  await service.tick()
  expect(await service.snapshot()).toEqual({})
  expect(JSON.parse(await readFile(join(f.home, 'codexapp-scheduled-resume.json'), 'utf8')).marks).toEqual({})
  expect(f.runtime.inspect).not.toHaveBeenCalled()
})

it('wakes only for this schedule delivery and never consumes a future replacement from stale events', async () => {
  const f = await fixture()
  const service = f.create()
  await service.set('thread', 2000)
  f.setNow(2000)
  await service.tick()
  const mark = (await service.snapshot()).thread!
  f.runtime.inspect.mockResolvedValue({ status: 'failed', error: 'unconfirmed' } as never)
  await service.tick()
  f.runtime.inspect.mockClear()
  const unrelated = [
    { method: automaticResumeStartedMethod, params: { threadId: 'thread', deliveryId: mark.attemptId, source: 'quota' } },
    { method: automaticResumeStartedMethod, params: { threadId: 'other', deliveryId: mark.attemptId, source: 'scheduled' } },
    { method: automaticResumeStartedMethod, params: { threadId: 'thread', deliveryId: 'old-attempt', source: 'scheduled' } },
    { method: 'turn/started', params: { threadId: 'thread', turn: { id: 'unrelated' } } },
    { method: 'thread/goal/updated', params: { threadId: 'thread', goal: { status: 'active' } } },
    { method: automaticResumeStartedMethod, params: null },
  ]
  for (const event of unrelated) service.observe(event)
  await service.tick()
  expect(f.runtime.inspect).not.toHaveBeenCalled()
  expect((await service.snapshot()).thread?.status).toBe('failed')
  service.observe({ method: automaticResumeStartedMethod, params: { threadId: 'thread', deliveryId: mark.attemptId, source: 'scheduled' } })
  f.runtime.inspect.mockResolvedValueOnce({ status: 'started' } as never)
  await service.tick()
  expect(await service.snapshot()).toEqual({})
  await service.set('thread', 3000)
  service.observe({ method: automaticResumeStartedMethod, params: { threadId: 'thread', deliveryId: mark.attemptId, source: 'scheduled' } })
  await service.tick()
  expect((await service.snapshot()).thread).toMatchObject({ status: 'scheduled', attemptId: '', at: 3000 })
  expect(f.runtime.inspect).toHaveBeenCalledTimes(1)
  expect(f.runtime.submit).toHaveBeenCalledTimes(1)
})

it('does not classify a cleanup storage failure as an unconfirmed submission or dispatch again', async () => {
  const f = await fixture()
  const service = f.create()
  await service.set('thread', 2000)
  f.runtime.submit.mockImplementationOnce(async () => {
    const path = join(f.home, 'codexapp-scheduled-resume.json')
    await rm(path)
    await mkdir(path)
    return 'started'
  })
  f.setNow(2000)
  await expect(service.tick()).rejects.toThrow()
  await expect(service.snapshot()).rejects.toThrow('保存失败')
  await expect(service.tick()).rejects.toThrow('保存失败')
  expect(f.runtime.submit).toHaveBeenCalledTimes(1)
})

it('stops timers and inspection after consuming the last schedule', async () => {
  const f = await fixture()
  vi.useFakeTimers()
  let now = 1000
  const service = new ThreadScheduledResume(f.home, f.runtime, () => now, true)
  services.push(service)
  try {
    await service.set('thread', 2000)
    f.runtime.submit.mockResolvedValueOnce('started')
    now = 2000
    await service.tick()
    expect(await service.snapshot()).toEqual({})
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.runtime.inspect).not.toHaveBeenCalled()
    expect(f.runtime.submit).toHaveBeenCalledTimes(1)
  } finally {
    await service.close()
    vi.useRealTimers()
  }
})

it('durably claims once at the deadline and keeps queued intent until its own delivery starts', async () => {
  const f = await fixture()
  const service = f.create()
  await service.set('thread', 2000, f.choice)
  const mark = (await service.snapshot()).thread!
  expect(mark.choice).toEqual(f.choice)
  expect(mark.attemptId).toBe('')
  f.runtime.submit.mockImplementationOnce(async (_threadId, claimed) => {
    const saved = JSON.parse(await readFile(join(f.home, 'codexapp-scheduled-resume.json'), 'utf8'))
    expect(saved.marks.thread).toEqual(claimed)
    return 'submitted'
  })
  await service.tick()
  expect(f.runtime.submit).not.toHaveBeenCalled()
  f.setNow(2000)
  await Promise.all([service.tick(), service.tick()])
  const claimed = (await service.snapshot()).thread!
  expect(claimed.attemptId).toMatch(/^d-\d{13}-/)
  expect(f.runtime.submit).toHaveBeenCalledExactlyOnceWith('thread', expect.objectContaining({ attemptId: claimed.attemptId, choice: f.choice }))
  expect(JSON.parse(await readFile(join(f.home, 'codexapp-scheduled-resume.json'), 'utf8')).marks.thread.status).toBe('submitted')
  await service.tick()
  expect((await service.snapshot()).thread?.turnId).toBe('own-turn')
  f.runtime.inspect.mockResolvedValueOnce({ status: 'started', turnId: 'own-turn' } as never)
  await service.tick()
  expect(await service.snapshot()).toEqual({})
  expect(f.runtime.submit).toHaveBeenCalledTimes(1)
})

it('persists future intent over restart and reconciles a submitted attempt without a second dispatch', async () => {
  const f = await fixture()
  const first = f.create()
  await first.set('thread', 2000)
  await first.close()
  const second = f.create()
  expect((await second.snapshot()).thread?.status).toBe('scheduled')
  f.setNow(3000)
  await second.tick()
  const attemptId = (await second.snapshot()).thread!.attemptId
  await second.close()
  const third = f.create()
  expect((await third.snapshot()).thread?.status).toBe('unknown')
  await third.tick()
  expect((await third.snapshot()).thread?.status).toBe('submitted')
  expect((await third.snapshot()).thread?.attemptId).toBe(attemptId)
  expect(f.runtime.submit).toHaveBeenCalledTimes(1)
})

it('cancels/replaces future intent and preserves uncertain outcomes for explicit review', async () => {
  const f = await fixture()
  const service = f.create()
  await expect(service.set('thread', 1000)).rejects.toThrow('未来')
  await service.set('thread', 2000)
  await service.set('thread', null)
  expect(f.runtime.cancel).not.toHaveBeenCalled()
  f.setNow(5000)
  await service.tick()
  expect(f.runtime.submit).not.toHaveBeenCalled()
  await service.set('thread', 6000)
  f.runtime.submit.mockRejectedValueOnce(new Error('synthetic disconnect'))
  f.setNow(6000)
  await service.tick()
  expect((await service.snapshot()).thread).toMatchObject({ status: 'unknown', error: 'synthetic disconnect' })
  await expect(service.set('thread', 7000)).rejects.toThrow('核对')
})

it('fails closed on corrupt storage and ignores future work after stop', async () => {
  const f = await fixture()
  await writeFile(join(f.home, 'codexapp-scheduled-resume.json'), 'invalid')
  const service = f.create()
  await expect(service.snapshot()).rejects.toThrow()
  await expect(service.tick()).rejects.toThrow()
  await service.close()
  await service.tick()
  expect(f.runtime.submit).not.toHaveBeenCalled()
})

it('rejects a claimed schedule without its delivery identity instead of dispatching a new one', async () => {
  const f = await fixture()
  const first = f.create()
  await first.set('thread', 2000)
  const marks = await first.snapshot()
  await first.close()
  marks.thread!.status = 'submitted'
  await writeFile(join(f.home, 'codexapp-scheduled-resume.json'), JSON.stringify({ version: 1, marks }))
  const restored = f.create()
  await expect(restored.snapshot()).rejects.toThrow('格式无效')
  expect(f.runtime.submit).not.toHaveBeenCalled()
})

it('pauses deadline dispatch throughout a runtime handoff and resumes preserved intent', async () => {
  const f = await fixture()
  const service = f.create()
  await service.set('thread', 2000)
  await service.drain()
  f.setNow(3000)
  await service.tick()
  expect(f.runtime.submit).not.toHaveBeenCalled()
  expect((await service.snapshot()).thread?.status).toBe('scheduled')
  await expect(service.set('another', 4000)).rejects.toThrow('交接')
  await service.drain(false)
  await service.tick()
  expect(f.runtime.submit).toHaveBeenCalledTimes(1)
})

it('does not open shared storage until the previous runtime has stopped', async () => {
  const f = await fixture()
  let stopped!: () => void
  const previous = new Promise<void>(resolve => { stopped = resolve })
  const service = new ThreadScheduledResume(f.home, f.runtime, () => 1000, false, previous)
  services.push(service)
  let ready = false
  void service.ready.then(() => { ready = true })
  await Promise.resolve()
  expect(ready).toBe(false)
  stopped()
  expect(await service.snapshot()).toEqual({})
  expect(ready).toBe(true)
})

it('does not lose a startup wakeup received while submission is still running', async () => {
  const f = await fixture()
  let now = 1000
  const service = new ThreadScheduledResume(f.home, f.runtime, () => now, true)
  services.push(service)
  await service.set('thread', 2000)
  f.runtime.submit.mockImplementationOnce(async (_threadId, mark) => {
    service.observe({ method: automaticResumeStartedMethod, params: { threadId: 'thread', deliveryId: mark.attemptId, source: 'scheduled' } })
    return 'submitted'
  })
  f.runtime.inspect.mockResolvedValue({ status: 'started', turnId: 'own-turn' } as never)
  now = 2000
  await service.tick()
  await vi.waitFor(async () => expect(await service.snapshot()).toEqual({}), { timeout: 1000, interval: 10 })
})

it('rechecks recovered failures in bounded batches without polling or submitting them again', async () => {
  const f = await fixture()
  const marks = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`thread-${index}`, {
    at: 1000, status: 'failed', attemptId: `attempt-${index}`, choice: f.choice, contextId: 'fixture-context', error: 'interrupted',
  }]))
  await writeFile(join(f.home, 'codexapp-scheduled-resume.json'), JSON.stringify({ version: 1, marks }))
  f.runtime.inspect.mockResolvedValue({ status: 'failed', error: 'interrupted' } as never)
  const service = f.create()
  for (const expected of [4, 8, 9, 9]) {
    await service.tick()
    expect(f.runtime.inspect).toHaveBeenCalledTimes(expected)
  }
  expect(new Set(f.runtime.inspect.mock.calls.map(([threadId]) => threadId)).size).toBe(9)
  for (let index = 0; index < 20; index++) {
    service.observe({ method: automaticResumeStartedMethod, params: { threadId: 'thread-6', deliveryId: 'attempt-6', source: 'scheduled' } })
  }
  f.runtime.inspect.mockResolvedValue({ status: 'started' } as never)
  await service.tick()
  expect(f.runtime.inspect).toHaveBeenCalledTimes(10)
  expect(f.runtime.inspect).toHaveBeenLastCalledWith('thread-6', expect.objectContaining({ status: 'failed' }))
  expect((await service.snapshot())['thread-6']).toBeUndefined()
  expect(Object.keys(await service.snapshot())).toHaveLength(8)
  expect(f.runtime.submit).not.toHaveBeenCalled()
})

it('keeps the startup wakeup when an in-flight inspection first reports failure', async () => {
  const f = await fixture()
  let now = 1000
  const service = new ThreadScheduledResume(f.home, f.runtime, () => now, true)
  services.push(service)
  await service.set('thread', 2000, f.choice)
  now = 2000
  await service.tick()
  f.runtime.inspect.mockImplementationOnce(async (_threadId, mark) => {
    service.observe({ method: automaticResumeStartedMethod, params: { threadId: 'thread', deliveryId: mark.attemptId, source: 'scheduled' } })
    return { status: 'failed', error: 'stale paused state' } as never
  })
  f.runtime.inspect.mockResolvedValue({ status: 'started' } as never)
  await service.tick()
  await vi.waitFor(async () => expect(await service.snapshot()).toEqual({}), { timeout: 1000, interval: 10 })
  expect(f.runtime.submit).toHaveBeenCalledTimes(1)
})

it('replaces a recovered failure with a future deadline without leaving an immediate inspection timer', async () => {
  const f = await fixture()
  await writeFile(join(f.home, 'codexapp-scheduled-resume.json'), JSON.stringify({ version: 1, marks: {
    thread: { at: 1000, status: 'failed', attemptId: 'old-attempt', choice: f.choice, contextId: 'fixture-context' },
  } }))
  vi.useFakeTimers()
  const timeout = vi.spyOn(globalThis, 'setTimeout')
  const service = new ThreadScheduledResume(f.home, f.runtime, () => 1000, true)
  services.push(service)
  try {
    await service.ready
    await service.set('thread', 20_000, f.choice)
    expect(timeout.mock.calls.at(-1)?.[1]).toBe(19_000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.runtime.inspect).not.toHaveBeenCalled()
    expect(f.runtime.submit).not.toHaveBeenCalled()
    expect((await service.snapshot()).thread).toMatchObject({ status: 'scheduled', attemptId: '', at: 20_000 })
  } finally {
    await service.close()
    timeout.mockRestore()
    vi.useRealTimers()
  }
})
