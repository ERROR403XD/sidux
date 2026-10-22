import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readAnyJsonBody } from './httpUtils.js'

let server: Server | undefined
afterEach(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server!.close(() => resolve()))
    server = undefined
  }
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('API request metrics transport ownership', () => {
  it.each([
    ['true', '/codex-api/rpc', 1],
    ['false', '/codex-api/rpc', 0],
    ['true', '/outside', 0],
  ])('preserves response bytes for enabled=%s path=%s and emits %i log rows', async (enabled, path, logCount) => {
    vi.stubEnv('CODEXUI_API_PERF_LOGGING', enabled)
    vi.stubEnv('CODEXUI_API_PERF_MS_THRESHOLD', '1000000')
    vi.stubEnv('CODEXUI_API_PERF_BODY_MB_THRESHOLD', '0.5')
    vi.resetModules()
    const { createApiRequestMetrics } = await import('./apiRequestMetrics.js')
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    server = createServer((req, res) => {
      const metrics = createApiRequestMetrics(req, res)
      void readAnyJsonBody(req).then(payload => {
        metrics.recordRpcRequest(payload)
        res.statusCode = 201
        res.setHeader('Content-Type', 'application/octet-stream')
        res.write(Buffer.from([0, 128, 255]))
        res.end('end')
      })
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const payload = { method: 'thread/read', privateMarker: 'synthetic-private-content', padding: 'x'.repeat(1024 * 1024) }
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${path}`, { method: 'POST', body: JSON.stringify(payload) })
    expect(response.status).toBe(201)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([0, 128, 255, 101, 110, 100]))
    expect(info).toHaveBeenCalledTimes(logCount)
    if (logCount) {
      expect(info.mock.calls[0]?.[0]).toMatch(/^\[codex-api-perf\] POST \/codex-api\/rpc -> 201 \(\d+ms, bodyMB=1\.0, rpcMethod=thread\/read\)$/)
      expect(info.mock.calls[0]?.[0]).not.toContain('synthetic-private-content')
    }
  })
})
