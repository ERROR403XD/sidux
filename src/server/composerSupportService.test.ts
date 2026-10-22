import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createComposerPromptFile, listComposerPrompts, removeComposerPromptFile } from './composerPromptService.js'
import { createRouteDispatcher, readAnyJsonBody, setJson } from './httpUtils.js'
import { createProjectDiscoveryService } from './projectDiscoveryService.js'
import { createComposerPromptRoutes } from './routes/composerPromptRoutes.js'
import { createProjectDiscoveryRoutes } from './routes/projectDiscoveryRoutes.js'
import { createTerminalRoutes } from './routes/terminalRoutes.js'
import { listTerminalQuickCommands } from './terminalQuickCommandService.js'

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, spawn: vi.fn(original.spawn) }
})

let fixture: string
let cwd: string
let base: string
let server: Server

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'sidux-composer-support-'))
  cwd = join(fixture, 'project')
  await mkdir(cwd)
  vi.stubEnv('CODEX_HOME', join(fixture, 'codex-home'))
  vi.mocked(spawn).mockClear()
  const route = createRouteDispatcher([
    createProjectDiscoveryRoutes(createProjectDiscoveryService()),
    createComposerPromptRoutes({ createPrompt: createComposerPromptFile, listPrompts: listComposerPrompts, removePrompt: removeComposerPromptFile }),
    createTerminalRoutes({ listQuickCommands: listTerminalQuickCommands, terminalManager: {} as never }),
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
  await rm(fixture, { recursive: true, force: true })
})

async function request(path: string, method = 'GET', input?: unknown) {
  const response = await fetch(base + path, { method, body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(5000) })
  return { status: response.status, body: await response.json() as any }
}

async function writeProjectFile(path: string, content = 'fixture') {
  const target = join(cwd, path)
  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, content)
}

describe('composer discovery, prompt and quick-command complete operations', () => {
  it('suggests the first unused name without creating a directory and resolves relative bases', async () => {
    await mkdir(join(cwd, 'New Project (1)'))
    await writeProjectFile('New Project (2)')
    const result = await request('/project-root-suggestion?basePath=' + encodeURIComponent(relative(process.cwd(), cwd)))
    expect(result).toEqual({ status: 200, body: { data: { name: 'New Project (3)', path: join(cwd, 'New Project (3)') } } })
    expect(await readdir(cwd)).toEqual(['New Project (1)', 'New Project (2)'])
    expect(spawn).not.toHaveBeenCalled()
  })

  it('ranks actual rg results and omits ignored, .git and node_modules files in one process per search', async () => {
    for (const path of ['alpha.ts', 'alpha.test.ts', 'src/alpha.ts', 'src/my-alpha.ts', 'alpha.ts/x.txt', 'zalpha.ts', '.hidden.txt', '.git/config', 'node_modules/alpha.ts', 'ignored/alpha.ts']) {
      // The exact basename and directory-prefix cases use separate names.
      if (path === 'alpha.ts/x.txt') continue
      await writeProjectFile(path)
    }
    await writeProjectFile('alpha-folder/x.txt')
    await writeProjectFile('.gitignore', 'ignored/\n')
    const result = await request('/composer-file-search', 'POST', { cwd, query: ' ALPHA ', limit: 100 })
    expect(result).toEqual({ status: 200, body: { data: [
      { path: 'alpha.test.ts' }, { path: 'alpha.ts' }, { path: 'src/alpha.ts' },
      { path: 'src/my-alpha.ts' }, { path: 'zalpha.ts' }, { path: 'alpha-folder/x.txt' },
    ] } })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(['--files', '--hidden', '-g', '!.git', '-g', '!node_modules'])
    expect(vi.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({ cwd })
    const exact = await request('/composer-file-search', 'POST', { cwd, query: 'alpha.ts', limit: 1.9 })
    expect(exact.body.data).toEqual([{ path: 'alpha.ts' }])
    expect(spawn).toHaveBeenCalledTimes(2)
    const empty = await request('/composer-file-search', 'POST', { cwd, query: ' ' })
    expect(empty.body.data.some((row: { path: string }) => row.path === '.hidden.txt')).toBe(true)
    expect(empty.body.data.map((row: { path: string }) => row.path)).toEqual([...empty.body.data.map((row: { path: string }) => row.path)].sort((a, b) => a.localeCompare(b)))
  })

  it('rejects invalid discovery cwd before spawning and caps the result count', async () => {
    await writeProjectFile('plain.txt')
    for (const [path, method, input, status, error] of [
      ['/composer-file-search', 'POST', {}, 400, 'Missing cwd'],
      ['/composer-file-search', 'POST', { cwd: join(cwd, 'plain.txt') }, 400, 'cwd is not a directory'],
      ['/composer-file-search', 'POST', { cwd: join(cwd, 'missing') }, 404, 'cwd does not exist'],
      ['/project-root-suggestion', 'GET', undefined, 400, 'Missing basePath'],
      ['/project-root-suggestion?basePath=' + encodeURIComponent(join(cwd, 'plain.txt')), 'GET', undefined, 400, 'basePath is not a directory'],
      ['/project-root-suggestion?basePath=' + encodeURIComponent(join(cwd, 'missing')), 'GET', undefined, 404, 'basePath does not exist'],
    ] as const) {
      expect(await request(path, method, input)).toEqual({ status, body: { error } })
    }
    expect(spawn).not.toHaveBeenCalled()
    for (let index = 0; index < 102; index++) await writeProjectFile(`file-${index}.txt`)
    expect((await request('/composer-file-search', 'POST', { cwd, limit: 999 })).body.data).toHaveLength(100)
    expect((await request('/composer-file-search', 'POST', { cwd, limit: -1 })).body.data).toHaveLength(1)
  })

  it('preserves package, Makefile and script precedence without executing discovered commands', async () => {
    await writeProjectFile('package.json', JSON.stringify({ scripts: { dev: 'exit 99', "odd'name": 'false', invalid: 42 } }))
    for (const file of ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock']) await writeProjectFile(file)
    await writeProjectFile('Makefile', 'all: build\nall: duplicate\n.PHONY: all\nVALUE := 1\nhello/world: dep\n')
    await writeProjectFile('makefile', 'lowercase: ignored\n')
    await writeProjectFile("odd'name.sh")
    await writeProjectFile('run.cmd')
    await writeProjectFile('ignored.py')
    await writeProjectFile('scripts/build.sh')
    await writeProjectFile('scripts/z.cmd')
    await mkdir(join(cwd, 'directory.sh'))
    const result = await request('/thread-terminal/quick-commands?cwd=' + encodeURIComponent(cwd))
    const values = ["pnpm run dev", "pnpm run 'odd'\\''name'", 'make all', 'make hello/world', "./'odd'\\''name.sh'", './run.cmd', './scripts/build.sh', './scripts/z.cmd']
    expect(result).toEqual({ status: 200, body: { commands: values.map((value, index) => ({ label: value, value, source: index < 2 ? 'package' : index < 4 ? 'make' : 'script' })) } })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('selects package managers by existing lockfiles and tolerates missing optional files', async () => {
    expect(await listTerminalQuickCommands(cwd)).toEqual([])
    await writeProjectFile('package.json', '{broken')
    expect(await listTerminalQuickCommands(cwd)).toEqual([])
    await writeProjectFile('package.json', '{"scripts":{"dev":"fixture"}}')
    for (const [lock, expected] of [[undefined, 'npm run dev'], ['bun.lockb', 'bun run dev'], ['yarn.lock', 'yarn dev'], ['pnpm-lock.yaml', 'pnpm run dev']] as const) {
      if (lock) await writeProjectFile(lock)
      expect(await listTerminalQuickCommands(cwd)).toEqual([{ label: expected, value: expected, source: 'package' }])
    }
    await expect(listTerminalQuickCommands(join(cwd, 'package.json'))).rejects.toThrow('Terminal cwd is not a directory')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('creates collision-safe sequential prompt names and preserves stored bytes, description and list order', async () => {
    expect(await listComposerPrompts()).toEqual([])
    const content = '\n  ' + 'x'.repeat(130) + '\nsecond\n '
    const first = await request('/prompts', 'POST', { name: '  A:B.MD ', content })
    const prompt = first.body.data
    expect(first.status).toBe(200)
    expect(basename(prompt.path)).toBe('A B.md')
    expect(prompt).toMatchObject({ name: 'A B', content: content.trim() + '\n', description: 'x'.repeat(120) })
    expect(await readFile(prompt.path, 'utf8')).toBe(prompt.content)
    const second = await request('/prompts', 'POST', { name: 'A:B', content: 'next' })
    expect(basename(second.body.data.path)).toBe('A B-2.md')
    expect(await readFile(prompt.path, 'utf8')).toBe(prompt.content)
    const dir = join(fixture, 'codex-home', 'prompts')
    await writeFile(join(dir, 'ignored.txt'), 'ignore')
    await mkdir(join(dir, 'folder.md'))
    await writeFile(join(dir, 'Z.MD'), '\n # Heading\nbody')
    const listed = await request('/prompts')
    expect(listed.body.data.map((row: { name: string }) => row.name)).toEqual(['A B', 'A B-2', 'Z'])
    expect(listed.body.data[2].description).toBe('# Heading')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('keeps prompt validation and removal boundaries, returning false for a repeated removal', async () => {
    expect((await request('/prompts', 'POST', { name: ' ', content: 'body' })).status).toBe(400)
    await expect(createComposerPromptFile('a', ' ')).rejects.toThrow('Prompt content is required')
    const prompt = await createComposerPromptFile(':*?', 'body')
    expect(prompt.name).toBe('prompt')
    const outside = join(fixture, 'outside.md')
    await writeFile(outside, 'keep')
    expect((await request('/prompts?path=' + encodeURIComponent(outside), 'DELETE')).status).toBe(400)
    expect(await readFile(outside, 'utf8')).toBe('keep')
    expect(await removeComposerPromptFile(prompt.path)).toBe(true)
    expect((await request('/prompts?path=' + encodeURIComponent(prompt.path), 'DELETE')).body).toEqual({ data: { removed: false } })
    expect(await listComposerPrompts()).toEqual([])
  })
})
