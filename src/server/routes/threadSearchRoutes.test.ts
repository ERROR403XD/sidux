import { createServer, request, type Server, type ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readAnyJsonBody, setJson } from '../httpUtils.js'
import { ThreadSearch } from '../threadSearch.js'
import { createThreadSearchRoutes } from './threadSearchRoutes.js'

let server: Server
let baseUrl: string
let search: ThreadSearch
let responses: Array<{ response: ServerResponse; closeListeners: number; finished: boolean }>
type SearchDependencies = ConstructorParameters<typeof ThreadSearch>[0]
let list: ReturnType<typeof vi.fn<SearchDependencies['list']>>
let body: ReturnType<typeof vi.fn<SearchDependencies['body']>>
let titles: Record<string, string>

beforeEach(async () => {
  titles = {}
  responses = []
  list = vi.fn(async () => ({ data: Array.from({ length: 12 }, (_, index) => ({ id: String(index), name: `title-${index}`, updatedAt: 1 })) }))
  body = vi.fn(async row => ({ text: `body-${row.id}`, truncated: false }))
  search = new ThreadSearch({ list, body, titles: async () => titles })
  const route = createThreadSearchRoutes(search)
  server = createServer((req, res) => {
    const tracked = { response: res, closeListeners: res.listenerCount('close'), finished: false }
    responses.push(tracked)
    void route(req, res, new URL(req.url ?? '/', 'http://localhost'), { readJsonBody: readAnyJsonBody })
      .then(handled => { if (!handled) setJson(res, 404, { error: 'Unknown route' }) })
      .catch(error => setJson(res, 502, { error: error.message }))
      .finally(() => { tracked.finished = true })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})

async function post(payload: unknown) {
  const response = await fetch(`${baseUrl}/codex-api/thread-search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })
  return { status: response.status, body: await response.json() as any }
}

describe('search HTTP and shared search resource', () => {
  it('keeps empty-query and method matching without loading metadata or bodies', async () => {
    expect(await post({ query: '   ' })).toEqual({ status: 200, body: { data: { threadIds: [], indexedThreadCount: 0 } } })
    expect(await post(null)).toEqual({ status: 200, body: { data: { threadIds: [], indexedThreadCount: 0 } } })
    expect((await fetch(`${baseUrl}/codex-api/thread-search`)).status).toBe(404)
    expect(list).not.toHaveBeenCalled()
    expect(body).not.toHaveBeenCalled()
  })

  it('shares title caching and invalidation across requests without fetching bodies', async () => {
    expect((await post({ query: ' title-1 ', limit: 1.9 })).body.data.threadIds).toEqual(['1'])
    expect((await post({ query: 'title-', limit: 2000, mode: 'unknown' })).body.data.threadIds).toHaveLength(12)
    expect(list).toHaveBeenCalledTimes(1)
    expect(body).not.toHaveBeenCalled()
    titles['1'] = 'renamed'
    search.invalidate('1')
    expect((await post({ query: 'renamed' })).body.data.threadIds).toEqual(['1'])
    expect(list).toHaveBeenCalledTimes(2)
    expect(responses.every(row => row.finished && row.response.listenerCount('close') === row.closeListeners)).toBe(true)
  })

  it('drains at most the current four reads after HTTP disconnect, then serves the next client', async () => {
    const release: Array<() => void> = []
    body.mockImplementation(row => new Promise(resolve => {
      release.push(() => resolve({ text: `body-${row.id}`, truncated: false }))
    }))
    const client = request(`${baseUrl}/codex-api/thread-search`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
    client.on('error', () => {})
    client.end(JSON.stringify({ query: 'body', mode: 'body' }))
    await vi.waitFor(() => expect(release).toHaveLength(4))
    client.destroy()
    await vi.waitFor(() => expect(responses[0].response.destroyed).toBe(true))
    for (const finish of release) finish()
    await vi.waitFor(() => expect(responses[0].finished).toBe(true))
    expect(body).toHaveBeenCalledTimes(4)
    expect(responses[0].response.listenerCount('close')).toBe(responses[0].closeListeners)
    body.mockImplementation(async row => ({ text: `body-${row.id}`, truncated: false }))
    expect((await post({ query: 'body-11', mode: 'body' })).body.data.threadIds).toEqual(['11'])
    expect(body).toHaveBeenCalledTimes(12)
  })

  it('propagates search failure to the bridge and releases the cancellation listener', async () => {
    list.mockRejectedValueOnce(new Error('Metadata unavailable'))
    expect(await post({ query: 'title' })).toEqual({ status: 502, body: { error: 'Metadata unavailable' } })
    expect(responses[0].response.listenerCount('close')).toBe(responses[0].closeListeners)
    expect((await post({ query: 'title-1', limit: 0 })).body.data.threadIds).toHaveLength(1)
  })
})
