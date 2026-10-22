import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRouteDispatcher, readAnyJsonBody, setJson } from './httpUtils.js'
import { createLocalDirectoryService } from './localDirectoryService.js'
import { createProjectAccessService } from './projectAccessService.js'
import { saveProjectDirectories } from './projectDirectories.js'
import { createLocalDirectoryRoutes } from './routes/localDirectoryRoutes.js'
import { createProjectRoutes } from './routes/projectRoutes.js'
import { getVirtualProjectStore } from './workspaceStateService.js'

let fixture: string
let base: string
let server: Server

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'sidux-project-access-'))
  vi.stubEnv('CODEX_HOME', join(fixture, 'codex-home'))
  const routes = createRouteDispatcher([
    createProjectRoutes(createProjectAccessService()),
    createLocalDirectoryRoutes(createLocalDirectoryService()),
  ])
  server = createServer((req, res) => {
    void routes(req, res, new URL(req.url ?? '/', 'http://localhost'), { readJsonBody: readAnyJsonBody }).then(handled => {
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
  await rm(fixture, { recursive: true, force: true })
})

async function post(path: string, input: unknown) {
  const response = await fetch(base + path, { method: 'POST', body: JSON.stringify(input), signal: AbortSignal.timeout(5000) })
  return { status: response.status, body: await response.json() as any }
}

describe('project access and local directory HTTP/filesystem/store operations', () => {
  it('renders actual virtual membership as escaped HTML without changing local files', async () => {
    const project = await getVirtualProjectStore().save(undefined, 'Fixture <script>')
    const cwd = join(fixture, 'Documents', 'Codex', '2026-10-11', 'folder & name')
    await mkdir(cwd, { recursive: true })
    await writeFile(join(cwd, 'keep.txt'), 'keep')
    expect(await post('/project-membership', { cwd, projectId: project.id })).toEqual({ status: 200, body: { ok: true } })
    const response = await fetch(base + '/project-files?id=' + encodeURIComponent(project.id))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const html = await response.text()
    expect(html).toContain('Fixture &lt;script&gt;')
    expect(html).toContain('folder &amp; name')
    expect(html).toContain('/codex-local-browse' + encodeURI(cwd).replace(/&/g, '&amp;'))
    expect(await readFile(join(cwd, 'keep.txt'), 'utf8')).toBe('keep')
    expect(await post('/project-membership', { cwd })).toEqual({ status: 200, body: { ok: true } })
    expect((await getVirtualProjectStore().get(project.id)).cwds).toEqual([])
    expect(await readFile(join(cwd, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('reads real AGENTS blocks, rejects malformed/relative inputs and bypasses files for virtual projects', async () => {
    const root = join(fixture, 'root')
    const extra = join(fixture, 'extra')
    await mkdir(root)
    await mkdir(extra)
    await saveProjectDirectories(root, [extra])
    const read = async (path: string) => {
      const response = await fetch(base + '/project-directories?path=' + encodeURIComponent(path))
      return { status: response.status, body: await response.json() }
    }
    expect(await read(root)).toEqual({ status: 200, body: { data: [extra] } })
    expect(await read('virtual:00000000-0000-0000-0000-000000000000')).toEqual({ status: 200, body: { data: [] } })
    expect(await read('relative')).toEqual({ status: 400, body: { error: '工作目录必须填写绝对路径' } })
    await writeFile(join(root, 'AGENTS.md'), '<!-- codexapp:work-directories:start -->')
    const malformed = await read(root)
    expect(malformed.status).toBe(400)
    expect(malformed.body).toMatchObject({ error: expect.stringContaining('工作目录区块不完整') })
  })

  it('creates relative and absolute directories, preserves reused files and propagates mkdir errors', async () => {
    const directory = join(fixture, 'parent', 'child')
    expect(await post('/local-directory', { path: ' ' + relative(process.cwd(), directory) + ' ' })).toEqual({ status: 200, body: { data: { path: directory } } })
    expect((await stat(directory)).isDirectory()).toBe(true)
    await writeFile(join(directory, 'keep.txt'), 'keep')
    expect((await post('/local-directory', { path: directory })).status).toBe(200)
    expect(await readFile(join(directory, 'keep.txt'), 'utf8')).toBe('keep')
    expect(await post('/local-directory', { path: join(directory, 'keep.txt') })).toEqual({ status: 400, body: { error: 'Path exists but is not a directory' } })
    expect((await post('/local-directory', { path: join(directory, 'keep.txt', 'child') })).status).toBe(502)
    expect(await post('/local-directory', {})).toEqual({ status: 400, body: { error: 'Missing path' } })
  })
})
