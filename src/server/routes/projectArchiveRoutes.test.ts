import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Stats } from 'node:fs'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { readAnyJsonBody, setJson } from '../httpUtils.js'
import { createProjectArchiveRoutes } from './projectArchiveRoutes.js'
import { createProjectArchiveService } from '../projectArchiveService.js'

type TestResponse = {
  statusCode: number
  body: string
  headers: Record<string, string>
  chunks: string[]
  destroyed?: Error
}

let capturedResponse: TestResponse | null = null

async function invoke(
  handler: ReturnType<typeof createProjectArchiveRoutes>,
  method: string,
  pathname: string,
  body?: Buffer,
): Promise<boolean> {
  const request = new PassThrough()
  Object.defineProperty(request, 'method', { value: method })
  Object.defineProperty(request, 'url', { value: '' })
  request.end(body ?? '')
  const headers: Record<string, string> = {}
  const response = {
    statusCode: 200,
    setHeader: (name: string, value: string) => { headers[name] = value },
    end: (chunk?: unknown) => {
      capturedResponse = {
        statusCode: response.statusCode,
        body: typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '',
        headers,
        chunks: [...(capturedResponse?.chunks ?? []), ...(typeof chunk === 'string' ? [chunk] : Buffer.isBuffer(chunk) ? [chunk.toString('utf8')] : [])],
      }
    },
    write: () => true,
    destroy: (error?: Error) => { capturedResponse!.destroyed = error },
  } as unknown as ServerResponse
  capturedResponse = null
  return handler(request as never as IncomingMessage, response, new URL(pathname, 'http://localhost'), {
    readJsonBody: () => readAnyJsonBody(request as never as IncomingMessage),
  })
}

type ArchiveDependencies = NonNullable<Parameters<typeof createProjectArchiveService>[1]>
  & NonNullable<Parameters<typeof createProjectArchiveRoutes>[1]>
  & { invalidateThreadSearch: () => void }

function defaultDependencies(): ArchiveDependencies {
  return {
    collectProjectChatZipEntries: vi.fn(async () => []),
    getErrorCode: () => null,
    importProjectZip: vi.fn(async () => ({ projectPath: '/parent/project', importedSessions: 1 })),
    invalidateThreadSearch: vi.fn(),
    isAbsolute: value => value.startsWith('/'),
    isVirtualProjectId: value => value.startsWith('virtual:'),
    readProject: vi.fn(async () => ({ id: 'virtual:project', label: 'Project', cwds: ['/project'] })),
    readRawBody: async () => Buffer.from('zip'),
    resolve: value => `/resolved/${value}`,
    resolveAllowedProjectZipCwd: async value => `/real/${value}`,
    setProjectZipHeaders: (response, fileName) => {
      response.statusCode = 200
      response.setHeader('Content-Type', 'application/zip')
      response.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
    },
    stat: async () => ({ isDirectory: () => true }) as Stats,
    streamProjectZip: async (_root, response) => {
      response.write('zip-stream')
      response.end()
    },
    toProjectZipFileName: value => `${value}.zip`,
  }
}

function createHandler(overrides: Partial<ReturnType<typeof defaultDependencies>> = {}) {
  const dependencies = { ...defaultDependencies(), ...overrides }
  return createProjectArchiveRoutes(createProjectArchiveService(dependencies.invalidateThreadSearch, dependencies), {
    readRawBody: dependencies.readRawBody,
    setProjectZipHeaders: dependencies.setProjectZipHeaders,
  })
}

describe('project archive routes', () => {
  it('exports virtual projects with resolved roots and virtual chat entries', async () => {
    const entries = [{ path: '.codex-project/chats/session.jsonl', data: Buffer.from('session'), mtime: new Date(0) }]
    const handler = createHandler({
      collectProjectChatZipEntries: vi.fn(async () => entries),
      resolveAllowedProjectZipCwd: async value => `/real/${value}`,
      streamProjectZip: vi.fn(async (root, response, virtualEntries, roots) => {
        expect(root).toBe('')
        expect(virtualEntries).toEqual(entries)
        expect(roots).toEqual([{ root: '/real//project', prefix: 'files/000001/' }])
        response.end('zip-stream')
      }),
    })

    const handled = await invoke(handler, 'GET', '/codex-api/project-zip?cwd=virtual%3Aproject')

    expect(handled).toBe(true)
    expect(capturedResponse).toMatchObject({
      statusCode: 200,
      chunks: ['zip-stream'],
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="Project.zip"',
      },
    })
  })

  it('validates real project export paths and maps validation failures', async () => {
    const handler = createHandler({
      resolveAllowedProjectZipCwd: async () => { throw Object.assign(new Error('cwd is not a directory'), { code: undefined }) },
    })
    await invoke(handler, 'GET', '/codex-api/project-zip?cwd=/project')
    expect(capturedResponse?.statusCode).toBe(400)
    expect(JSON.parse(capturedResponse!.body)).toEqual({ error: 'cwd is not a directory' })

    const missing = createHandler({
      resolveAllowedProjectZipCwd: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) },
      getErrorCode: error => (error as NodeJS.ErrnoException).code ?? null,
    })
    await invoke(missing, 'GET', '/codex-api/project-zip?cwd=/missing')
    expect(missingResponse()).toEqual({ statusCode: 404, body: JSON.stringify({ error: 'cwd does not exist' }) })

    await invoke(createHandler(), 'GET', '/codex-api/project-zip')
    expect(missingResponse()).toEqual({ statusCode: 400, body: JSON.stringify({ error: 'Missing cwd' }) })
  })

  it('imports a non-empty project ZIP and invalidates search after success', async () => {
    const importProjectZip = vi.fn(async () => ({ projectPath: '/parent/imported', importedSessions: 2 }))
    const invalidateThreadSearch = vi.fn()
    const handler = createHandler({ importProjectZip, invalidateThreadSearch })

    const handled = await invoke(
      handler,
      'POST',
      '/codex-api/project-import?parent=/parent',
      Buffer.from('zip'),
    )

    expect(handled).toBe(true)
    expect(importProjectZip).toHaveBeenCalledWith(Buffer.from('zip'), '/parent')
    expect(invalidateThreadSearch).toHaveBeenCalledWith()
    expect(capturedResponse).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({ data: { path: '/parent/imported', importedSessions: 2 } }),
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  })

  it('rejects missing, non-directory, or empty import parents and bodies', async () => {
    await invoke(createHandler(), 'POST', '/codex-api/project-import')
    expect(lastJson()).toEqual({ statusCode: 400, body: { error: 'Missing parent' } })

    await invoke(createHandler({
      stat: async () => ({ isDirectory: () => false }) as Stats,
    }), 'POST', '/codex-api/project-import?parent=/file')
    expect(lastJson()).toEqual({ statusCode: 400, body: { error: 'Destination folder is not a directory' } })

    await invoke(createHandler({
      stat: async () => { throw new Error('missing') },
    }), 'POST', '/codex-api/project-import?parent=/missing')
    expect(lastJson()).toEqual({ statusCode: 404, body: { error: 'Destination folder does not exist' } })

    await invoke(createHandler({ readRawBody: async () => Buffer.alloc(0) }), 'POST', '/codex-api/project-import?parent=/parent')
    expect(lastJson()).toEqual({ statusCode: 400, body: { error: 'Missing project ZIP' } })
  })
})

function missingResponse() {
  const response = capturedResponse
  expect(response).toBeDefined()
  return {
    statusCode: response!.statusCode,
    body: response!.body,
  }
}

function lastJson() {
  const response = capturedResponse
  expect(response).toBeDefined()
  return { statusCode: response!.statusCode, body: JSON.parse(response!.body) }
}
