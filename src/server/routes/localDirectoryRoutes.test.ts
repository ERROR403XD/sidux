import { createLocalDirectoryService } from '../localDirectoryService.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Stats } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readAnyJsonBody } from '../httpUtils.js'
import { createLocalDirectoryRoutes } from './localDirectoryRoutes.js'

type TestResponse = {
  statusCode: number
  body: string
  headers: Record<string, string>
}

let capturedResponse: TestResponse | null = null
let testRoot: string

async function invoke(
  handler: ReturnType<typeof createLocalDirectoryRoutes>,
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

function createHandler(overrides: Partial<Parameters<typeof createLocalDirectoryService>[0]> = {}) {
  return createLocalDirectoryRoutes(createLocalDirectoryService({
    isAbsolute: value => value.startsWith('/'),
    mkdir: async path => {
      await mkdir(path, { recursive: true })
      return undefined
    },
    resolve: value => join(testRoot, value),
    stat: async path => {
      const { lstat } = await import('node:fs/promises')
      return lstat(path)
    },
    ...overrides,
  }))
}

function createStats(isDirectory: boolean): Stats {
  return { isDirectory: () => isDirectory } as unknown as Stats
}

describe('local directory routes', () => {
  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'local-directory-routes-'))
  })

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true })
  })

  it('requires a non-empty path', async () => {
    const result = await invoke(createHandler(), 'POST', '/codex-api/local-directory', { path: '  ' })

    expect(result).toBe(true)
    expect(capturedResponse).toEqual({
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing path' }),
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  })

  it('creates missing directories recursively', async () => {
    const directory = join(testRoot, 'parent', 'child')
    const result = await invoke(createHandler({
      stat: async () => { throw new Error('missing') },
    }), 'POST', '/codex-api/local-directory', { path: directory })

    expect(result).toBe(true)
    expect(capturedResponse).toEqual({
      statusCode: 200,
      body: JSON.stringify({ data: { path: directory } }),
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
    await expect((await import('node:fs/promises')).stat(directory)).resolves.toHaveProperty('isDirectory')
  })

  it('rejects existing non-directories and reuses directories', async () => {
    const file = join(testRoot, 'file')
    const directory = join(testRoot, 'directory')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, 'fixture')
    await mkdir(directory)
    const mkdirRoute = vi.fn(async () => undefined)
    const handler = createHandler({ mkdir: mkdirRoute })

    await invoke(handler, 'POST', '/codex-api/local-directory', { path: file })
    expect(capturedResponse?.statusCode).toBe(400)
    expect(JSON.parse(capturedResponse!.body)).toEqual({ error: 'Path exists but is not a directory' })
    expect(mkdirRoute).not.toHaveBeenCalled()

    await invoke(handler, 'POST', '/codex-api/local-directory', { path: directory })
    expect(capturedResponse?.statusCode).toBe(200)
    expect(JSON.parse(capturedResponse!.body)).toEqual({ data: { path: directory } })
    expect(mkdirRoute).not.toHaveBeenCalled()
  })
})
