import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { hasUsableCodexAuth } from '../appServerAuth.js'
import { AppServerProcess } from '../appServerProcess.js'
import { callRpcWithArchiveRecovery, failBridgeRequest, mergeImportedThreadsIntoThreadListResult } from '../codexAppServerBridge.js'
import { DirectoryPluginCache } from '../directoryPluginCache.js'
import { readAnyJsonBody, setJson } from '../httpUtils.js'
import { createRpcService } from '../rpcService.js'
import { ThreadCompactionGate } from '../threadCompactionGate.js'
import { ThreadHistory } from '../threadHistory.js'
import { createRpcRoutes } from './rpcRoutes.js'

let home: string
let server: Server
let base: string
let runtime: AppServerProcess
let plugins: DirectoryPluginCache
let history: ThreadHistory
let rpc: MockInstance
let thread: any
let recordRequest: ReturnType<typeof vi.fn<(payload: unknown) => void>>
let invalidateDirectory: ReturnType<typeof vi.fn<() => void>>
let invalidateSearch: ReturnType<typeof vi.fn<(threadId: string) => void>>
let mergeImported: ReturnType<typeof vi.fn<typeof mergeImportedThreadsIntoThreadListResult>>

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'sidux-rpc-route-'))
  vi.stubEnv('CODEX_HOME', home)
  const path = join(home, 'session.jsonl')
  await writeFile(path, '')
  thread = { id: 'thread-a', path, historyMode: 'legacy', status: { type: 'idle' }, turns: [] }
  runtime = new AppServerProcess({ isolatedTask: true })
  rpc = vi.spyOn(runtime, 'rpc').mockImplementation(async (method, params: any) => {
    if (method === 'thread/read' || method === 'thread/resume' || method === 'thread/fork') return { thread: structuredClone(thread) }
    if (method === 'thread/turns/list') return { data: [...thread.turns].reverse().slice(0, params.limit), nextCursor: 'opaque/+' }
    if (method === 'plugin/list') return { marketplaces: [{ name: 'fixture', plugins: [] }] }
    if (method === 'thread/list') return { data: [{ id: 'thread-a', cwd: home }], nextCursor: null }
    return { ok: true }
  })
  const recoveredRpc = (method: string, params: unknown) => callRpcWithArchiveRecovery(runtime, method, params)
  history = new ThreadHistory(recoveredRpc, async () => ({ historyPaging: true, resumeInitialPage: true, exactFork: true }))
  plugins = new DirectoryPluginCache(join(home, 'plugin-cache'), params => runtime.rpc('plugin/list', params), Date.now, false)
  invalidateDirectory = vi.fn()
  invalidateSearch = vi.fn()
  recordRequest = vi.fn()
  mergeImported = vi.fn(mergeImportedThreadsIntoThreadListResult)
  const route = createRpcRoutes(createRpcService({
    runtime, history, plugins, compaction: new ThreadCompactionGate(recoveredRpc),
    recoveredRpc, mergeImportedThreads: mergeImported,
    hasUsableAuth: hasUsableCodexAuth, invalidateDirectory, invalidateSearch,
  }))
  server = createServer((req, res) => {
    void route(req, res, new URL(req.url ?? '/', 'http://localhost'), { readJsonBody: readAnyJsonBody, recordRpcRequest: recordRequest })
      .then(handled => { if (!handled) setJson(res, 404, { error: 'Unknown route' }) })
      .catch(error => failBridgeRequest(res, error))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing listener')
  base = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  plugins.dispose()
  history.clear()
  await runtime.dispose()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

async function post(payload: unknown) {
  const response = await fetch(`${base}/codex-api/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  return { status: response.status, body: await response.json() as any }
}

describe('RPC HTTP with real history/cache/runtime projection', () => {
  it('marks manual stops before a terminal event and keeps the native interrupt payload unchanged', async () => {
    const notifications: Array<{ method: string; params: unknown }> = []
    const unsubscribe = runtime.onNotification(notification => notifications.push(notification))
    const emit = (notification: { method: string; params: unknown }) => (runtime as unknown as { emitNotification: (notification: unknown) => void }).emitNotification(notification)
    rpc.mockImplementationOnce(async () => {
      emit({ method: 'turn/completed', params: { threadId: 'thread-a', turn: { id: 'turn-a', status: 'interrupted', error: { message: 'quota exceeded' } } } })
      return {}
    })
    try {
      expect((await post({ method: 'turn/interrupt', params: { threadId: 'thread-a', turnId: 'turn-a' } })).status).toBe(200)
      expect(rpc).toHaveBeenCalledExactlyOnceWith('turn/interrupt', { threadId: 'thread-a', turnId: 'turn-a' })
      emit({ method: 'turn/cancelled', params: { threadId: 'thread-a', turnId: 'turn-a' } })
      emit({ method: 'turn/cancelled', params: { threadId: 'other-thread', turnId: 'turn-a' } })
      emit({ method: 'turn/cancelled', params: { threadId: 'thread-a', turnId: 'next' } })
      expect(notifications.slice(0, 2).map(notification => (notification.params as any).interruptionReason)).toEqual(['user', 'user'])
      expect(notifications.slice(2).map(notification => (notification.params as any).interruptionReason)).toEqual([undefined, undefined])
    } finally {
      unsubscribe()
    }
  })

  it('removes the manual-stop marker when the interrupt RPC fails', async () => {
    rpc.mockRejectedValueOnce(new Error('interrupt rejected'))
    expect((await post({ method: 'turn/interrupt', params: { threadId: 'thread-a', turnId: 'turn-a' } })).status).toBe(502)
    const notifications: Array<{ params: unknown }> = []
    const unsubscribe = runtime.onNotification(notification => notifications.push(notification))
    try {
      ;(runtime as unknown as { emitNotification: (notification: unknown) => void }).emitNotification({ method: 'turn/cancelled', params: { threadId: 'thread-a', turnId: 'turn-a', error: { message: 'connection reset' } } })
      expect((notifications[0]?.params as any).interruptionReason).toBeUndefined()
    } finally {
      unsubscribe()
    }
  })

  it('retains validation, request instrumentation, title shortcut and retired send gates', async () => {
    expect(await post(null)).toEqual({ status: 400, body: { error: 'Invalid body: expected { method, params? }' } })
    expect(recordRequest).toHaveBeenCalledWith(null)
    expect(await post({ method: 'generate-thread-title' })).toEqual({ status: 200, body: { result: { title: '' } } })
    for (const method of ['turn/start', 'turn/steer']) {
      expect(await post({ method, params: { threadId: 'thread-a' } })).toEqual({ status: 502, body: { error: '发送接口已更新，请刷新页面后重试' } })
    }
    expect(rpc).not.toHaveBeenCalled()
    expect((await fetch(`${base}/codex-api/rpc`)).status).toBe(404)
  })

  it('avoids rate-limit RPC without auth and keeps authenticated error classification', async () => {
    expect(await post({ method: 'account/rateLimits/read' })).toEqual({ status: 200, body: { result: null } })
    expect(rpc).not.toHaveBeenCalled()
    await writeFile(join(home, 'auth.json'), JSON.stringify({ tokens: { refresh_token: 'synthetic-fixture' } }))
    rpc.mockRejectedValueOnce(new Error('Authentication required to read rate limits'))
    expect(await post({ method: 'account/rateLimits/read' })).toEqual({ status: 200, body: { result: null } })
    rpc.mockRejectedValueOnce(new Error('Network unavailable'))
    expect((await post({ method: 'account/rateLimits/read' })).status).toBe(502)
  })

  it('uses native paging then merges error/media/skill projection before storing the snapshot', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
    thread.historyMode = 'paginated'
    thread.turns = [{ id: 'turn-a', status: 'completed', items: [{ id: 'user', type: 'userMessage', content: [{ type: 'image', url: `data:image/png;base64,${png}` }] }] }]
    await writeFile(thread.path, [
      { type: 'turn_context', payload: { turn_id: 'turn-a' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<skill><name>fixture</name><path>/fixture/SKILL.md</path></skill>' }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n')
    ;(runtime as any).handleLine(JSON.stringify({ method: 'error', params: { threadId: 'thread-a', turnId: 'turn-a', error: { message: 'fixture failure' }, willRetry: false } }))
    const result = (await post({ method: 'thread/read', params: { threadId: 'thread-a', includeTurns: true } })).body.result
    expect(result.threadHistory).toMatchObject({ source: 'native', nextCursor: 'opaque/+', hasMoreOlder: true })
    expect(result.thread.turns[0]).toMatchObject({ status: 'failed', error: { message: 'fixture failure' } })
    const content = result.thread.turns[0].items[0].content
    expect(content).toContainEqual({ type: 'skill', name: 'fixture', path: '/fixture/SKILL.md' })
    const imagePath = new URL(content[0].url, base).searchParams.get('path')!
    expect(await readFile(imagePath)).toEqual(Buffer.from(png, 'base64'))
    expect(runtime.getLastThreadReadSnapshot('thread-a')).toEqual(result)
    expect(rpc.mock.calls.map(row => row[0])).toEqual(['thread/read', 'thread/turns/list'])
  })

  it('bounds full fork projection to the latest ten turns without mutating native input', async () => {
    thread.turns = Array.from({ length: 15 }, (_, index) => ({ id: `turn-${index}`, items: [] }))
    const response = await post({ method: 'thread/fork', params: { threadId: 'thread-a' } })
    expect(response.body.result.threadTurnStartIndex).toBe(5)
    expect(response.body.result.thread.turns).toHaveLength(10)
    expect(thread.turns).toHaveLength(15)
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('keeps plugin catalog cache, compaction gate and directory mutation timing', async () => {
    await post({ method: 'plugin/list', params: { cwds: [home] } })
    await post({ method: 'plugin/list', params: { cwds: [home] } })
    expect(rpc.mock.calls.filter(row => row[0] === 'plugin/list')).toHaveLength(1)
    expect((await post({ method: 'thread/compact/start', params: { threadId: 'thread-a' } })).status).toBe(200)
    expect((await post({ method: 'thread/compact/start', params: { threadId: 'thread-a' } })).status).toBe(502)
    expect(rpc.mock.calls.filter(row => row[0] === 'thread/compact/start')).toHaveLength(1)
    rpc.mockImplementationOnce(async () => {
      expect(invalidateDirectory).toHaveBeenCalledTimes(1)
      throw new Error('Write failed')
    })
    expect((await post({ method: 'config/value/write', params: {} })).status).toBe(502)
    expect(invalidateSearch).not.toHaveBeenCalled()
  })

  it('gates history rollback before RPC and invalidates history/search only after mutation succeeds', async () => {
    const invalidateHistory = vi.spyOn(history, 'invalidate')
    thread.historyMode = 'paginated'
    expect((await post({ method: 'thread/rollback', params: { threadId: 'thread-a' } })).status).toBe(502)
    expect(rpc.mock.calls.map(row => row[0])).toEqual(['thread/read'])
    expect(invalidateSearch).not.toHaveBeenCalled()
    thread.historyMode = 'legacy'
    expect((await post({ method: 'thread/rollback', params: { threadId: 'thread-a' } })).status).toBe(200)
    expect(invalidateHistory).toHaveBeenCalledWith('thread-a')
    expect(invalidateSearch).toHaveBeenCalledExactlyOnceWith('thread-a')
    rpc.mockRejectedValueOnce(new Error('Rename failed'))
    expect((await post({ method: 'thread/name/set', params: { threadId: 'thread-a' } })).status).toBe(502)
    expect(invalidateSearch).toHaveBeenCalledTimes(1)
  })

  it('keeps empty snapshot and materialization fallbacks separate from projection', async () => {
    const snapshot = { thread: { id: 'thread-a', turns: [{ id: 'previous', items: [] }] } }
    runtime.storeThreadReadSnapshot('thread-a', snapshot)
    rpc.mockRejectedValueOnce(new Error('Failed to read thread: rollout is empty'))
    expect((await post({ method: 'thread/read', params: { threadId: 'thread-a' } })).body.result).toEqual(snapshot)
    rpc.mockRejectedValueOnce(new Error('Not materialized yet: includeTurns is unavailable before first user message'))
    expect((await post({ method: 'thread/read', params: { threadId: 'new' } })).body.result).toEqual({ thread: { id: 'new', turns: [], status: { type: 'inProgress' } } })
    rpc.mockRejectedValueOnce(new Error('Network unavailable'))
    expect((await post({ method: 'thread/read', params: { threadId: 'thread-a' } })).status).toBe(502)
  })

  it('uses archive recovery and list augmentation once through their original operations', async () => {
    rpc.mockRejectedValueOnce(new Error('no rollout found'))
    expect((await post({ method: 'thread/archive', params: { threadId: 'thread-a' } })).status).toBe(200)
    expect(rpc.mock.calls.map(row => row[0])).toEqual(['thread/archive', 'thread/read', 'thread/name/set', 'thread/archive'])
    expect(invalidateSearch).toHaveBeenCalledExactlyOnceWith('thread-a')
    expect((await post({ method: 'thread/list', params: { cursor: 'next' } })).status).toBe(200)
    expect(mergeImported).toHaveBeenCalledTimes(1)
  })
})
