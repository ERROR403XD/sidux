import { EventEmitter } from 'node:events'
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppServerProcess } from '../appServerProcess.js'
import { createNotificationService, type BridgeNotification } from '../notificationService.js'
import { createNotificationRoutes } from './notificationRoutes.js'

type Dependencies = Parameters<typeof createNotificationService>[0]

function fixture(runtime?: Dependencies['runtime'], goals?: Dependencies['goals']) {
  const appListeners = new Set<Parameters<Dependencies['runtime']['onNotification']>[0]>()
  const terminalListeners = new Set<Parameters<Dependencies['terminals']['subscribe']>[0]>()
  const automationListeners = new Set<() => void>()
  const releases: string[] = []
  const service = createNotificationService({
    goals,
    runtime: runtime ?? { onNotification: listener => {
      appListeners.add(listener)
      return () => { releases.push('runtime'); appListeners.delete(listener) }
    } },
    terminals: { subscribe: listener => {
      terminalListeners.add(listener)
      return () => { releases.push('terminal'); terminalListeners.delete(listener) }
    } },
    automations: { subscribe: listener => {
      automationListeners.add(listener)
      return () => { releases.push('automation'); automationListeners.delete(listener) }
    } },
  })
  return { service, appListeners, terminalListeners, automationListeners, releases }
}

afterEach(() => vi.useRealTimers())

describe('notification operation and SSE connection ownership', () => {
  it('adds cached GOAL status for reconnected clients without mutating or delaying runtime events', () => {
    let goalStatus: 'active' | 'complete' | null | undefined = 'active'
    const peekStatus = vi.fn(() => goalStatus)
    const f = fixture(undefined, { peekStatus })
    const first: BridgeNotification[] = []
    const unsubscribe = f.service.subscribe(notification => first.push(notification))
    const stage = { method: 'turn/completed', params: { threadId: 'goal', turn: { id: 'stage', status: 'completed' } } }
    const emit = (notification: { method: string; params: unknown }) => { for (const listener of f.appListeners) listener(notification) }
    emit(stage)
    emit({ method: 'turn/started', params: { threadId: 'goal', turn: { id: 'next' } } })
    expect(first[0]?.params).toEqual({ ...stage.params, goalStatus: 'active' })
    expect(first.map(row => row.method)).toEqual(['turn/completed', 'turn/started'])
    expect(stage.params).not.toHaveProperty('goalStatus')
    expect(peekStatus).toHaveBeenCalledExactlyOnceWith('goal')
    unsubscribe()
    const afterRefresh: BridgeNotification[] = []
    f.service.subscribe(notification => afterRefresh.push(notification))
    emit(stage)
    goalStatus = 'complete'
    emit(stage)
    goalStatus = null
    emit(stage)
    goalStatus = undefined
    emit(stage)
    expect(afterRefresh.map(row => (row.params as Record<string, unknown>).goalStatus)).toEqual(['active', 'complete', null, undefined])
    expect((first[0]?.params as Record<string, unknown>).goalStatus).toBe('active')
  })

  it('maps all three sources once and releases them in the original order', () => {
    const f = fixture()
    const notifications: BridgeNotification[] = []
    const unsubscribe = f.service.subscribe(notification => notifications.push(notification))
    for (const listener of f.appListeners) listener({ method: 'turn/completed', params: { turnId: 't' } })
    for (const listener of f.terminalListeners) listener({ method: 'terminal/output', params: { terminalId: 'p', data: 'output' } })
    for (const listener of f.automationListeners) listener()
    expect(notifications.map(({ method, params }) => ({ method, params }))).toEqual([
      { method: 'turn/completed', params: { turnId: 't' } },
      { method: 'terminal/output', params: { terminalId: 'p', data: 'output' } },
      { method: 'automation/changed', params: null },
    ])
    expect(notifications.every(row => !Number.isNaN(Date.parse(row.atIso)))).toBe(true)
    unsubscribe()
    expect(f.releases).toEqual(['automation', 'runtime', 'terminal'])
    expect(f.appListeners.size + f.terminalListeners.size + f.automationListeners.size).toBe(0)
  })

  it.each(['close', 'aborted'])('owns one 15-second keepalive and releases all resources on %s', async event => {
    vi.useFakeTimers()
    const f = fixture()
    const route = createNotificationRoutes(f.service)
    const req = new EventEmitter() as IncomingMessage
    req.method = 'GET'
    const chunks: string[] = []
    const headers: Record<string, string> = {}
    const response = {
      statusCode: 0, writableEnded: false, destroyed: false,
      setHeader: (key: string, value: string) => { headers[key] = value },
      write: (chunk: string) => { chunks.push(chunk) },
      end() { response.writableEnded = true },
    }
    const res = response as unknown as ServerResponse
    expect(await route(req, res, new URL('http://fixture/codex-api/events'))).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(headers).toMatchObject({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' })
    expect(chunks).toEqual(['event: ready\ndata: {"ok":true}\n\n'])
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(14999)
    expect(chunks).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(chunks.at(-1)).toBe(': ping\n\n')
    for (const listener of f.appListeners) listener({ method: 'changed', params: { marker: true } })
    expect(chunks.at(-1)).toContain('"marker":true')
    res.destroyed = true
    const before = chunks.length
    for (const listener of f.appListeners) listener({ method: 'changed', params: null })
    expect(chunks).toHaveLength(before)
    req.emit(event)
    expect(res.writableEnded).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(f.appListeners.size + f.terminalListeners.size + f.automationListeners.size).toBe(0)
    await vi.advanceTimersByTimeAsync(30000)
    expect(chunks).toHaveLength(before)
  })

  it('streams real runtime notifications over HTTP and releases each disconnected client', async () => {
    const runtime = new AppServerProcess({ isolatedTask: true })
    const f = fixture(runtime)
    const route = createNotificationRoutes(f.service)
    const server = createServer((req, res) => {
      void route(req, res, new URL(req.url ?? '/', 'http://localhost')).then(handled => {
        if (!handled) { res.statusCode = 404; res.end() }
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing listener')
    const base = `http://127.0.0.1:${address.port}`
    try {
      expect((await fetch(`${base}/codex-api/events`, { method: 'POST' })).status).toBe(404)
      for (let index = 0; index < 10; index++) {
        let responseBody = ''
        const client = request(`${base}/codex-api/events`, response => {
          response.setEncoding('utf8')
          response.on('data', chunk => { responseBody += chunk })
        })
        client.on('error', () => {})
        client.end()
        await vi.waitFor(() => expect(responseBody).toContain('event: ready'))
        runtime.notifyQuotaErrorIgnored(`thread-${index}`)
        await vi.waitFor(() => expect(responseBody).toContain(`"threadId":"thread-${index}"`))
        expect(responseBody.match(/thread\/quotaErrorIgnored\/changed/g)).toHaveLength(1)
        client.destroy()
        await vi.waitFor(() => expect(f.terminalListeners.size + f.automationListeners.size).toBe(0))
        const before = responseBody
        runtime.notifyQuotaErrorIgnored('after-close')
        expect(responseBody).toBe(before)
      }
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await runtime.dispose()
    }
  })
})
