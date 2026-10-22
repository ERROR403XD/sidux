import { createPreferencesService } from './preferencesService.js'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRouteDispatcher, readAnyJsonBody, setJson } from './httpUtils.js'
import { createProjectRootService } from './projectRootService.js'
import { createProjectRootRoutes } from './routes/projectRootRoutes.js'
import { createWorkspaceRoutes } from './routes/workspaceRoutes.js'
import { createPreferencesRoutes } from './routes/preferencesRoutes.js'
import { createWorkspaceService, getVirtualProjectStore, queueWorkspaceRootsMutation } from './workspaceStateService.js'

let home: string
let server: Server
let base: string
let requestCount: number
let invalidations: number
const remote = { id: 'remote-id', hostId: 'host', remotePath: '/remote', label: 'Remote' }

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'sidux-workspace-service-'))
  vi.stubEnv('CODEX_HOME', home)
  await writeFile(join(home, '.codex-global-state.json'), JSON.stringify({ unrelated: 'keep', 'remote-projects': [remote] }))
  requestCount = 0
  invalidations = 0
  const route = createRouteDispatcher([
    createWorkspaceRoutes(createWorkspaceService()),
    createProjectRootRoutes(createProjectRootService()),
    createPreferencesRoutes(createPreferencesService({ mutateGlobalState: queueWorkspaceRootsMutation, invalidateThreadSearch: () => { invalidations++ } })),
  ])
  server = createServer((req, res) => {
    requestCount++
    void route(req, res, new URL(req.url ?? '/', 'http://localhost'), { readJsonBody: readAnyJsonBody }).then(handled => {
      if (!handled) setJson(res, 404, { error: 'Unhandled' })
    }).catch(error => setJson(res, 502, { error: error.message }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/codex-api`
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000) })
  return { status: response.status, body: await response.json() as any }
}

async function persisted() {
  return JSON.parse(await readFile(join(home, '.codex-global-state.json'), 'utf8'))
}

describe('workspace/project root HTTP/filesystem/transaction contracts', () => {
  it('creates real roots and AGENTS directories before persisting labels and order', async () => {
    const project = join(home, 'project')
    const related = join(home, 'related')
    await mkdir(related)
    expect(await request('/project-root', 'POST', { path: project, createIfMissing: true, label: ' Fixture ', directories: [related] })).toEqual({ status: 200, body: { data: { path: project } } })
    expect((await stat(project)).isDirectory()).toBe(true)
    expect(await readFile(join(project, 'AGENTS.md'), 'utf8')).toContain(JSON.stringify([related], null, 2))
    expect(await persisted()).toMatchObject({ unrelated: 'keep', 'electron-saved-workspace-roots': [project], 'active-workspace-roots': [project], 'electron-workspace-root-labels': { [project]: 'Fixture' }, 'project-order': [project], 'remote-projects': [remote] })
    expect(requestCount).toBe(1)
  })

  it('shares the global-state transaction with preferences and parallel root registration', async () => {
    const first = join(home, 'first')
    const second = join(home, 'second')
    const results = await Promise.all([
      request('/project-root', 'POST', { path: first, createIfMissing: true }),
      request('/project-root', 'POST', { path: second, createIfMissing: true }),
      request('/thread-titles', 'PUT', { id: 'thread', title: 'Fixture' }),
      request('/thread-pins', 'PUT', { threadIds: ['thread'] }),
    ])
    expect(results.every(result => result.status === 200)).toBe(true)
    const state = await persisted()
    expect(new Set(state['electron-saved-workspace-roots'])).toEqual(new Set([first, second]))
    expect(new Set(state['project-order'])).toEqual(new Set([first, second]))
    expect(state).toMatchObject({ unrelated: 'keep', 'thread-titles': { titles: { thread: 'Fixture' } }, 'pinned-thread-ids': ['thread'], 'remote-projects': [remote] })
    expect(requestCount).toBe(4)
    expect(invalidations).toBe(1)
  })

  it('persists virtual creation/rename/deletion and keeps virtual labels in their store', async () => {
    const created = await request('/project-root', 'POST', { label: 'Virtual fixture' })
    expect(created.status).toBe(200)
    const id = created.body.data.path
    expect(id).toMatch(/^virtual:/)
    expect(await request('/project-root', 'POST', { path: id, label: 'Renamed' })).toEqual({ status: 200, body: { data: { path: id } } })
    const state = await createWorkspaceService().readState()
    expect(state.projectOrder).toEqual([id])
    expect(state.labels[id]).toBe('Renamed')
    expect((await persisted())['electron-workspace-root-labels']).not.toHaveProperty(id)
    expect(await request(`/project-root?id=${encodeURIComponent(id)}`, 'DELETE')).toEqual({ status: 200, body: { ok: true } })
    expect((await persisted())['project-order']).toEqual([])
    expect(await getVirtualProjectStore().list()).toEqual([])
    expect((await stat(home)).isDirectory()).toBe(true)
  })

  it('preserves server-owned remote projects and omitted projectOrder across saves and reloads', async () => {
    const project = join(home, 'project')
    await request('/project-root', 'POST', { path: project, createIfMissing: true })
    expect(await request('/workspace-roots-state', 'PUT', { order: [project, project], labels: { [project]: 'Saved' }, active: [project], remoteProjects: [] })).toEqual({ status: 200, body: { ok: true } })
    const result = await request('/workspace-roots-state')
    expect(result.body.data).toMatchObject({ order: [project], active: [project], labels: { [project]: 'Saved' }, projectOrder: [project], remoteProjects: [remote] })
    expect(await createWorkspaceService().readState()).toEqual(result.body.data)
    expect((await persisted()).unrelated).toBe('keep')
    expect(requestCount).toBe(3)
  })

  it.skipIf(process.platform === 'win32')('keeps canonical path label precedence for symlink roots', async () => {
    const root = join(home, 'root')
    const alias = join(home, 'alias')
    await mkdir(root)
    await symlink(root, alias)
    const response = await request('/workspace-roots-state', 'PUT', { order: [alias, root], active: [alias], projectOrder: [alias, remote.id], labels: { [alias]: 'Alias', [root]: 'Canonical' } })
    expect(response.status).toBe(200)
    expect((await request('/workspace-roots-state')).body.data).toMatchObject({ order: [root], active: [root], projectOrder: [root, remote.id], labels: { [root]: 'Canonical' } })
  })

  it('keeps root and directory failure mappings without changing workspace state', async () => {
    const path = join(home, 'file')
    await writeFile(path, 'fixture')
    const original = await persisted()
    expect(await request('/project-root', 'POST', { path })).toEqual({ status: 400, body: { error: 'Path exists but is not a directory' } })
    expect((await request('/project-root', 'POST', { path: join(home, 'missing') })).status).toBe(404)
    expect((await request('/project-root?id=bad', 'DELETE')).status).toBe(400)
    expect((await request('/workspace-roots-state', 'PUT', [])).status).toBe(400)
    expect(await persisted()).toEqual(original)
    const failedRoot = join(home, 'root-with-bad-directories')
    expect((await request('/project-root', 'POST', { path: failedRoot, createIfMissing: true, directories: [join(home, 'absent')] })).status).toBe(400)
    expect((await stat(failedRoot)).isDirectory()).toBe(true)
    expect(await persisted()).toEqual(original)
  })
})
