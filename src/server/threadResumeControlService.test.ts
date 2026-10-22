import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { readAnyJsonBody, setJson } from './httpUtils.js'
import { ThreadQuotaResume } from './threadQuotaResume.js'
import { ThreadScheduledResume } from './threadScheduledResume.js'
import { createThreadResumeControlService } from './threadResumeControlService.js'
import { createThreadStatusService } from './threadStatusService.js'
import { createThreadStatusRoutes } from './routes/threadStatusRoutes.js'
import { createThreadScheduledResumeRoutes } from './routes/threadScheduledResumeRoutes.js'

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'sidux-resume-mode-'))
  let now = 1000
  const quotaRuntime = {
    inspect: vi.fn(async () => ({ active: false, turnId: 'prior', status: 'failed', error: 'quota' })),
    available: async () => false,
    submit: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    changed: () => {},
  }
  const scheduledRuntime = {
    prepare: vi.fn(async () => ({ choice: { model: 'fixture-model', effort: 'high', tier: '' }, contextId: 'fixture' })),
    submit: vi.fn(async (): Promise<'submitted' | 'started'> => 'started'),
    inspect: vi.fn(async () => ({ status: 'started' as const })),
    cancel: vi.fn(async () => {}),
    changed: () => {},
  }
  let quotaResume = new ThreadQuotaResume(home, quotaRuntime, false)
  let scheduledResume = new ThreadScheduledResume(home, scheduledRuntime, () => now, false)
  let controls = createThreadResumeControlService(quotaResume, scheduledResume)
  let bodyRead: (() => void) | undefined
  const server = createServer((req, res) => {
    const context = { readJsonBody: async (request: typeof req) => {
      const body = await readAnyJsonBody(request)
      const observed = bodyRead
      bodyRead = undefined
      observed?.()
      return body
    } }
    const url = new URL(req.url!, 'http://localhost')
    const statusRoutes = createThreadStatusRoutes(createThreadStatusService({
      quotaResume: controls.quotaResume,
      interruptions: {} as never,
      ignoredErrors: {} as never,
      sidebarStatus: {} as never,
      goals: {} as never,
      notifyErrorIgnored: () => {},
    }))
    void (async () => {
      if (await createThreadScheduledResumeRoutes(controls.scheduledResume)(req, res, url, context)) return
      if (await statusRoutes(req, res, url, context)) return
      setJson(res, 404, { error: 'Unknown route' })
    })().catch(() => setJson(res, 500, { error: 'Unexpected fixture failure' }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  async function post(mode: 'quota' | 'scheduled', enabled: boolean, threadId = 'thread') {
    const body = mode === 'quota' ? { threadId, enabled } : { threadId, at: enabled ? 2000 : null }
    const response = await fetch(`${base}/codex-api/thread-${mode === 'quota' ? 'quota' : 'scheduled'}-resume`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }
  return {
    home, post, quotaRuntime, scheduledRuntime,
    nextBody: () => new Promise<void>(resolve => { bodyRead = resolve }),
    quota: () => quotaResume,
    scheduled: () => scheduledResume,
    advance: () => { now = 2000 },
    restart: async () => {
      await Promise.all([quotaResume.close(), scheduledResume.close()])
      quotaResume = new ThreadQuotaResume(home, quotaRuntime, false)
      scheduledResume = new ThreadScheduledResume(home, scheduledRuntime, () => now, false)
      controls = createThreadResumeControlService(quotaResume, scheduledResume)
    },
    close: async () => {
      await Promise.all([quotaResume.close(), scheduledResume.close()])
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(home, { recursive: true, force: true })
    },
  }
}

it.each(['quota', 'scheduled'] as const)('rejects the opposite HTTP mode after %s persists, including restart, then permits switching after cancellation', async mode => {
  const f = await fixture()
  const opposite = mode === 'quota' ? 'scheduled' : 'quota'
  try {
    expect((await f.post(mode, true)).status).toBe(200)
    expect((await f.post(opposite, true)).status).toBe(409)
    await f.restart()
    expect((await f.post(opposite, true)).status).toBe(409)
    expect((await f.post(mode, false)).status).toBe(200)
    expect((await f.post(opposite, true)).status).toBe(200)
    expect(await f.quota().has('thread')).toBe(opposite === 'quota')
    expect(await f.scheduled().has('thread')).toBe(opposite === 'scheduled')
    const quotaFile = JSON.parse(await readFile(join(f.home, 'codexapp-quota-resume.json'), 'utf8'))
    const scheduleFile = JSON.parse(await readFile(join(f.home, 'codexapp-scheduled-resume.json'), 'utf8'))
    expect(Boolean(quotaFile.marks.thread && scheduleFile.marks.thread)).toBe(false)
  } finally {
    await f.close()
  }
})

it.each(['quota', 'scheduled'] as const)('serializes concurrent opposite HTTP settings while %s is awaiting native preparation', async mode => {
  const f = await fixture()
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const preparing = new Promise<void>(resolve => { entered = resolve })
  if (mode === 'quota') {
    f.quotaRuntime.inspect.mockImplementationOnce(async () => {
      entered()
      await waiting
      return { active: false, turnId: 'prior', status: 'failed', error: 'quota' }
    })
  } else {
    f.scheduledRuntime.prepare.mockImplementationOnce(async () => {
      entered()
      await waiting
      return { choice: { model: 'fixture-model', effort: 'high', tier: '' }, contextId: 'fixture' }
    })
  }
  try {
    const first = f.post(mode, true)
    await preparing
    const opposite = mode === 'quota' ? 'scheduled' : 'quota'
    const arrived = f.nextBody()
    const second = f.post(opposite, true)
    await arrived
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(f.quotaRuntime.inspect).toHaveBeenCalledTimes(mode === 'quota' ? 1 : 0)
    expect(f.scheduledRuntime.prepare).toHaveBeenCalledTimes(mode === 'scheduled' ? 1 : 0)
    release()
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(409)
    expect(await f.quota().has('thread')).toBe(mode === 'quota')
    expect(await f.scheduled().has('thread')).toBe(mode === 'scheduled')
    expect(f.quotaRuntime.inspect).toHaveBeenCalledTimes(mode === 'quota' ? 1 : 0)
    expect(f.scheduledRuntime.prepare).toHaveBeenCalledTimes(mode === 'scheduled' ? 1 : 0)
  } finally {
    release()
    await f.close()
  }
})

it('does not block a different conversation behind a pending mode change', async () => {
  const f = await fixture()
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const preparing = new Promise<void>(resolve => { entered = resolve })
  f.quotaRuntime.inspect.mockImplementationOnce(async () => {
    entered()
    await waiting
    return { active: false, turnId: 'prior', status: 'failed', error: 'quota' }
  })
  try {
    const first = f.post('quota', true, 'thread-a')
    await preparing
    expect((await f.post('scheduled', true, 'thread-b')).status).toBe(200)
    release()
    expect((await first).status).toBe(200)
  } finally {
    release()
    await f.close()
  }
})

it('permits quota mode as soon as the scheduled delivery starts and removes its mark', async () => {
  const f = await fixture()
  try {
    await f.post('scheduled', true)
    f.advance()
    await f.scheduled().tick()
    expect(await f.scheduled().snapshot()).toEqual({})
    expect((await f.post('quota', true)).status).toBe(200)
    expect(f.scheduledRuntime.submit).toHaveBeenCalledTimes(1)
    expect(f.quotaRuntime.submit).not.toHaveBeenCalled()
  } finally {
    await f.close()
  }
})

it('keeps both cancellation paths available for legacy overlapping marks', async () => {
  const f = await fixture()
  try {
    await f.quota().set('thread', true)
    await f.scheduled().set('thread', 2000)
    await f.restart()
    expect((await f.post('scheduled', false)).status).toBe(200)
    expect((await f.post('quota', false)).status).toBe(200)
    expect(await f.quota().snapshot()).toEqual({})
    expect(await f.scheduled().snapshot()).toEqual({})
  } finally {
    await f.close()
  }
})
