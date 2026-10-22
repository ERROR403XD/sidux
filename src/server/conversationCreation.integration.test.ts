import { createServer as createHttpServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createServer } from './httpServer.js'
import type { AppServerProcess } from './appServerProcess.js'
import { getAccountAuthCoordinator } from './accountAuthCoordinator.js'
import { getVirtualProjectStore } from './workspaceStateService.js'
import { BackendQueueProcessor } from './backendQueueRuntime.js'

it('creates physical and organized conversations through real HTTP, durable delivery and the owning IPC process', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sidux-conversation-api-'))
  vi.stubEnv('CODEX_HOME', home)
  vi.stubEnv('CODEXUI_CODEX_COMMAND', resolve('src/server/fixtures/account-app-server.cjs'))
  const coordinator = getAccountAuthCoordinator()
  vi.spyOn(coordinator, 'refreshAccount').mockImplementation(async id => (await coordinator.store.readState()).accounts.find(account => account.storageId === id)!)
  const instance = createServer({ password: 'fixture-browser-only' })
  const runtime = (globalThis as unknown as { __codexRemoteSharedBridge__: { appServer: AppServerProcess } }).__codexRemoteSharedBridge__.appServer
  const rpc = vi.spyOn(runtime, 'rpc')
  const submit = vi.spyOn(BackendQueueProcessor.prototype, 'submit')
  const server = createHttpServer(instance.app)
  instance.attachWebSocket(server)
  let virtualCwd = ''
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const post = async (path: string, input: unknown, secret?: string) => fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}`, Host: 'external-client.test' } : {}) },
      body: JSON.stringify(input),
    })
    expect((await post('/codex-api/api-proxy/settings', { settings: { enabled: true } })).status).toBe(200)
    const keyResponse = await post('/codex-api/api-proxy/keys', { name: 'conversation-integration' })
    const { data: { secret } } = await keyResponse.json() as { data: { secret: string } }
    const command = 'SIDUX_DEV7_EXTERNAL_HTTP "引号"\n第二行原文'
    const response = await post('/v1/conversations', { project: home, command, model: 'fixture', reasoningEffort: 'ultra' }, secret)
    const created = await response.json() as any
    expect(response.status, JSON.stringify({ created, failures: submit.mock.settledResults.map(row => row.type === 'rejected' ? String(row.value) : row.type) })).toBe(201)
    expect(created).toMatchObject({ object: 'conversation', project: home, cwd: home, model: 'fixture', reasoningEffort: 'ultra', status: 'accepted', turnId: expect.any(String) })
    expect(rpc).toHaveBeenCalledWith('thread/start', { cwd: home, model: 'fixture', config: { model_reasoning_effort: 'ultra' } })
    expect(rpc).toHaveBeenCalledWith('turn/start', expect.objectContaining({ model: 'fixture', effort: 'ultra', input: [{ type: 'text', text: command }], clientUserMessageId: created.messageId }))
    await vi.waitFor(async () => {
      const thread = await runtime.rpc('thread/read', { threadId: created.threadId, includeTurns: true }) as any
      expect(thread.thread.turns).toHaveLength(1)
      expect(thread.thread.turns[0].status).toBe('completed')
      expect(thread.thread.turns[0].items[0].content[0].text).toBe(command)
    })
    const statuses = await fetch(base + '/codex-api/delivery-status?' + new URLSearchParams({ threadId: created.threadId, ids: created.messageId }))
    expect(await statuses.json()).toEqual({ data: [{ id: created.messageId, status: 'accepted', turnId: created.turnId }] })
    const project = await getVirtualProjectStore().save(undefined, 'dev.7 接口测试项目')
    const organizedResponse = await post('/v1/conversations', { project: project.id, command: `SIDUX_DEV7_ORGANIZED_${Date.now()}` }, secret)
    const organized = await organizedResponse.json() as any
    virtualCwd = organized.cwd || ''
    expect(organizedResponse.status).toBe(201)
    expect(organized).toMatchObject({ project: project.id, status: 'accepted', model: 'fixture' })
    expect((await getVirtualProjectStore().get(project.id)).cwds).toContain(virtualCwd)
    expect(virtualCwd).not.toBe(project.id)
    const invalid = await post('/v1/conversations', { project: join(home, 'missing'), command: 'run' }, secret)
    expect(invalid.status).toBe(404)
    const state = JSON.parse(await readFile(join(home, '.codex-global-state.json'), 'utf8'))
    expect(JSON.stringify(state)).toContain(home)
    const starts = rpc.mock.calls.filter(([method]) => method === 'thread/start')
    const turns = rpc.mock.calls.filter(([method]) => method === 'turn/start')
    expect(starts).toHaveLength(2)
    expect(turns).toHaveLength(2)
    const runningResponse = await post('/v1/conversations', { project: home, command: 'STALL SIDUX_DEV7_ASYNC' }, secret)
    const running = await runningResponse.json() as any
    expect(runningResponse.status).toBe(201)
    expect(running).toMatchObject({ status: 'accepted', turnId: expect.any(String) })
    const active = await runtime.rpc('thread/read', { threadId: running.threadId, includeTurns: true }) as any
    expect(active.thread.turns[0].status).toBe('inProgress')
    await runtime.rpc('turn/interrupt', { threadId: running.threadId, turnId: running.turnId })
    console.info(JSON.stringify({ verification: 'conversation-http-ipc', created: 2, nativeThreadStarts: starts.length, nativeTurnStarts: turns.length, duplicateSubmissions: 0 }))
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await instance.dispose()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    if (virtualCwd) await rm(virtualCwd, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
}, 20000)
