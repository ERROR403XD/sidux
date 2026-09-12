import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createCodexBridgeMiddleware, type AppServerProcess } from './codexAppServerBridge'

it('persists problems independently of blue dots through the real HTTP bridge, with no native requests on snapshot/ignore', async () => {
  const home = await mkdtemp(join(tmpdir(), 'interruption-bridge-'))
  vi.stubEnv('CODEX_HOME', home)
  vi.stubEnv('CODEXUI_CODEX_COMMAND', resolve('src/server/fixtures/account-app-server.cjs'))
  const bridge = createCodexBridgeMiddleware()
  const runtime = (globalThis as unknown as { __codexRemoteSharedBridge__: { appServer: AppServerProcess } }).__codexRemoteSharedBridge__.appServer
  const rpc = vi.spyOn(runtime, 'rpc')
  const events: unknown[] = []
  const unsubscribe = bridge.subscribeNotifications(event => { if (event.method === 'codexapp/interruptions/changed') events.push(event.params) })
  const server = createServer((req, res) => { void bridge(req, res, () => { res.statusCode = 404; res.end() }) })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/codex-api`
    const read = async () => (await (await fetch(`${base}/thread-interruptions`)).json()).data
    const emit = (method: string, params: unknown) => (runtime as unknown as { emitNotification: (notification: unknown) => void }).emitNotification({ method, params })
    expect(await read()).toEqual({})
    emit('turn/completed', { threadId: 'network', turn: { id: 'turn-network', status: 'failed', error: { message: 'connection reset' } } })
    emit('turn/completed', { threadId: 'quota', turn: { id: 'turn-quota', status: 'failed', error: { message: 'quota exceeded' } } })
    emit('turn/cancelled', { threadId: 'manual', turnId: 'turn-manual' })
    const expected = { network: [{ turnId: 'turn-network', kind: 'error' }], quota: [{ turnId: 'turn-quota', kind: 'quota' }] }
    await vi.waitFor(async () => expect(await read()).toEqual(expected))
    // Middleware boot may warm the plugin catalog; the display operations below
    // must add no native requests after that independent startup work.
    expect(rpc.mock.calls.every(([method]) => method === 'plugin/list')).toBe(true)
    rpc.mockClear()
    await fetch(`${base}/thread-completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId: 'network', token: 'turn-network' }) })
    expect(await read()).toEqual(expected)
    const ignore = async (ignored: boolean) => fetch(`${base}/ignored-quota-errors`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId: 'network', turnId: 'turn-network', ignored }) })
    expect((await ignore(true)).status).toBe(200)
    expect(await read()).toEqual({ quota: expected.quota })
    expect((await ignore(false)).status).toBe(200)
    expect(await read()).toEqual(expected)
    expect(events).toContainEqual({ threadId: 'network', issues: [] })
    expect(rpc).not.toHaveBeenCalled()
  } finally {
    rpc.mockRestore()
    unsubscribe()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await bridge.dispose()
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  }
})
