import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProjectArchiveService } from './projectArchiveService.js'
import { parseStoredProjectZip } from './projectArchiveCodec.js'
import { mergeImportedThreadsIntoThreadListResult, registerImportedSessionsInStateDb } from './importedSessionService.js'
import { createProjectConversationDirectory } from './projectDirectoryService.js'
import { getVirtualProjectStore, createWorkspaceService } from './workspaceStateService.js'
import { createProjectArchiveRoutes } from './routes/projectArchiveRoutes.js'
import { readAnyJsonBody, setJson } from './httpUtils.js'

vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), homedir: () => fixtureHome }))
const exec = promisify(execFile)
let fixtureHome: string
let home: string
let source: string
let parent: string
let base: string
let server: Server
let invalidations: number
const updatedAtMs = Date.parse('2026-10-09T12:00:00Z')
const fileBytes = Buffer.from([0, 255, 42, 13, 10, 128])

function session(cwd: string, id = 'source-thread') {
  return [
    { timestamp: '2026-10-08T00:00:00Z', type: 'session_meta', payload: { id, cwd, source: 'cli', model: 'fixture-model', model_provider: 'openai', cli_version: 'fixture-cli' } },
    { timestamp: '2026-10-09T00:00:00Z', type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: 'Fixture prompt' }] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n'
}

beforeEach(async () => {
  fixtureHome = await mkdtemp(join(tmpdir(), 'sidux-project-archive-'))
  home = join(fixtureHome, 'codex-home')
  source = join(fixtureHome, 'project')
  parent = join(fixtureHome, 'import-parent')
  const bin = join(fixtureHome, 'bin')
  for (const path of [home, source, parent, bin]) await mkdir(path)
  await copyFile(resolve('src/server/fixtures/sqlite-cli-fixture.py'), join(bin, 'sqlite3'))
  await chmod(join(bin, 'sqlite3'), 0o700)
  vi.stubEnv('CODEX_HOME', home)
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
  await writeFile(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'synthetic-fixture' } }))
  invalidations = 0
  const route = createProjectArchiveRoutes(createProjectArchiveService(() => { invalidations++ }))
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

async function exportZip(cwd = source, method = 'GET') {
  return fetch(`${base}/project-zip?cwd=${encodeURIComponent(cwd)}`, { method, signal: AbortSignal.timeout(5000) })
}

async function importZip(buffer: Buffer) {
  const response = await fetch(`${base}/project-import?parent=${encodeURIComponent(parent)}`, { method: 'POST', body: Uint8Array.from(buffer), signal: AbortSignal.timeout(5000) })
  return { status: response.status, body: await response.json() as any }
}

describe.skipIf(process.platform === 'win32')('project archive real HTTP/file/ZIP/SQLite pipeline', () => {
  it('round-trips files, ignored paths, rewritten sessions, title/time metadata and native list supplementation', async () => {
    await exec('git', ['init', source])
    await writeFile(join(source, '.gitignore'), 'ignored.txt\n')
    await writeFile(join(source, 'ignored.txt'), 'ignored')
    await mkdir(join(source, 'node_modules'))
    await writeFile(join(source, 'node_modules', 'ignored'), 'ignored')
    await writeFile(join(source, 'file.bin'), fileBytes)
    await mkdir(join(home, 'sessions'))
    const rollout = join(home, 'sessions', 'fixture.jsonl')
    await writeFile(rollout, session(source))
    await registerImportedSessionsInStateDb([{ id: 'source-thread', path: rollout, cwd: source, title: "Database 'title'", createdAtMs: updatedAtMs - 1000, updatedAtMs, model: 'fixture-model', modelProvider: 'openai', cliVersion: 'fixture-cli', firstUserMessage: 'Fixture prompt' }])
    const head = await exportZip(source, 'HEAD')
    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toBe('application/zip')
    expect((await head.arrayBuffer()).byteLength).toBe(0)
    const response = await exportZip()
    expect(response.status).toBe(200)
    const zip = Buffer.from(await response.arrayBuffer())
    const zipPath = join(fixtureHome, 'export.zip')
    await writeFile(zipPath, zip)
    const external = await exec('/usr/bin/python3', ['-c', 'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps(z.namelist()))', zipPath])
    const names = JSON.parse(external.stdout) as string[]
    expect(names).toContain('file.bin')
    expect(names).toContain('.codex-project/chats/sessions/fixture.jsonl')
    expect(names.some(name => name.startsWith('.git/') || name.startsWith('node_modules/') || name === 'ignored.txt')).toBe(false)
    const first = await importZip(zip)
    expect(first.status).toBe(200)
    const importedPath = first.body.data.path
    expect(await readFile(join(importedPath, 'file.bin'))).toEqual(fileBytes)
    expect(first.body.data.importedSessions).toBe(1)
    const sessionFiles = await readdir(join(home, 'sessions', 'imported'))
    const importedRaw = await readFile(join(home, 'sessions', 'imported', sessionFiles[0]!), 'utf8')
    const rows = importedRaw.trim().split('\n').map(row => JSON.parse(row))
    const meta = rows[0].payload
    expect(meta).toMatchObject({ cwd: importedPath, imported: true, source: 'cli', model: 'fixture-model', model_provider: 'openai', originator: 'codex_cli_rs' })
    expect(meta.id).not.toBe('source-thread')
    expect(rows.some(row => row.type === 'event_msg' && row.payload.type === 'user_message')).toBe(true)
    const supplemented = await mergeImportedThreadsIntoThreadListResult({ data: [] }, {}) as any
    expect(supplemented.data.find((thread: any) => thread.id === meta.id)).toMatchObject({ cwd: importedPath, preview: "Database 'title'", updatedAt: Math.floor(updatedAtMs / 1000) })
    const second = await importZip(zip)
    expect(second.body.data.path).toBe(`${importedPath}-2`)
    expect(invalidations).toBe(2)
    expect((await createWorkspaceService().readState()).order).toEqual([second.body.data.path, importedPath])
  })

  it('round-trips virtual project member roots and registers imported conversations in the new project', async () => {
    const project = await getVirtualProjectStore().save(undefined, 'Virtual fixture')
    const first = await createProjectConversationDirectory('First', project.id)
    const second = await createProjectConversationDirectory('Second', project.id)
    await writeFile(join(first.cwd, 'first.txt'), 'first')
    await writeFile(join(second.cwd, 'second.txt'), 'second')
    await mkdir(join(home, 'sessions'))
    await writeFile(join(home, 'sessions', 'virtual.jsonl'), session(first.cwd, 'virtual-thread'))
    const response = await exportZip(project.id)
    const zip = Buffer.from(await response.arrayBuffer())
    const names = parseStoredProjectZip(zip).map(entry => entry.path)
    expect(names).toContain('files/000001/first.txt')
    expect(names).toContain('files/000002/second.txt')
    const imported = await importZip(zip)
    expect(imported.status).toBe(200)
    expect(imported.body.data.path).not.toBe(project.id)
    const restored = await getVirtualProjectStore().get(imported.body.data.path)
    expect(restored.cwds).toHaveLength(2)
    expect(await readFile(join(restored.cwds[0]!, 'first.txt'), 'utf8')).toBe('first')
    expect(await readFile(join(restored.cwds[1]!, 'second.txt'), 'utf8')).toBe('second')
    const importedFile = (await readdir(join(home, 'sessions', 'imported')))[0]!
    const meta = JSON.parse((await readFile(join(home, 'sessions', 'imported', importedFile), 'utf8')).split('\n')[0]!).payload
    expect(restored.cwds).toContain(meta.cwd)
    expect((await createWorkspaceService().readState()).projectOrder).toContain(restored.id)
    expect(invalidations).toBe(1)
  })

  it('rejects malformed/unsafe archives before registering a project and keeps parent validation mappings', async () => {
    expect((await importZip(Buffer.from('bad zip'))).status).toBe(400)
    expect((await importZip(Buffer.alloc(0))).body).toEqual({ error: 'Missing project ZIP' })
    await writeFile(join(source, 'file.bin'), fileBytes)
    const zip = Buffer.from(await (await exportZip()).arrayBuffer())
    const unsafe = Buffer.from(zip.toString('binary').replaceAll('file.bin', '../a.bin'), 'binary')
    expect((await importZip(unsafe)).body).toEqual({ error: 'Project ZIP contains an unsafe path' })
    expect(await readdir(parent)).toEqual([])
    expect((await createWorkspaceService().readState()).order).toEqual([])
    expect(invalidations).toBe(0)
    expect((await fetch(`${base}/project-import`, { method: 'POST' })).status).toBe(400)
    expect((await fetch(`${base}/project-import?parent=${encodeURIComponent(join(parent, 'missing'))}`, { method: 'POST', body: zip })).status).toBe(404)
  })
})
