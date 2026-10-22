import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hookRunKey } from '../../processActivity.js'
import { BackgroundTerminalReader } from '../backgroundTerminalReader.js'
import { readAnyJsonBody, setJson } from '../httpUtils.js'
import { createProcessActivityService } from '../processActivityService.js'
import { ProcessActivityStore } from '../processActivityStore.js'
import { ThreadHistory } from '../threadHistory.js'
import { createProcessActivityRoutes } from './processActivityRoutes.js'

let home: string
let sessionPath: string
let store: ProcessActivityStore
let server: Server
let baseUrl: string
let rpc: ReturnType<typeof vi.fn<(method: string, params: any) => Promise<unknown>>>
let items: unknown[]
let identityChanging: boolean
const terminal = { processId: '17', itemId: 'command-a', command: 'fixture', cwd: '/tmp' }

async function request(action: string, params: Record<string, string> = {}, body?: unknown) {
  const url = `${baseUrl}/codex-api/process-activity/${action}?${new URLSearchParams(params)}`
  const response = await fetch(url, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as { data?: any; error?: string } }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'sidux-process-service-'))
  sessionPath = join(home, 'fixture.jsonl')
  await writeFile(sessionPath, '')
  store = new ProcessActivityStore(join(home, 'observations.json'))
  items = []
  identityChanging = false
  rpc = vi.fn(async (method, params) => {
    if (method === 'thread/read') return { thread: { id: params.threadId, path: sessionPath } }
    if (method === 'thread/turns/list') return { data: [{ id: 'turn-a', items }], nextCursor: null }
    if (method === 'thread/backgroundTerminals/list') return { data: [terminal], nextCursor: null }
    if (method === 'thread/backgroundTerminals/terminate') return { terminated: true }
    if (method === 'hooks/list') return { data: [{ cwd: home, hooks: [], errors: [], warnings: [] }] }
    throw new Error(`Unexpected fixture RPC: ${method}`)
  })
  const history = new ThreadHistory(rpc, async () => ({ historyPaging: true, resumeInitialPage: true, exactFork: true }))
  const service = createProcessActivityService({
    observations: store,
    backgroundTerminals: new BackgroundTerminalReader(rpc, () => identityChanging),
    history,
    rpc,
  })
  const route = createProcessActivityRoutes(service)
  server = createServer((req, res) => {
    void route(req, res, new URL(req.url ?? '/', 'http://localhost'), { readJsonBody: readAnyJsonBody }).then(handled => {
      if (!handled) setJson(res, 404, { error: 'Unknown route' })
    }).catch(error => setJson(res, 500, { error: error.message }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await store.flush()
  await rm(home, { recursive: true, force: true })
})

describe('process activity HTTP/service/reader integration', () => {
  it('limits Hook previews while retaining complete details and exact run keys', async () => {
    store.observe({ method: 'hook/completed', params: {
      threadId: 'thread-a', turnId: 'turn-a', run: {
        id: 'hook', startedAt: 100, eventName: 'sessionStart', status: 'completed',
        entries: [{ kind: 'context', text: 'x'.repeat(300) }, { kind: 'context', text: 'second entry' }],
      },
    } })
    const preview = await request('hooks', { threadId: 'thread-a' })
    expect(preview.status).toBe(200)
    expect(preview.body.data.runs[0].entries).toEqual([{ kind: 'context', text: 'x'.repeat(160) }])
    const run = (await store.snapshot('thread-a')).runs[0]!
    expect(run.entries).toHaveLength(2)
    expect(run.entries[0]!.text).toHaveLength(300)
    const detail = await request('hook-detail', { threadId: 'thread-a', runKey: hookRunKey(run) })
    expect(detail).toEqual({ status: 200, body: { data: run } })
    expect(await request('hook-detail', { threadId: 'thread-a', runKey: 'missing' })).toEqual({ status: 404, body: { error: 'Hook 记录已不在保留范围内' } })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('reads Hook configuration once for the requested cwd', async () => {
    expect(await request('hook-config', { threadId: 'thread-a', cwd: home })).toEqual({ status: 200, body: { data: { hooks: [], warnings: [], limited: false } } })
    expect(rpc).toHaveBeenCalledExactlyOnceWith('hooks/list', { cwds: [home] })
  })

  it('uses observed output without reading history and preserves terminal failure metadata', async () => {
    store.observe({ method: 'item/completed', params: { threadId: 'thread-a', item: {
      id: 'command-a', type: 'commandExecution', status: 'failed', aggregatedOutput: 'observed output', exitCode: 2,
    } } })
    expect(await request('output', { threadId: 'thread-a', itemId: 'command-a' })).toEqual({ status: 200, body: { data: {
      itemId: 'command-a', text: 'observed output', status: 'failed', exitCode: 2, truncated: false, source: 'observed',
    } } })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('recovers history output from one bounded page without populating a second cache', async () => {
    items = [{ id: 'command-a', type: 'commandExecution', aggregatedOutput: 'saved output', status: 'completed', exitCode: 0 }]
    expect(await request('output', { threadId: 'thread-a', itemId: 'command-a' })).toEqual({ status: 200, body: { data: {
      itemId: 'command-a', text: 'saved output', status: 'completed', exitCode: 0, truncated: false, source: 'history',
    } } })
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(rpc).toHaveBeenCalledWith('thread/turns/list', { threadId: 'thread-a', cursor: null, limit: 10, sortDirection: 'desc', itemsView: 'full' })
    expect(store.output('thread-a', 'command-a')).toBeNull()
  })

  it('uses the structured tail fallback only for an observed command identity', async () => {
    store.observe({ method: 'item/started', params: {
      threadId: 'thread-a', turnId: 'turn-a', startedAtMs: 100000,
      item: { id: 'command-a', type: 'commandExecution', status: 'inProgress', processId: '17' },
    } })
    const meta = { turn_id: 'turn-a', create_time: 101 }
    await writeFile(sessionPath, [
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call-a', internal_chat_message_metadata_passthrough: meta } },
      { type: 'response_item', payload: {
        type: 'custom_tool_call_output', call_id: 'call-a', internal_chat_message_metadata_passthrough: meta,
        output: [{ type: 'input_text', text: JSON.stringify({ session_id: 17, chunk_id: 'fixture', wall_time_seconds: 1, output: 'structured output' }) }],
      } },
    ].map(row => JSON.stringify(row)).join('\n'))
    expect(await request('output', { threadId: 'thread-a', itemId: 'command-a' })).toEqual({ status: 200, body: { data: {
      itemId: 'command-a', text: 'structured output', status: 'inProgress', exitCode: null, truncated: true, source: 'toolResult',
    } } })
    expect(rpc).toHaveBeenCalledTimes(2)
    expect((await request('output', { threadId: 'thread-a', itemId: 'other-command' })).body.data.source).toBe('unavailable')
    expect(rpc).toHaveBeenCalledTimes(4)
  })

  it('verifies exact command identity and identity-change gate before native termination', async () => {
    expect((await request('terminals', { threadId: 'thread-a' })).body.data[0]).toMatchObject(terminal)
    rpc.mockClear()
    expect(await request('terminate', {}, { threadId: 'thread-a', processId: '17', itemId: 'stale-command' })).toEqual({ status: 500, body: { error: '进程已对应另一条命令，请刷新后重新选择' } })
    expect(rpc.mock.calls.map(([method]) => method)).toEqual(['thread/backgroundTerminals/list'])
    rpc.mockClear()
    identityChanging = true
    expect((await request('terminate', {}, { threadId: 'thread-a', processId: '17', itemId: 'command-a' })).status).toBe(500)
    expect(rpc).not.toHaveBeenCalled()
    identityChanging = false
    expect(await request('terminate', {}, { threadId: 'thread-a', processId: '17', itemId: 'command-a' })).toEqual({ status: 200, body: { data: { terminated: true, absent: false } } })
    expect(rpc.mock.calls).toEqual([
      ['thread/backgroundTerminals/list', { threadId: 'thread-a', limit: 20, cursor: null }],
      ['thread/backgroundTerminals/terminate', { threadId: 'thread-a', processId: '17' }],
    ])
  })

  it('preserves missing-input/unknown-operation responses without native calls', async () => {
    expect(await request('hooks')).toEqual({ status: 400, body: { error: '缺少有效会话 ID' } })
    expect(await request('unknown', { threadId: 'thread-a' })).toEqual({ status: 404, body: { error: '未知进程操作' } })
    expect(await request('output', { threadId: 'thread-a' })).toEqual({ status: 500, body: { error: '缺少命令项 ID' } })
    expect(await request('hook-config', { threadId: 'thread-a' })).toEqual({ status: 500, body: { error: '缺少会话目录' } })
    expect(await request('terminate', {}, { threadId: 'thread-a', itemId: 'command-a' })).toEqual({ status: 500, body: { error: '缺少进程或命令项 ID' } })
    expect(rpc).not.toHaveBeenCalled()
  })
})
