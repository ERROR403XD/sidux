import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThreadInterruption } from '../../threadInterruption.js'
import { readAnyJsonBody, setJson } from '../httpUtils.js'
import { IgnoredQuotaErrors } from '../ignoredQuotaErrors.js'
import { SidebarThreadStatusReader } from '../sidebarThreadStatusReader.js'
import { ThreadGoalReader } from '../threadGoalReader.js'
import { ThreadInterruptionList } from '../threadInterruptionList.js'
import { ThreadQuotaResume } from '../threadQuotaResume.js'
import { createThreadStatusService } from '../threadStatusService.js'
import { createThreadStatusRoutes } from './threadStatusRoutes.js'

let home: string
let server: Server
let baseUrl: string
let ignored: IgnoredQuotaErrors
let interruptions: ThreadInterruptionList
let quotaResume: ThreadQuotaResume
let notify: ReturnType<typeof vi.fn<(threadId: string) => void>>
let changed: ReturnType<typeof vi.fn<(threadId: string, issues: ThreadInterruption[]) => void>>
let rpc: ReturnType<typeof vi.fn<(method: string, params: any) => Promise<unknown>>>

function createQuotaResume() {
  return new ThreadQuotaResume(home, {
    inspect: async () => ({ active: false, turnId: 'turn-1', status: 'failed', error: 'quota' }),
    available: async () => false,
    submit: async () => { throw new Error('Fixture must not deliver') },
    cancel: async () => {},
    changed: () => {},
  }, false)
}

async function request(path: string, body?: unknown, method?: string) {
  const response = await fetch(`${baseUrl}/codex-api/${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as { data?: any; error?: string } }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'sidux-thread-status-'))
  ignored = new IgnoredQuotaErrors(home)
  changed = vi.fn()
  notify = vi.fn()
  interruptions = new ThreadInterruptionList(home, ignored, changed)
  quotaResume = createQuotaResume()
  rpc = vi.fn(async (method, params) => {
    if (method === 'thread/turns/list') return { data: [{ id: 'turn-1', status: 'failed', error: { message: 'quota' } }] }
    if (method === 'thread/goal/get') return { goal: {
      threadId: params.threadId, objective: 'fixture', status: 'active', tokensUsed: 0,
      timeUsedSeconds: 0, createdAt: 1, updatedAt: 1,
    } }
    throw new Error(`Unexpected fixture RPC: ${method}`)
  })
  const sidebarStatus = new SidebarThreadStatusReader(rpc, Date.now, 1000, (id, turn) => ignored.has(id, turn))
  const goals = new ThreadGoalReader(rpc)
  const route = createThreadStatusRoutes(createThreadStatusService({
    quotaResume, interruptions, ignoredErrors: ignored, sidebarStatus, goals, notifyErrorIgnored: notify,
  }))
  server = createServer((req, res) => {
    void route(req, res, new URL(req.url ?? '/', 'http://localhost'), { readJsonBody: readAnyJsonBody }).then(handled => {
      if (!handled) setJson(res, 404, { error: 'Unknown route' })
    }).catch(error => setJson(res, 500, { error: error.message }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing listener')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  vi.restoreAllMocks()
  await quotaResume.close()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await rm(home, { recursive: true, force: true })
})

describe('thread status routes with real readers and durable marks', () => {
  it('persists quota resume enable/disable and reads it after recreating the store', async () => {
    const enabled = await request('thread-quota-resume', { threadId: 'thread-1', enabled: true })
    expect(enabled).toEqual({ status: 200, body: { data: { 'thread-1': { status: 'waiting', blockedTurnId: 'turn-1', attemptId: null } } } })
    const saved = JSON.parse(await readFile(join(home, 'codexapp-quota-resume.json'), 'utf8'))
    expect(saved.marks).toEqual(enabled.body.data)
    const reloaded = createQuotaResume()
    try {
      expect(await reloaded.snapshot()).toEqual(enabled.body.data)
    } finally {
      await reloaded.close()
    }
    expect(await request('thread-quota-resume')).toEqual(enabled)
    expect(await request('thread-quota-resume', { threadId: 'thread-1', enabled: false })).toEqual({ status: 200, body: { data: {} } })
    expect(JSON.parse(await readFile(join(home, 'codexapp-quota-resume.json'), 'utf8')).marks).toEqual({})
  })

  it('acknowledges a durable interruption, then publishes and wakes exactly once', async () => {
    await interruptions.record('thread-1', { id: 'turn-1', status: 'failed', error: { message: 'quota' } })
    changed.mockClear()
    notify.mockImplementation(threadId => {
      expect(threadId).toBe('thread-1')
      expect(changed).toHaveBeenLastCalledWith('thread-1', [])
    })
    expect((await request('thread-interruptions')).body.data['thread-1']).toHaveLength(1)
    expect(await request('ignored-quota-errors', { threadId: 'thread-1', turnId: 'turn-1', ignored: true })).toEqual({ status: 200, body: { data: ['turn-1'] } })
    expect(JSON.parse(await readFile(join(home, 'ignored-quota-errors.json'), 'utf8'))).toEqual({ 'thread-1': ['turn-1'] })
    expect(changed).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(await request('thread-interruptions')).toEqual({ status: 200, body: { data: {} } })
    expect(await new IgnoredQuotaErrors(home).list('thread-1')).toEqual(['turn-1'])
    expect(await request('ignored-quota-errors?threadId=thread-1')).toEqual({ status: 200, body: { data: ['turn-1'] } })
    notify.mockReset()
    expect(await request('ignored-quota-errors', { threadId: 'thread-1', turnId: 'turn-1', ignored: false })).toEqual({ status: 200, body: { data: [] } })
    expect((await request('thread-interruptions')).body.data['thread-1']).toHaveLength(1)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('does not publish or wake when durable acknowledgement fails', async () => {
    await ignored.list('thread-1')
    await mkdir(join(home, 'ignored-quota-errors.json'))
    expect((await request('ignored-quota-errors', { threadId: 'thread-1', turnId: 'turn-1', ignored: true })).status).toBe(500)
    expect(await ignored.list('thread-1')).toEqual([])
    expect(changed).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    await rm(join(home, 'ignored-quota-errors.json'), { recursive: true })
    expect((await request('ignored-quota-errors', { threadId: 'thread-1', turnId: 'turn-1', ignored: true })).status).toBe(200)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('propagates publication failure after the mark is durable and before waking', async () => {
    vi.spyOn(interruptions, 'publish').mockRejectedValueOnce(new Error('fixture publish failure'))
    expect(await request('ignored-quota-errors', { threadId: 'thread-1', turnId: 'turn-1', ignored: true })).toEqual({ status: 500, body: { error: 'fixture publish failure' } })
    expect(await ignored.list('thread-1')).toEqual(['turn-1'])
    expect(notify).not.toHaveBeenCalled()
  })

  it('retains sidebar deduplication, version clipping, warm cache and ignored marks', async () => {
    const version = 'a'.repeat(80)
    expect(await request('sidebar-thread-status', { threadIds: ['thread-1', 'thread-1'], versions: { 'thread-1': `${version}one` } })).toEqual({ status: 200, body: { data: { 'thread-1': true } } })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('thread/turns/list', { threadId: 'thread-1', limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' })
    await request('sidebar-thread-status', { threadIds: ['thread-1'], versions: { 'thread-1': `${version}two` } })
    expect(rpc).toHaveBeenCalledTimes(1)
    await request('ignored-quota-errors', { threadId: 'thread-1', turnId: 'turn-1', ignored: true })
    expect(await request('sidebar-thread-status', { threadIds: ['thread-1'], versions: { 'thread-1': 'new-version' } })).toEqual({ status: 200, body: { data: { 'thread-1': false } } })
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('retains goal cache and refreshes only a requested member', async () => {
    const first = await request('thread-goals', { threadIds: ['thread-1', 'thread-1', 'thread-2'] })
    expect(first.status).toBe(200)
    expect(Object.keys(first.body.data)).toEqual(['thread-1', 'thread-2'])
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(await request('thread-goals', { threadIds: ['thread-1', 'thread-2'], refreshId: 'outside' })).toEqual(first)
    expect(rpc).toHaveBeenCalledTimes(2)
    await request('thread-goals', { threadIds: ['thread-1', 'thread-2'], refreshId: 'thread-2' })
    expect(rpc).toHaveBeenCalledTimes(3)
    expect(rpc).toHaveBeenLastCalledWith('thread/goal/get', { threadId: 'thread-2' })
  })

  it.each(['sidebar-thread-status', 'thread-goals'])('bounds %s RPC concurrency at four', async path => {
    let active = 0
    let peak = 0
    const original = rpc.getMockImplementation()!
    rpc.mockImplementation(async (method, params) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      const result = await original(method, params)
      active -= 1
      return result
    })
    const result = await request(path, { threadIds: Array.from({ length: 12 }, (_, index) => `thread-${index}`) })
    expect(result.status).toBe(200)
    expect(Object.keys(result.body.data)).toHaveLength(12)
    expect(rpc).toHaveBeenCalledTimes(12)
    expect(peak).toBe(4)
  })

  it('rejects invalid batches and mark inputs without side effects', async () => {
    for (const path of ['sidebar-thread-status', 'thread-goals']) {
      for (const body of [null, { threadIds: [null] }, { threadIds: [''] }, { threadIds: Array(101).fill('thread-1') }]) {
        expect((await request(path, body)).status).toBe(400)
      }
    }
    expect(await request('thread-quota-resume', { threadId: 'thread-1', enabled: 'yes' })).toEqual({ status: 400, body: { error: '续跑标记参数无效' } })
    expect(await request('ignored-quota-errors', { threadId: '../invalid', turnId: 'turn-1', ignored: true })).toEqual({ status: 400, body: { error: '忽略标记参数无效' } })
    expect((await request('ignored-quota-errors', { threadId: 'thread-1', turnId: '', ignored: true })).status).toBe(400)
    expect((await request('thread-goals', undefined, 'PUT')).status).toBe(404)
    expect(rpc).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(await quotaResume.snapshot()).toEqual({})
    expect(await ignored.list('thread-1')).toEqual([])
  })
})
