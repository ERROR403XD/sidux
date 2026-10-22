import { createServer } from 'node:http'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseAutomationToml, serializeAutomationToml, type ThreadAutomationRecord } from './automationDefinition.js'
import { createAutomationDefinitionService } from './automationDefinitionService.js'
import { AutomationEngine, type AutomationRuntime } from './automationEngine.js'
import { readAnyJsonBody, setJson } from './httpUtils.js'
import { createAutomationDefinitionRoutes } from './routes/automationDefinitionRoutes.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'automation-definition-service-'))
  const runtime: AutomationRuntime = {
    accountBusy: () => false, canStart: async () => true,
    createThread: async () => ({ threadId: 'fixture' }), prepare: async () => ({}),
    start: vi.fn(async () => ({ turnId: 'fixture' })), inspect: async () => ({ status: 'completed' }), interrupt: async () => {},
  }
  const engine = new AutomationEngine(home, runtime, Date.now, false)
  await engine.readyPromise
  const service = createAutomationDefinitionService(home, engine)
  const route = createAutomationDefinitionRoutes(service)
  const server = createServer((req, res) => {
    void route(req, res, new URL(req.url || '/', 'http://localhost'), { readJsonBody: readAnyJsonBody }).then(handled => {
      if (!handled) setJson(res, 404, { error: 'Not found' })
    }).catch(error => setJson(res, 500, { error: error.message }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not start')
  const request = async (method: string, path: string, input?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: input === undefined ? undefined : JSON.stringify(input) })
    return { status: response.status, body: await response.json() }
  }
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await engine.dispose()
    await rm(home, { recursive: true, force: true })
  })
  return { home, engine, service, request, runtime }
}

const input = { name: 'fixture-task', prompt: 'fixture prompt', rrule: 'FREQ=DAILY', status: 'PAUSED' as const, timezone: 'Asia/Shanghai' }

describe('automation definition route, service, storage and scheduler', () => {
  it('creates unique heartbeat definitions, updates execution fields, and preserves memory and unknown TOML', async () => {
    const { home, request, runtime } = await fixture()
    const created = await request('PUT', '/codex-api/thread-automation', { ...input, threadId: 'thread', accountStorageId: 'a'.repeat(64), protected: true, model: 'fixture-model', reasoningEffort: 'high' })
    expect(created.status).toBe(200)
    const first = created.body.data as ThreadAutomationRecord
    expect(first).toMatchObject({ kind: 'heartbeat', targetThreadId: 'thread', accountStorageId: 'a'.repeat(64), protected: true, model: 'fixture-model', reasoningEffort: 'high' })
    expect(first).not.toHaveProperty('extraTomlLines')
    const path = join(home, 'automations', first.id, 'automation.toml')
    await appendFile(path, '\n[fixture]\nretained = true\n')
    await writeFile(join(home, 'automations', first.id, 'memory.md'), 'fixture memory')
    const updated = await request('PUT', '/codex-api/thread-automation', { ...input, id: first.id, threadId: 'thread', prompt: 'updated' })
    expect(updated.status).toBe(200)
    expect(updated.body.data).toMatchObject({ id: first.id, createdAtMs: first.createdAtMs, prompt: 'updated', model: 'fixture-model' })
    expect(await readFile(path, 'utf8')).toContain('retained = true')
    expect(await readFile(join(home, 'automations', first.id, 'memory.md'), 'utf8')).toBe('fixture memory')
    const second = await request('PUT', '/codex-api/thread-automation', { ...input, threadId: 'thread' })
    expect(second.status).toBe(200)
    expect(second.body.data.id).not.toBe(first.id)
    const all = await request('GET', '/codex-api/thread-automations')
    expect(all.body.data.thread).toHaveLength(2)
    expect(all.body.data.thread[0].id).toBe(first.id)
    expect((await request('GET', `/codex-api/thread-automation?threadId=thread&automationId=${first.id}`)).body.data.id).toBe(first.id)
    expect((await request('GET', '/codex-api/thread-automation?threadId=other')).body.data).toEqual([])
    expect(runtime.start).not.toHaveBeenCalled()
  })

  it('removes only one project from a shared cron and retains its other project and memory', async () => {
    const { home, request, engine } = await fixture()
    const created = await request('PUT', '/codex-api/project-automation', { ...input, projectName: '/fixture-a' })
    expect(created.status).toBe(200)
    const id = created.body.data.id as string
    const directory = join(home, 'automations', id)
    const path = join(directory, 'automation.toml')
    const definition = parseAutomationToml(await readFile(path, 'utf8'))!
    await writeFile(path, serializeAutomationToml({ ...definition, cwds: ['/fixture-a', '/fixture-b'] }))
    await writeFile(join(directory, 'memory.md'), 'keep memory')
    await engine.refresh()
    expect((await request('GET', '/codex-api/project-automations')).body.data['/fixture-b']).toHaveLength(1)
    expect((await request('DELETE', `/codex-api/project-automation?projectName=/fixture-a&automationId=${id}`)).body.data).toEqual({ removed: true })
    expect(parseAutomationToml(await readFile(path, 'utf8'))?.cwds).toEqual(['/fixture-b'])
    expect(await readFile(join(directory, 'memory.md'), 'utf8')).toBe('keep memory')
    expect((await request('GET', '/codex-api/project-automation?projectName=/fixture-a')).body.data).toEqual([])
    expect((await request('DELETE', `/codex-api/project-automation?projectName=/fixture-b&automationId=${id}`)).body.data).toEqual({ removed: true })
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await request('DELETE', '/codex-api/project-automation?projectName=/fixture-b')).body.data).toEqual({ removed: false })
  })

  it('validates before writing and retains established response and unknown-route contracts', async () => {
    const { home, request, service } = await fixture()
    expect((await request('PUT', '/codex-api/thread-automation', input)).status).toBe(400)
    expect((await request('PUT', '/codex-api/project-automation', { ...input, projectName: 'relative' })).status).toBe(400)
    expect((await request('GET', '/codex-api/thread-automation')).status).toBe(400)
    expect((await request('DELETE', '/codex-api/project-automation')).status).toBe(400)
    expect((await request('POST', '/codex-api/thread-automation', {})).status).toBe(404)
    await expect(service.saveThread({ ...input, threadId: 'thread', rrule: 'INVALID' })).rejects.toThrow()
    await expect(readFile(join(home, 'automations', 'fixture-task', 'automation.toml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses the injected home and scheduler even when another service has the same definition ID', async () => {
    const first = await fixture()
    const second = await fixture()
    const one = await first.service.saveThread({ ...input, threadId: 'thread', prompt: 'one' })
    const two = await second.service.saveThread({ ...input, threadId: 'thread', prompt: 'two' })
    expect(one.id).toBe(two.id)
    expect(await first.service.readThread('thread', one.id)).toMatchObject({ prompt: 'one' })
    expect(await second.service.readThread('thread', two.id)).toMatchObject({ prompt: 'two' })
    await first.service.deleteThread('thread', one.id)
    expect(await first.service.listThread()).toEqual({})
    expect((await second.service.listThread()).thread).toHaveLength(1)
  })

  it('does not create definition directories while its scheduler is unavailable', async () => {
    const { home, engine, service } = await fixture()
    const state = engine.snapshot()
    vi.spyOn(engine, 'snapshot').mockReturnValue({ ...state, ready: false, error: 'fixture scheduler failure' })
    await expect(service.saveThread({ ...input, threadId: 'thread' })).rejects.toThrow('fixture scheduler failure')
    await expect(readFile(join(home, 'automations', 'fixture-task', 'automation.toml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
