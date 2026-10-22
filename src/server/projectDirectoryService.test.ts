import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProjectConversationRoutes } from './routes/projectConversationRoutes.js'
import { createGithubCloneRoutes } from './routes/githubCloneRoutes.js'
import { createRouteDispatcher, readAnyJsonBody, setJson } from './httpUtils.js'
import { cloneGithubRepositoryIntoBase, createAutomationProjectConversationDirectory, createProjectConversationDirectory, createProjectlessThreadDirectory } from './projectDirectoryService.js'
import { createWorkspaceService, getVirtualProjectStore } from './workspaceStateService.js'

vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  homedir: () => fixtureHome,
}))

let fixtureHome: string
let base: string
let server: Server
const exec = promisify(execFile)

beforeEach(async () => {
  fixtureHome = await mkdtemp(join(tmpdir(), 'sidux-project-directory-'))
  vi.stubEnv('CODEX_HOME', join(fixtureHome, 'codex-home'))
  const route = createRouteDispatcher([
    createProjectConversationRoutes({ createProjectConversationDirectory, createProjectlessThreadDirectory }),
    createGithubCloneRoutes({ cloneGithubRepository: cloneGithubRepositoryIntoBase }),
  ])
  server = createServer((req, res) => {
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
  await rm(fixtureHome, { recursive: true, force: true })
})

async function post(path: string, body: unknown) {
  const response = await fetch(base + path, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
  return { status: response.status, body: await response.json() as any }
}

describe('project directory HTTP/store/filesystem/git contracts', () => {
  it('allocates concurrent conversations without overwriting folders and associates the virtual project', async () => {
    const project = await getVirtualProjectStore().save(undefined, 'Fixture')
    const results = await Promise.all([0, 1].map(() => post('/projectless-thread-cwd', { prompt: 'Hello fixture', projectId: project.id })))
    expect(results.map(result => result.status)).toEqual([200, 200])
    const paths = results.map(result => result.body.data.cwd)
    expect(new Set(paths).size).toBe(2)
    for (const result of results) {
      expect(result.body.data.outputDirectory).toBe(result.body.data.cwd)
      expect(result.body.data.workspaceRoot).toBe(join(fixtureHome, 'Documents', 'Codex'))
      expect((await stat(result.body.data.cwd)).isDirectory()).toBe(true)
    }
    expect(new Set((await getVirtualProjectStore().get(project.id)).cwds)).toEqual(new Set(paths))
  })

  it('uses the bounded suffix fallback after the readable collision range and the null-prompt slug', async () => {
    const initial = await createProjectlessThreadDirectory('Fixture')
    const dateDir = join(initial.cwd, '..')
    await writeFile(join(initial.cwd, 'keep.txt'), 'keep')
    for (let index = 2; index <= 20; index++) await mkdir(join(dateDir, `fixture-${index}`))
    const next = await post('/projectless-thread-cwd', { prompt: 'Fixture' })
    expect(next.status).toBe(200)
    expect(basename(next.body.data.cwd)).toMatch(/^fixture-[a-z0-9]+-[a-f0-9]{8}$/)
    expect(await readFile(join(initial.cwd, 'keep.txt'), 'utf8')).toBe('keep')
    expect(basename((await post('/projectless-thread-cwd', {})).body.data.cwd)).toBe('new-chat')
  })

  it('preserves missing-project rejection and automation membership after project deletion', async () => {
    expect((await post('/projectless-thread-cwd', { projectId: 'virtual:missing' })).status).toBe(500)
    const project = await getVirtualProjectStore().save(undefined, 'Fixture')
    await getVirtualProjectStore().remove(project.id)
    const directory = await createAutomationProjectConversationDirectory('Automation fixture', project.id)
    expect((await stat(directory.cwd)).isDirectory()).toBe(true)
    expect(await getVirtualProjectStore().list()).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('rejects a symlink workspace root without creating conversation contents', async () => {
    const target = join(fixtureHome, 'target')
    await mkdir(target)
    await mkdir(join(fixtureHome, 'Documents'))
    await symlink(target, join(fixtureHome, 'Documents', 'Codex'))
    const response = await post('/projectless-thread-cwd', { prompt: 'Fixture' })
    expect(response).toEqual({ status: 500, body: { error: 'Projectless workspace root must be a real directory' } })
    expect(await readdir(target)).toEqual([])
  })

  it('clones through real git with a local URL rewrite and persists exactly one root', async () => {
    const source = join(fixtureHome, 'source')
    const destination = join(fixtureHome, 'destination')
    await mkdir(source)
    await mkdir(destination)
    await exec('git', ['init', '--bare', join(source, 'fixture.git')])
    // Git rewrites the normalized GitHub URL to a fixture; no network is used.
    vi.stubEnv('GIT_CONFIG_COUNT', '1')
    vi.stubEnv('GIT_CONFIG_KEY_0', `url.${source}/.insteadOf`)
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'https://github.com/local-fixture/')
    const result = await post('/github-clone', { url: 'https://github.com/local-fixture/fixture/tree/main', basePath: destination })
    expect(result).toEqual({ status: 200, body: { data: { path: join(destination, 'fixture') } } })
    expect((await stat(join(destination, 'fixture', '.git'))).isDirectory()).toBe(true)
    expect((await createWorkspaceService().readState()).order).toEqual([join(destination, 'fixture')])
    expect((await post('/github-clone', { url: 'https://github.com/local-fixture/fixture', basePath: destination })).status).toBe(400)
  })

  it('keeps clone validation/cleanup and leaves pre-existing destinations intact', async () => {
    const destination = join(fixtureHome, 'destination')
    await mkdir(destination)
    expect((await post('/github-clone', { url: 'https://example.test/repo', basePath: destination })).status).toBe(400)
    expect((await post('/github-clone', { url: 'git@github.com:fixture/repo.git', basePath: '' })).status).toBe(400)
    vi.stubEnv('GIT_CONFIG_COUNT', '1')
    vi.stubEnv('GIT_CONFIG_KEY_0', `url.${fixtureHome}/missing/.insteadOf`)
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'https://github.com/local-fixture/')
    expect((await post('/github-clone', { url: 'https://github.com/local-fixture/absent', basePath: destination })).status).toBe(400)
    await expect(stat(join(destination, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' })
    await mkdir(join(destination, 'existing'))
    await writeFile(join(destination, 'existing', 'keep.txt'), 'keep')
    expect((await post('/github-clone', { url: 'https://github.com/local-fixture/existing', basePath: destination })).status).toBe(400)
    expect(await readFile(join(destination, 'existing', 'keep.txt'), 'utf8')).toBe('keep')
    expect((await createWorkspaceService().readState()).order).toEqual([])
  })
})
