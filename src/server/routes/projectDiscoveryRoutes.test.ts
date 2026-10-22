import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Stats } from 'node:fs'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { readAnyJsonBody } from '../httpUtils.js'
import { createProjectDiscoveryRoutes } from './projectDiscoveryRoutes.js'
import { createProjectDiscoveryService } from '../projectDiscoveryService.js'

type TestResponse = {
  statusCode: number
  body: string
  headers: Record<string, string>
}

let capturedResponse: TestResponse | null = null

async function invoke(
  handler: ReturnType<typeof createProjectDiscoveryRoutes>,
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

function createHandler(overrides: Partial<Parameters<typeof createProjectDiscoveryService>[0]> = {}) {
  return createProjectDiscoveryRoutes(createProjectDiscoveryService({
    isAbsolute: value => value.startsWith('/'),
    join: (...parts) => parts.join('/'),
    listFiles: vi.fn(async () => []),
    resolve: value => `/resolved/${value}`,
    scoreFileCandidate: () => 0,
    stat: async () => createStats(true),
    ...overrides,
  }))
}

function createStats(isDirectory: boolean): Stats {
  return { isDirectory: () => isDirectory } as unknown as Stats
}

describe('project discovery routes', () => {
  it('suggests the first unused project name', async () => {
    const stat = vi.fn(async (path: string) => {
      if (path === '/base') return createStats(true)
      if (path === '/base/New Project (1)') return createStats(true)
      throw new Error('missing')
    })

    const handled = await invoke(
      createHandler({ stat }),
      'GET',
      '/codex-api/project-root-suggestion?basePath=/base',
    )

    expect(handled).toBe(true)
    expect(capturedResponse).toEqual({
      statusCode: 200,
      body: JSON.stringify({ data: { name: 'New Project (2)', path: '/base/New Project (2)' } }),
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
    expect(stat).toHaveBeenCalledTimes(3)
  })

  it('validates the suggestion base path', async () => {
    await invoke(createHandler(), 'GET', '/codex-api/project-root-suggestion')
    expect(capturedResponse?.statusCode).toBe(400)
    expect(JSON.parse(capturedResponse!.body)).toEqual({ error: 'Missing basePath' })

    await invoke(createHandler({
      stat: async path => {
        if (path === '/base') return createStats(false)
        throw new Error('missing')
      },
    }), 'GET', '/codex-api/project-root-suggestion?basePath=/base')
    expect(capturedResponse?.statusCode).toBe(400)
    expect(JSON.parse(capturedResponse!.body)).toEqual({ error: 'basePath is not a directory' })

    await invoke(createHandler({
      stat: async () => { throw new Error('missing') },
    }), 'GET', '/codex-api/project-root-suggestion?basePath=/missing')
    expect(capturedResponse?.statusCode).toBe(404)
    expect(JSON.parse(capturedResponse!.body)).toEqual({ error: 'basePath does not exist' })
  })

  it('scores, filters, sorts, and clamps composer file results', async () => {
    const listFiles = vi.fn(async () => [
      '/project/other/readme.md',
      '/project/zeta.ts',
      '/project/src/alpha.ts',
      '/project/alpha.test.ts',
    ])
    const scoreFileCandidate = (path: string, query: string) =>
      path.includes(query) ? (path.endsWith(query) ? 0 : 1) : 10

    const handled = await invoke(
      createHandler({ listFiles, scoreFileCandidate }),
      'POST',
      '/codex-api/composer-file-search',
      { cwd: '/project', query: 'alpha.ts', limit: 999 },
    )

    expect(handled).toBe(true)
    expect(listFiles).toHaveBeenCalledWith('/project')
    expect(capturedResponse).toEqual({
      statusCode: 200,
      body: JSON.stringify({
        data: [
          { path: '/project/src/alpha.ts' },
        ],
      }),
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  })

  it('validates the composer cwd and maps search failures', async () => {
    await invoke(createHandler(), 'POST', '/codex-api/composer-file-search', { query: 'test' })
    expect(capturedResponse?.statusCode).toBe(400)
    expect(JSON.parse(capturedResponse!.body)).toEqual({ error: 'Missing cwd' })

    await invoke(createHandler({
      stat: async () => createStats(false),
    }), 'POST', '/codex-api/composer-file-search', { cwd: '/file' })
    expect(JSON.parse(capturedResponse!.body)).toEqual({ error: 'cwd is not a directory' })

    await invoke(createHandler({
      stat: async () => { throw new Error('missing') },
    }), 'POST', '/codex-api/composer-file-search', { cwd: '/missing' })
    expect(JSON.parse(capturedResponse!.body)).toEqual({ error: 'cwd does not exist' })

    await invoke(createHandler({
      listFiles: async () => { throw new Error('rg failed') },
    }), 'POST', '/codex-api/composer-file-search', { cwd: '/project' })
    expect(capturedResponse?.statusCode).toBe(500)
    expect(JSON.parse(capturedResponse!.body)).toEqual({ error: 'rg failed' })
  })
})
