import type { IncomingMessage, ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { readAnyJsonBody } from '../httpUtils.js'
import { createProjectConversationRoutes } from './projectConversationRoutes.js'

type TestResponse = { statusCode: number; body: string; headers: Record<string, string> }
let capturedResponse: TestResponse | null = null

async function invoke(handler: ReturnType<typeof createProjectConversationRoutes>, method: string, pathname: string, body?: unknown) {
  const request = new PassThrough()
  Object.defineProperty(request, 'method', { value: method })
  Object.defineProperty(request, 'url', { value: '' })
  request.end(body === undefined ? '' : JSON.stringify(body))
  const headers: Record<string, string> = {}
  const response = {
    statusCode: 200,
    setHeader: (name: string, value: string) => { headers[name] = value },
    end: (chunk?: unknown) => { capturedResponse = { statusCode: response.statusCode, body: typeof chunk === 'string' ? chunk : '', headers } },
  } as unknown as ServerResponse
  capturedResponse = null
  return handler(request as never as IncomingMessage, response, new URL(pathname, 'http://localhost'), {
    readJsonBody: () => readAnyJsonBody(request as never as IncomingMessage),
  })
}

describe('project conversation routes', () => {
  it('creates a projectless conversation directory for string prompts', async () => {
    const directory = { cwd: '/projectless', outputDirectory: '/output', workspaceRoot: '/root' }
    const createProjectlessThreadDirectory = vi.fn(async () => directory)
    const createProjectConversationDirectory = vi.fn()
    const handler = createProjectConversationRoutes({ createProjectConversationDirectory, createProjectlessThreadDirectory })

    const handled = await invoke(handler, 'POST', '/codex-api/projectless-thread-cwd', { prompt: 'hello' })

    expect(handled).toBe(true)
    expect(createProjectlessThreadDirectory).toHaveBeenCalledWith('hello')
    expect(capturedResponse).toEqual({
      statusCode: 200,
      body: JSON.stringify({ data: directory }),
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  })

  it('creates a project conversation when projectId is present', async () => {
    const createProjectlessThreadDirectory = vi.fn()
    const createProjectConversationDirectory = vi.fn(async () => ({ cwd: '/project/thread' }))
    const handler = createProjectConversationRoutes({ createProjectConversationDirectory, createProjectlessThreadDirectory })

    await invoke(handler, 'POST', '/codex-api/projectless-thread-cwd', { projectId: 'virtual:project' })

    expect(createProjectConversationDirectory).toHaveBeenCalledWith(null, 'virtual:project')
    expect(createProjectlessThreadDirectory).not.toHaveBeenCalled()
    expect(JSON.parse(capturedResponse!.body)).toEqual({ data: { cwd: '/project/thread' } })
  })

  it('maps creation failures to the existing 500 boundary', async () => {
    const handler = createProjectConversationRoutes({
      createProjectConversationDirectory: vi.fn(),
      createProjectlessThreadDirectory: async () => { throw new Error('directory failed') },
    })

    await invoke(handler, 'POST', '/codex-api/projectless-thread-cwd', { prompt: 4 })

    expect(capturedResponse?.statusCode).toBe(500)
    expect(JSON.parse(capturedResponse!.body)).toEqual({ error: 'directory failed' })
  })
})
