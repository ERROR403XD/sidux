import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createCodexBridgeMiddleware, type AppServerProcess } from './codexAppServerBridge'

it('records only new completion events and broadcasts token-checked clicks through the real HTTP bridge', async () => {
  const home = await mkdtemp(join(tmpdir(), 'completion-bridge-'))
  vi.stubEnv('CODEX_HOME', home)
  vi.stubEnv('CODEXUI_CODEX_COMMAND', resolve('src/server/fixtures/account-app-server.cjs'))
  const bridge = createCodexBridgeMiddleware()
  const runtime = (globalThis as unknown as { __codexRemoteSharedBridge__: { appServer: AppServerProcess } }).__codexRemoteSharedBridge__.appServer
  const events: unknown[] = []
  const unsubscribe = bridge.subscribeNotifications(event => {
    if (event.method === 'codexapp/completions/changed') events.push(event.params)
  })
  const server = createServer((req, res) => { void bridge(req, res, () => { res.statusCode = 404; res.end() }) })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const url = `http://127.0.0.1:${port}/codex-api/thread-completions`
    const read = async () => (await (await fetch(url)).json()).data
    expect(await read()).toEqual({})
    const emit = (method: string, params: unknown) => (runtime as unknown as { emitNotification: (notification: unknown) => void }).emitNotification({ method, params })
    emit('thread/status/changed', { threadId: 'old', status: { type: 'idle' } })
    expect(await read()).toEqual({})
    emit('turn/completed', { threadId: 'new', turn: { id: 'turn-one', status: 'completed' } })
    await vi.waitFor(async () => expect(await read()).toEqual({ new: 'turn-one' }))
    emit('turn/completed', { threadId: 'new', turn: { id: 'turn-two', status: 'completed' } })
    await vi.waitFor(async () => expect(await read()).toEqual({ new: 'turn-two' }))
    const acknowledge = (token: string) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId: 'new', token }) })
    expect((await acknowledge('turn-one')).status).toBe(200)
    expect(await read()).toEqual({ new: 'turn-two' })
    expect((await acknowledge('turn-two')).status).toBe(200)
    expect(await read()).toEqual({})
    emit('turn/completed', { threadId: 'new', turn: { id: 'turn-two', status: 'completed' } })
    expect(await read()).toEqual({})
    expect(events).toEqual([{ threadId: 'new', token: 'turn-one' }, { threadId: 'new', token: 'turn-two' }, { threadId: 'new', token: null }])
  } finally {
    unsubscribe()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await bridge.dispose()
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  }
})
