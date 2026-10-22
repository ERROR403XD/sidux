import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readAnyJsonBody } from '../httpUtils.js'
import { saveProjectDirectories } from '../projectDirectories.js'
import { createProjectRootRoutes } from './projectRootRoutes.js'
import { createProjectRootService } from '../projectRootService.js'

type TestResponse = {
  statusCode: number
  body: string
  headers: Record<string, string>
}

let capturedResponse: TestResponse | null = null
let projectHome: string

async function invoke(
  handler: ReturnType<typeof createProjectRootRoutes>,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<boolean> {
  const request = new PassThrough()
  Object.defineProperty(request, 'method', { value: method })
  Object.defineProperty(request, 'url', { value: '' })
  request.end(body === undefined ? '' : JSON.stringify(body))
  const headers: Record<string, string> = {}
  const response = {
    statusCode: 200,
    setHeader: (name: string, value: string) => { headers[name] = value },
    end: (chunk?: unknown) => {
      capturedResponse = {
        statusCode: response.statusCode,
        body: typeof chunk === 'string' ? chunk : '',
        headers,
      }
    },
  } as unknown as ServerResponse
  capturedResponse = null
  return handler(request as never as IncomingMessage, response, new URL(pathname, 'http://localhost'), {
    readJsonBody: () => readAnyJsonBody(request as never as IncomingMessage),
  })
}

function createHandler(overrides: Partial<NonNullable<Parameters<typeof createProjectRootService>[0]>> = {}) {
  return createProjectRootRoutes(createProjectRootService({
    isAbsolute: value => value.startsWith('/'),
    isVirtualProjectId: value => value.startsWith('virtual:'),
    mkdir: async path => { await mkdir(path, { recursive: true }); return undefined },
    persistWorkspaceRoot: vi.fn(),
    queueWorkspaceRootsMutation: async <T>(mutation: () => Promise<T>) => mutation(),
    saveProjectDirectories,
    removeVirtualProject: async () => {},
    saveVirtualProject: async () => ({ id: 'virtual:project', label: '', cwds: [] }),
    stat: async () => createStats(true),
    resolve: value => `/resolved/${value}`,
    updateWorkspaceRootsState: vi.fn(),
    ...overrides,
  }))
}

describe('project root routes', () => {
  beforeEach(async () => {
    projectHome = await mkdtemp(join(tmpdir(), 'project-root-routes-'))
  })

  afterEach(async () => {
    await rm(projectHome, { recursive: true, force: true })
  })

  it('creates virtual projects and prepends them to project order', async () => {
    const project = { id: 'virtual:project', label: 'Project', cwds: [] }
    let capturedState = { projectOrder: ['existing', 'virtual:project'] }
    const handler = createHandler({
      saveVirtualProject: async () => project,
      updateWorkspaceRootsState: async updater => {
        capturedState = updater(capturedState)
      },
    })

    const handled = await invoke(handler, 'POST', '/codex-api/project-root', { label: 'Project' })

    expect(handled).toBe(true)
    expect(capturedResponse).toEqual({
      statusCode: 200,
      body: JSON.stringify({ data: { path: project.id } }),
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
    expect(capturedState.projectOrder).toEqual([project.id, 'existing'])
  })

  it('removes virtual projects and filters their project order entry', async () => {
    const removeVirtualProject = vi.fn()
    let capturedState = { projectOrder: ['virtual:project', 'existing'] }
    const handler = createHandler({
      removeVirtualProject,
      updateWorkspaceRootsState: async updater => {
        capturedState = updater(capturedState)
      },
    })

    const handled = await invoke(handler, 'DELETE', '/codex-api/project-root?id=virtual%3Aproject')

    expect(handled).toBe(true)
    expect(capturedResponse).toEqual({
      statusCode: 200,
      body: JSON.stringify({ ok: true }),
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
    expect(removeVirtualProject).toHaveBeenCalledWith('virtual:project')
    expect(capturedState.projectOrder).toEqual(['existing'])
  })

  it('creates missing real roots, saves directories, and persists the root', async () => {
    const projectPath = join(projectHome, 'project')
    const workPath = join(projectHome, 'work')
    const persistWorkspaceRoot = vi.fn()
    const saveVirtualProject = vi.fn()
    const stat = vi.fn(async () => { throw new Error('missing') })
    const handler = createHandler({
      mkdir: async path => {
        if (path !== projectPath) throw new Error(`unexpected directory: ${path}`)
        await mkdir(projectPath, { recursive: true })
        await mkdir(workPath, { recursive: true })
        return undefined
      },
      persistWorkspaceRoot,
      saveVirtualProject,
      stat,
    })

    const handled = await invoke(handler, 'POST', '/codex-api/project-root', {
      path: projectPath,
      createIfMissing: true,
      label: 'Project',
      directories: [workPath],
    })

    expect(handled).toBe(true)
    expect(capturedResponse).toEqual({
      statusCode: 200,
      body: JSON.stringify({ data: { path: projectPath } }),
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
    expect(saveVirtualProject).not.toHaveBeenCalled()
    expect(persistWorkspaceRoot).toHaveBeenCalledWith(projectPath, 'Project')
    expect(await readIfPossible(join(projectPath, 'AGENTS.md'))).toContain(JSON.stringify([workPath], null, 2))
  })

  it('rejects non-directories and missing roots without creation', async () => {
    const handler = createHandler({
      stat: async path => {
        if (path === '/project/missing') throw new Error('missing')
        return createStats(false)
      },
      mkdir: vi.fn(async () => { throw new Error('must not create') }),
      persistWorkspaceRoot: vi.fn(),
    })

    await invoke(handler, 'POST', '/codex-api/project-root', { path: '/project/file', createIfMissing: true })
    expect(JSON.parse(capturedResponse!.body)).toEqual({ error: 'Path exists but is not a directory' })
    expect(capturedResponse!.statusCode).toBe(400)

    await invoke(handler, 'POST', '/codex-api/project-root', { path: '/project/missing' })
    expect(capturedResponse!.headers).toEqual({ 'Content-Type': 'application/json; charset=utf-8' })
    expect(capturedResponse!.statusCode).toBe(404)
    expect(JSON.parse(capturedResponse!.body)).toEqual({ error: 'Directory does not exist' })
  })
})

async function readIfPossible(path: string): Promise<string | null> {
  try {
    const { readFile } = await import('node:fs/promises')
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

function createStats(isDirectory: boolean) {
  return { isDirectory: () => isDirectory } as unknown as import('node:fs').Stats
}
