import * as fs from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { AppServerProcess } from '../appServerProcess.js'
import { failBridgeRequest } from '../codexAppServerBridge.js'
import { readAnyJsonBody, setJson } from '../httpUtils.js'
import { ThreadHistory } from '../threadHistory.js'
import { createThreadReadService } from '../threadReadService.js'
import { createThreadReadRoutes } from './threadReadRoutes.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

let home: string
let sessionPath: string
let runtime: AppServerProcess
let server: Server
let baseUrl: string
let thread: Record<string, any>
let rpc: MockInstance<AppServerProcess['rpc']>
let invalidateSearch: ReturnType<typeof vi.fn<() => void>>

async function request(path: string, params: Record<string, string> = {}, body?: unknown) {
  const response = await fetch(`${baseUrl}/codex-api/${path}?${new URLSearchParams(params)}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as any }
}

function sessionRows(rows: unknown[]) {
  return rows.map(row => JSON.stringify(row)).join('\n') + '\n'
}

beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'sidux-thread-read-'))
  vi.stubEnv('CODEX_HOME', home)
  sessionPath = join(home, 'fixture.jsonl')
  await fs.writeFile(sessionPath, '')
  thread = { id: 'thread-a', path: sessionPath, turns: [{ id: 'turn-a', status: 'completed', items: [] }] }
  runtime = new AppServerProcess({ isolatedTask: true })
  rpc = vi.spyOn(runtime, 'rpc').mockImplementation(async (method, params) => {
    if (method === 'thread/read') return { thread: structuredClone(thread) }
    if (method === 'thread/turns/list') return { data: [...thread.turns].reverse(), nextCursor: 'next/+=' }
    if (method === 'thread/items/list') return { data: thread.turns[0].items.map((item: unknown) => ({ turnId: 'turn-a', item })), nextCursor: null }
    if (method === 'thread/fork') return { thread: { id: 'forked', turns: [] }, received: params }
    throw new Error(`Unexpected fixture RPC: ${method}`)
  })
  const history = new ThreadHistory((method, params) => runtime.rpc(method, params), async () => ({ historyPaging: true, resumeInitialPage: true, exactFork: true }))
  invalidateSearch = vi.fn()
  const route = createThreadReadRoutes(createThreadReadService({ runtime, history, invalidateSearch }))
  server = createServer((req, res) => {
    void route(req, res, new URL(req.url ?? '/', 'http://localhost'), { readJsonBody: readAnyJsonBody }).then(handled => {
      if (!handled) setJson(res, 404, { error: 'Unknown route' })
    }).catch(error => failBridgeRequest(res, error))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing listener')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  runtime.dispose()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await fs.rm(home, { recursive: true, force: true })
})

describe('thread read route with real history and runtime projection', () => {
  it('reads exact turn items and keeps task excerpts bounded to recent messages', async () => {
    thread.turns[0].items = [{ id: 'message-a', type: 'agentMessage', text: 'fixture answer' }]
    const turn = await request('thread-turn-items', { threadId: 'thread-a', turnId: 'turn-a' })
    expect(turn.status).toBe(200)
    expect(turn.body.result.thread.turns).toEqual([{ id: 'turn-a', status: 'completed', items: thread.turns[0].items }])
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(rpc.mock.calls[1]![0]).toBe('thread/items/list')
    rpc.mockClear()
    const excerpt = await request('task-excerpt', { threadId: 'thread-a' })
    expect(excerpt.status).toBe(200)
    expect(excerpt.body.data).toMatchObject({ threadId: 'thread-a', text: '助手：fixture answer', turnCount: 1, hasMoreOlder: true, truncated: true })
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(rpc).toHaveBeenCalledWith('thread/turns/list', { threadId: 'thread-a', limit: 10, sortDirection: 'desc', itemsView: 'full', cursor: null })
  })

  it('keeps opaque cursors, page bounds, stream error merge and zero-based page indices', async () => {
    thread.turns = [{ id: 'turn-a', status: 'failed', items: [] }]
    vi.spyOn(runtime, 'getStreamEvents').mockReturnValue([{ method: 'turn/completed', params: {
      threadId: 'thread-a', turn: { id: 'turn-a', status: 'failed', error: { message: 'retained failure' } },
    }, atIso: 'fixture' }])
    const response = await request('thread-turn-page', { threadId: 'thread-a', cursor: 'opaque/+=', limit: '999', source: 'native' })
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ source: 'native', nextCursor: 'next/+=', hasMoreOlder: true, startTurnIndex: 0, result: {
      thread: { id: 'thread-a', turns: [{ id: 'turn-a', error: { message: 'retained failure' } }] },
    } })
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(rpc).toHaveBeenCalledWith('thread/turns/list', { threadId: 'thread-a', limit: 50, sortDirection: 'desc', itemsView: 'full', cursor: 'opaque/+=' })
  })

  it('externalizes inline media before returning page content', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
    thread.turns[0].items = [{ id: 'user', type: 'userMessage', content: [{ type: 'image', url: `data:image/png;base64,${png}` }] }]
    const response = await request('thread-turn-page', { threadId: 'thread-a' })
    const imageUrl = response.body.result.thread.turns[0].items[0].content[0].url
    expect(imageUrl).toMatch(/^\/codex-local-image\?path=/)
    const imagePath = new URL(imageUrl, baseUrl).searchParams.get('path')!
    expect((await fs.readFile(imagePath)).equals(Buffer.from(png, 'base64'))).toBe(true)
  })

  it('forks at the exact turn and invalidates search only after success', async () => {
    const result = await request('thread-fork-at-turn', {}, { threadId: 'thread-a', lastTurnId: 'turn-a' })
    expect(result.status).toBe(200)
    expect(rpc).toHaveBeenCalledExactlyOnceWith('thread/fork', { threadId: 'thread-a', excludeTurns: true, lastTurnId: 'turn-a', deferGoalContinuation: true })
    expect(invalidateSearch).toHaveBeenCalledTimes(1)
    rpc.mockRejectedValueOnce(new Error('fork rejected'))
    expect(await request('thread-fork-at-turn', {}, { threadId: 'thread-a', lastTurnId: 'turn-a' })).toEqual({ status: 502, body: { error: 'fork rejected' } })
    expect(invalidateSearch).toHaveBeenCalledTimes(1)
  })

  it('recovers session command order and reuses the original runtime cache', async () => {
    thread.turns[0].items = [{ id: 'a', type: 'agentMessage', text: 'before' }, { id: 'b', type: 'agentMessage', text: 'after' }]
    await fs.writeFile(sessionPath, sessionRows([
      { type: 'turn_context', payload: { turn_id: 'turn-a' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant' } },
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call-a', arguments: JSON.stringify({ cmd: 'fixture command' }) } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-a', output: 'Process exited with code 0\nWall time: 0.1 seconds\nOutput:\nfixture output' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant' } },
    ]))
    const fileRead = vi.mocked(fs.readFile)
    fileRead.mockClear()
    const first = await request('thread-live-state', { threadId: 'thread-a' })
    expect(first.status).toBe(200)
    expect(first.body.conversationState.turns[0].items.map((item: { type: string }) => item.type)).toEqual(['agentMessage', 'commandExecution', 'agentMessage'])
    expect(first.body.conversationState.turns[0].items[1]).toMatchObject({ command: 'fixture command', aggregatedOutput: 'fixture output', exitCode: 0, durationMs: 100 })
    const cache = runtime.getCachedLiveState('thread-a', 1, (await fs.stat(sessionPath)).size)
    expect(cache).toEqual(first.body)
    expect(await request('thread-live-state', { threadId: 'thread-a' })).toEqual(first)
    expect(fileRead.mock.calls.filter(([path]) => path === sessionPath)).toHaveLength(1)
    expect(rpc).toHaveBeenCalledTimes(2)
    await fs.appendFile(sessionPath, '\n')
    await request('thread-live-state', { threadId: 'thread-a' })
    expect(fileRead.mock.calls.filter(([path]) => path === sessionPath)).toHaveLength(2)
  })

  it('keeps active states out of cache and recovers from pending materialization or failed reads', async () => {
    thread.turns[0].status = 'inProgress'
    const first = await request('thread-live-state', { threadId: 'thread-a' })
    expect(first.body.isInProgress).toBe(true)
    expect(runtime.getCachedLiveState('thread-a', 1, 0)).toBeNull()
    rpc.mockRejectedValueOnce(new Error('not materialized yet: includeTurns is unavailable before first user message'))
    expect(await request('thread-live-state', { threadId: 'thread-a' })).toEqual({ status: 200, body: {
      threadId: 'thread-a', conversationState: { turns: [] }, ownerClientId: null, liveStateError: null, isInProgress: true,
    } })
    rpc.mockRejectedValueOnce(new Error('read failed'))
    const recovered = await request('thread-live-state', { threadId: 'thread-a' })
    expect(recovered.status).toBe(200)
    expect(recovered.body.conversationState.turns).toEqual(first.body.conversationState.turns)
    expect(recovered.body.liveStateError).toEqual({ kind: 'readFailed', message: 'read failed' })
    rpc.mockRejectedValueOnce(new Error('missing snapshot'))
    expect(await request('thread-live-state', { threadId: 'thread-b' })).toEqual({ status: 200, body: {
      threadId: 'thread-b', conversationState: null, ownerClientId: null,
      liveStateError: { kind: 'readFailed', message: 'missing snapshot' }, isInProgress: false,
    } })
  })

  it('recovers completed apply_patch changes and fails open for unavailable session files', async () => {
    await fs.writeFile(sessionPath, sessionRows([
      { type: 'turn_context', payload: { turn_id: 'turn-a' } },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', status: 'completed', input: '*** Begin Patch\n*** Add File: fixture.txt\n+one\n+two\n*** End Patch' } },
    ]))
    expect(await request('thread-file-change-fallback', { threadId: 'thread-a' })).toEqual({ status: 200, body: { data: [{
      turnId: 'turn-a', turnIndex: 0, fileChanges: [{ path: 'fixture.txt', operation: 'add', movedToPath: null, diff: 'one\ntwo', addedLineCount: 2, removedLineCount: 0 }],
    }] } })
    thread.path = 'relative/path.jsonl'
    expect(await request('thread-file-change-fallback', { threadId: 'thread-a' })).toEqual({ status: 200, body: { data: [] } })
    thread.path = join(home, 'missing.jsonl')
    expect(await request('thread-file-change-fallback', { threadId: 'thread-a' })).toEqual({ status: 200, body: { data: [] } })
  })

  it('caps stream event requests, rejects missing IDs, and preserves route errors', async () => {
    const events = vi.spyOn(runtime, 'getStreamEvents').mockReturnValue([])
    expect(await request('thread-stream-events', { threadId: 'thread-a', limit: '9999' })).toEqual({ status: 200, body: { events: [] } })
    expect(events).toHaveBeenCalledExactlyOnceWith('thread-a', 400)
    for (const path of ['thread-turn-page', 'thread-turn-items', 'thread-file-change-fallback', 'thread-live-state', 'thread-stream-events']) {
      expect((await request(path)).status).toBe(400)
    }
    rpc.mockRejectedValueOnce(new Error('history read failed'))
    expect(await request('thread-turn-page', { threadId: 'thread-a' })).toEqual({ status: 500, body: { error: 'history read failed' } })
    expect((await request('unknown')).status).toBe(404)
  })
})
