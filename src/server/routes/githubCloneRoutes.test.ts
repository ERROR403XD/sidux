import type { IncomingMessage, ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { readAnyJsonBody } from '../httpUtils.js'
import { createGithubCloneRoutes } from './githubCloneRoutes.js'

type TestResponse = {
  statusCode: number
  body: string
  headers: Record<string, string>
}

let capturedResponse: TestResponse | null = null

async function invoke(
  handler: ReturnType<typeof createGithubCloneRoutes>,
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

describe('github clone routes', () => {
  it('trims request fields and returns the cloned path', async () => {
    const cloneGithubRepository = vi.fn(async () => '/base/repo')
    const handler = createGithubCloneRoutes({ cloneGithubRepository })

    const handled = await invoke(handler, 'POST', '/codex-api/github-clone', {
      url: ' https://github.com/owner/repo.git ',
      basePath: ' /base ',
    })

    expect(handled).toBe(true)
    expect(cloneGithubRepository).toHaveBeenCalledWith('https://github.com/owner/repo.git', '/base')
    expect(capturedResponse).toEqual({
      statusCode: 200,
      body: JSON.stringify({ data: { path: '/base/repo' } }),
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  })

  it('maps Error instances to 400 with their existing message', async () => {
    const handler = createGithubCloneRoutes({
      cloneGithubRepository: async () => { throw new Error('Only github.com repository URLs are supported') },
    })

    const handled = await invoke(handler, 'POST', '/codex-api/github-clone', {
      url: 'https://example.com/owner/repo.git',
      basePath: '/base',
    })

    expect(handled).toBe(true)
    expect(capturedResponse).toEqual({
      statusCode: 400,
      body: JSON.stringify({ error: 'Only github.com repository URLs are supported' }),
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  })

  it('uses the generic fallback for non-error clone failures', async () => {
    const handler = createGithubCloneRoutes({
      cloneGithubRepository: async () => { throw 'fixture failure' },
    })

    const handled = await invoke(handler, 'POST', '/codex-api/github-clone', {})

    expect(handled).toBe(true)
    expect(JSON.parse(capturedResponse!.body)).toEqual({ error: 'Failed to clone GitHub repository' })
    expect(capturedResponse?.statusCode).toBe(400)
  })
})
