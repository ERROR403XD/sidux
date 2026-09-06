import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AppServerProcess, createCodexBridgeMiddleware } from './codexAppServerBridge'

vi.mock('./skillsRoutes.js', () => ({ initializeSkillsSyncOnStartup: vi.fn(), handleSkillsRoutes: vi.fn() }))

it('keeps the new middleware usable when Vite closes the old server, and releases the last owner once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-lifecycle-'))
  vi.stubEnv('CODEX_HOME', directory)
  const scope = globalThis as typeof globalThis & { __codexRemoteSharedBridge__?: unknown }
  const previous = scope.__codexRemoteSharedBridge__
  let stopped = false
  const cleanup = vi.fn(async () => { stopped = true })
  const subscribers = new Set<unknown>()
  const state = {
    disposed: false, owners: 0, disposal: null, version: 'shared-runtime-0209-v1',
    appServer: { dispose: vi.fn(), rpc: vi.fn(), onNotification: (listener: unknown) => { subscribers.add(listener); return () => subscribers.delete(listener) } },
    terminalManager: { dispose: vi.fn() },
    telegramBridge: { stop: vi.fn() },
    methodCatalog: { snapshot: vi.fn() },
    backendQueueProcessor: { dispose: cleanup, readState: async () => { if (stopped) throw new Error('发送服务已停止'); return {} } },
    automationEngine: { dispose: vi.fn(async () => {}) },
    processActivity: { flush: vi.fn(async () => {}) },
  }
  scope.__codexRemoteSharedBridge__ = state
  const old = createCodexBridgeMiddleware()
  const current = createCodexBridgeMiddleware()
  const server = createServer((req, res) => { void current(req, res, () => { res.statusCode = 404; res.end() }) })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    expect(subscribers.size).toBe(4)
    await old.dispose()
    await old.dispose()
    expect(subscribers.size).toBe(2)
    const address = server.address() as { port: number }
    const response = await fetch(`http://127.0.0.1:${address.port}/codex-api/thread-queue-state`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: {} })
    expect(cleanup).not.toHaveBeenCalled()
    await Promise.all([current.dispose(), current.dispose()])
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(state.appServer.dispose).toHaveBeenCalledTimes(1)
    expect(state.automationEngine.dispose).toHaveBeenCalledTimes(1)
    expect(subscribers.size).toBe(0)
  } finally {
    await Promise.all([old.dispose(), current.dispose()])
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    scope.__codexRemoteSharedBridge__ = previous
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true })
  }
})


it('includes residual commands in account quiescence and rejects unknown thread state', async () => {
  const runtime = new AppServerProcess()
  const rpc = vi.spyOn(runtime, 'rpc').mockResolvedValue({ data: [{ id: 't', status: { type: 'idle' } }], nextCursor: null })
  runtime.queueStateReader = async () => ({})
  runtime.backgroundActivity = async () => ['t']
  expect(await runtime.getRuntimeQuiescenceSnapshot()).toMatchObject({ idle: false, activeTurnThreadIds: [], backgroundThreadIds: ['t'] })
  runtime.backgroundActivity = async () => []
  expect((await runtime.getRuntimeQuiescenceSnapshot()).idle).toBe(true)
  rpc.mockResolvedValue({ data: [{ id: 't', status: { type: 'unknown' } }] })
  await expect(runtime.getRuntimeQuiescenceSnapshot()).rejects.toThrow('未知')
  rpc.mockResolvedValue({})
  await expect(runtime.getRuntimeQuiescenceSnapshot()).rejects.toThrow('核对')
})
