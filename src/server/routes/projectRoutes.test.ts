import { createProjectAccessService } from '../projectAccessService.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readAnyJsonBody } from '../httpUtils.js'
import { readProjectDirectories } from '../projectDirectories.js'
import { createProjectRoutes } from './projectRoutes.js'

type TestResponse = {
  statusCode: number
  body: string
  headers: Record<string, string>
}

let capturedResponse: TestResponse | null = null

async function invoke(
  handler: ReturnType<typeof createProjectRoutes>,
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

describe('project routes', () => {
  let projectRoot: string

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'project-routes-'))
  })

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true })
  })

  function createHandler(overrides: Partial<Parameters<typeof createProjectAccessService>[0]> = {}) {
    return createProjectRoutes(createProjectAccessService({
      assignProjectMembership: vi.fn(),
      basename: path => path.split('/').pop() ?? '',
      isAbsolute: value => value.startsWith('/'),
      isVirtualProjectId: value => value.startsWith('virtual:'),
      readProjectDirectories,
      readProject: vi.fn(),
      renderProjectFiles: vi.fn(),
      ...overrides,
    }))
  }

  it('renders virtual project files as a no-store HTML listing', async () => {
    const renderProjectFiles = vi.fn(async (label: string, entries: Array<{ name: string; path: string }>) => {
      return `<html>${label}:${entries.map(entry => `${entry.name}|${entry.path}`).join(',')}</html>`
    })
    const handler = createHandler({
      readProject: async () => ({ label: 'Project', cwds: ['/root/project-a', '/root/project-b'] }),
      renderProjectFiles,
    })

    await expect(invoke(handler, 'GET', '/codex-api/project-files?id=virtual%3Aid')).resolves.toBe(true)

    expect(renderProjectFiles).toHaveBeenCalledWith('Project', [
      { name: 'project-a', path: '/root/project-a' },
      { name: 'project-b', path: '/root/project-b' },
    ])
    expect(capturedResponse).toEqual({
      statusCode: 200,
      body: '<html>Project:project-a|/root/project-a,project-b|/root/project-b</html>',
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    })
  })

  it('does not handle unrelated routes', async () => {
    const handler = createHandler()

    await expect(invoke(handler, 'GET', '/codex-api/unknown')).resolves.toBe(false)
    expect(capturedResponse).toBeNull()
  })

  it('returns no directories for virtual projects and reads real AGENTS.md blocks', async () => {
    await writeFile(join(projectRoot, 'AGENTS.md'), [
      '<!-- codexapp:work-directories:start -->',
      '```json',
      '["/absolute/other"]',
      '```',
      '<!-- codexapp:work-directories:end -->',
    ].join('\n'))
    const handler = createHandler()

    await invoke(handler, 'GET', `/codex-api/project-directories?path=${encodeURIComponent('virtual:project')}`)
    expect(JSON.parse(capturedResponse!.body)).toEqual({ data: [] })

    await invoke(handler, 'GET', `/codex-api/project-directories?path=${encodeURIComponent(projectRoot)}`)
    expect(JSON.parse(capturedResponse!.body)).toEqual({ data: ['/absolute/other'] })
  })

  it('rejects relative project directory paths with the existing contract', async () => {
    const handler = createHandler()

    await invoke(handler, 'GET', '/codex-api/project-directories?path=relative')

    expect(capturedResponse).toEqual({
      statusCode: 400,
      body: JSON.stringify({ error: '工作目录必须填写绝对路径' }),
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  })

  it('maps malformed AGENTS.md failures to a 400 response', async () => {
    await writeFile(join(projectRoot, 'AGENTS.md'), '<!-- codexapp:work-directories:start -->')
    const handler = createHandler()

    await invoke(handler, 'GET', `/codex-api/project-directories?path=${encodeURIComponent(projectRoot)}`)

    expect(capturedResponse?.statusCode).toBe(400)
    expect(JSON.parse(capturedResponse!.body).error).toContain('工作目录区块不完整')
  })

  it('assigns project membership and keeps unassignment explicit', async () => {
    const assignProjectMembership = vi.fn(async () => {})
    const handler = createHandler({ assignProjectMembership })

    await invoke(handler, 'POST', '/codex-api/project-membership', {
      cwd: '/projectless/thread',
      projectId: 'virtual:project',
    })
    expect(capturedResponse).toEqual({
      statusCode: 200,
      body: JSON.stringify({ ok: true }),
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
    expect(assignProjectMembership).toHaveBeenCalledWith('/projectless/thread', 'virtual:project')

    await invoke(handler, 'POST', '/codex-api/project-membership', { cwd: '/projectless/thread' })
    expect(assignProjectMembership).toHaveBeenLastCalledWith('/projectless/thread', null)
  })
})
