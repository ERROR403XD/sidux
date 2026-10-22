import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectoryMcpReader } from '../directoryMcpReader.js'
import { setJson } from '../httpUtils.js'
import { createDirectoryMcpRoutes } from './directoryMcpRoutes.js'

let server: Server
let base: string
let reader: DirectoryMcpReader
let requestCount: number
let rpc: ReturnType<typeof vi.fn<(method: string, params: any) => Promise<unknown>>>

beforeEach(async () => {
  rpc = vi.fn(async () => ({ data: [{ name: 'fixture', authStatus: 'loggedIn', tools: { tool: { name: 'tool', inputSchema: { privateShape: true } } }, resources: [{ name: 'resource', uri: 'fixture://one' }] }] }))
  reader = new DirectoryMcpReader(rpc)
  requestCount = 0
  const route = createDirectoryMcpRoutes(reader)
  server = createServer((req, res) => {
    requestCount++
    void route(req, res, new URL(req.url ?? '/', 'http://localhost')).then(handled => {
      if (!handled) setJson(res, 404, { error: 'Unknown route' })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing listener')
  base = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})

async function get(params: Record<string, string> = {}) {
  const response = await fetch(`${base}/codex-api/directory/mcps?${new URLSearchParams(params)}`)
  return { status: response.status, body: await response.json() as any }
}

describe('MCP directory HTTP and pending-read ownership', () => {
  it('keeps scope/detail parameters and trims heavy schema from projections', async () => {
    const compact = await get({ threadId: '  thread-a  ' })
    expect(compact.status).toBe(200)
    expect(compact.body.data[0]).toMatchObject({ name: 'fixture', detailsLoaded: false, resources: [], toolCount: 1 })
    expect(JSON.stringify(compact)).not.toContain('privateShape')
    expect(rpc).toHaveBeenCalledExactlyOnceWith('mcpServerStatus/list', { limit: 25, detail: 'toolsAndAuthOnly', threadId: 'thread-a' })
    expect((await get({ full: 'true' })).body.data[0]).toMatchObject({ detailsLoaded: true, resources: [{ name: 'resource', uri: 'fixture://one' }] })
    expect(rpc).toHaveBeenLastCalledWith('mcpServerStatus/list', { limit: 25, detail: 'full' })
    expect((await fetch(`${base}/codex-api/directory/mcps`, { method: 'POST' })).status).toBe(404)
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('shares same-scope in-flight pages while completed reads remain fresh', async () => {
    let release: (value: unknown) => void = () => {}
    rpc.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const first = get()
    const second = get()
    await vi.waitFor(() => expect(requestCount).toBe(2))
    expect(rpc).toHaveBeenCalledTimes(1)
    release({ data: [{ name: 'first' }], nextCursor: 'next/+' })
    rpc.mockResolvedValueOnce({ data: [{ name: 'second' }], nextCursor: null })
    const results = await Promise.all([first, second])
    expect(results[0]).toEqual(results[1])
    expect(results[0].body.data.map((row: any) => row.name)).toEqual(['first', 'second'])
    expect(rpc).toHaveBeenCalledTimes(2)
    await get()
    expect(rpc).toHaveBeenCalledTimes(3)
  })

  it('does not let an invalidated old completion clear the newer pending owner', async () => {
    const releases: Array<(value: unknown) => void> = []
    rpc.mockImplementation(() => new Promise(resolve => { releases.push(resolve) }))
    const old = get()
    await vi.waitFor(() => expect(releases).toHaveLength(1))
    reader.invalidate()
    const current = get()
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    releases[0]({ data: [{ name: 'old' }] })
    await old
    const joined = get()
    await vi.waitFor(() => expect(requestCount).toBe(3))
    expect(rpc).toHaveBeenCalledTimes(2)
    releases[1]({ data: [{ name: 'current' }] })
    const [a, b] = await Promise.all([current, joined])
    expect(a).toEqual(b)
    expect(a.body.data[0].name).toBe('current')
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('keeps pagination/upstream errors retryable with the original 502 contract', async () => {
    rpc.mockResolvedValueOnce({ data: [], nextCursor: 'loop' }).mockResolvedValueOnce({ data: [], nextCursor: 'loop' })
    expect((await get()).status).toBe(502)
    rpc.mockRejectedValueOnce(new Error('Upstream unavailable'))
    expect(await get()).toEqual({ status: 502, body: { error: 'Upstream unavailable' } })
    rpc.mockResolvedValueOnce({ data: Array.from({ length: 26 }, () => ({ name: 'too-many' })) })
    expect((await get()).body.error).toBe('MCP 分页响应无效')
    expect((await get()).status).toBe(200)
  })
})
