import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitRoutes } from './gitRoutes.js'
import { createGitWorkspaceService } from '../gitWorkspaceService.js'

const execFileAsync = promisify(execFile)
type TestResponse = { statusCode: number; body: string; headers: Record<string, string> }
let capturedResponse: TestResponse | null = null
let root: string

function createHandler() {
  return createGitRoutes(createGitWorkspaceService({
    getCodexHomeDir: () => join(root, 'home'),
    persistWorkspaceRoot: async () => {},
  }))
}

async function invoke(handler: ReturnType<typeof createGitRoutes>, method: string, pathname: string): Promise<boolean> {
  const request = new PassThrough()
  Object.defineProperty(request, 'method', { value: method })
  Object.defineProperty(request, 'url', { value: '' })
  request.end()
  const headers: Record<string, string> = {}
  const response = {
    statusCode: 200,
    setHeader: (name: string, value: string) => { headers[name] = value },
    end: (chunk?: unknown) => { capturedResponse = { statusCode: response.statusCode, body: String(chunk ?? ''), headers } },
  } as unknown as ServerResponse
  capturedResponse = null
  return handler(request as never as IncomingMessage, response, new URL(pathname, 'http://localhost'), { readJsonBody: async () => null })
}

function responseJson() {
  return JSON.parse(capturedResponse?.body ?? '{}')
}

beforeEach(async () => {
  root = (await mkdtemp(join(tmpdir(), 'git-routes-'))) as string
  await execFileAsync('git', ['init'], { cwd: root })
  await writeFile(join(root, 'file.txt'), 'fixture\n')
  await execFileAsync('git', ['add', 'file.txt'], { cwd: root })
  await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial'], { cwd: root })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('git routes', () => {
  it('reads repository status and branch activity', async () => {
    const handler = createHandler()
    expect(await invoke(handler, 'GET', `/codex-api/git/repository-status?cwd=${encodeURIComponent(root)}`)).toBe(true)
    expect(capturedResponse?.statusCode).toBe(200)
    expect(responseJson()).toEqual({ data: { isGitRepo: true, gitRoot: root } })
    expect(await invoke(handler, 'GET', `/codex-api/git/branches?cwd=${encodeURIComponent(root)}`)).toBe(true)
    const branch = responseJson().data.options.at(0)
    expect(branch).toMatchObject({ isCurrent: true, isRemote: false, label: branch.value })
    expect(branch.value).toMatch(/^main$|^master$/)
  })

  it('returns missing-cwd, non-directory, and non-repository contracts', async () => {
    const handler = createHandler()
    await invoke(handler, 'GET', '/codex-api/git/branches')
    expect(capturedResponse).toMatchObject({ statusCode: 400, body: JSON.stringify({ error: 'Missing cwd' }) })
    await invoke(handler, 'GET', `/codex-api/git/repository-status?cwd=${encodeURIComponent(join(root, 'missing'))}`)
    expect(capturedResponse).toMatchObject({ statusCode: 404, body: JSON.stringify({ error: 'cwd does not exist' }) })
    await writeFile(join(root, 'file'), 'x')
    await invoke(handler, 'GET', `/codex-api/git/branches?cwd=${encodeURIComponent(join(root, 'file'))}`)
    expect(capturedResponse).toMatchObject({ statusCode: 400, body: JSON.stringify({ error: 'cwd is not a directory' }) })
    const nonGit = (await mkdir(join(tmpdir(), `non-git-${process.pid}-${Date.now()}`), { recursive: true })) as string
    await invoke(handler, 'GET', `/codex-api/git/repository-status?cwd=${encodeURIComponent(nonGit)}`)
    expect(capturedResponse).toMatchObject({ statusCode: 200, body: JSON.stringify({ data: { isGitRepo: false, gitRoot: '' } }) })
    await invoke(handler, 'GET', `/codex-api/git/branches?cwd=${encodeURIComponent(nonGit)}`)
    expect(capturedResponse).toMatchObject({ statusCode: 200, body: JSON.stringify({ data: { currentBranch: null, options: [] } }) })
    expect(await invoke(handler, 'GET', '/codex-api/unknown')).toBe(false)
    await rm(nonGit, { recursive: true, force: true })
  })
})
