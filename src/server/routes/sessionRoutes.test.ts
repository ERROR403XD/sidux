import type { IncomingMessage, ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { readAnyJsonBody } from '../httpUtils.js'
import { createSessionRoutes } from './sessionRoutes.js'

type TestResponse = {
  statusCode: number
  body: string
}

let capturedResponse: TestResponse | null = null

function createRequest(method: string, body?: unknown): IncomingMessage {
  const request = new PassThrough()
  Object.defineProperty(request, 'method', { value: method })
  Object.defineProperty(request, 'url', { value: '' })
  request.end(body === undefined ? '' : JSON.stringify(body))
  return request as unknown as IncomingMessage
}

function createResponse(): ServerResponse {
  return {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn(function (this: ServerResponse, chunk?: unknown) {
      capturedResponse = {
        statusCode: this.statusCode,
        body: typeof chunk === 'string' ? chunk : '',
      }
    }),
  } as unknown as ServerResponse
}

function createDependencies() {
  return {
    completions: {
      read: vi.fn(async () => [{ threadId: 'thread', token: 'token' }]),
      acknowledge: vi.fn(async () => {}),
    },
    queueStateReader: vi.fn(async () => ({ queued: 0 })),
    readNonEmptyString: (value: unknown) => typeof value === 'string' && value.trim() ? value : '',
  }
}

async function invoke(
  dependencies: ReturnType<typeof createDependencies>,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ handled: boolean; response: TestResponse | null }> {
  const request = createRequest(method, body)
  const response = createResponse()
  capturedResponse = null
  const handled = await createSessionRoutes(dependencies)(
    request,
    response,
    new URL(pathname, 'http://localhost'),
    { readJsonBody: () => readAnyJsonBody(request) },
  )
  return { handled, response: capturedResponse }
}

describe('session routes', () => {
  it('reads thread completions', async () => {
    const dependencies = createDependencies()
    const result = await invoke(dependencies, 'GET', '/codex-api/thread-completions')

    expect(result).toEqual({
      handled: true,
      response: {
        statusCode: 200,
        body: JSON.stringify({ data: [{ threadId: 'thread', token: 'token' }], kinds: {} }),
      },
    })
    expect(dependencies.completions.read).toHaveBeenCalledTimes(1)
    expect(dependencies.queueStateReader).not.toHaveBeenCalled()
  })

  it('acknowledges thread completions with normalized identifiers', async () => {
    const dependencies = createDependencies()
    const result = await invoke(dependencies, 'POST', '/codex-api/thread-completions', {
      threadId: ' thread ',
      token: ' token ',
    })

    expect(result).toEqual({ handled: true, response: { statusCode: 200, body: JSON.stringify({ ok: true }) } })
    expect(dependencies.completions.acknowledge).toHaveBeenCalledWith(' thread ', ' token ')
  })

  it('reads queue state once', async () => {
    const dependencies = createDependencies()
    const result = await invoke(dependencies, 'GET', '/codex-api/thread-queue-state')

    expect(result).toEqual({
      handled: true,
      response: { statusCode: 200, body: JSON.stringify({ data: { queued: 0 } }) },
    })
    expect(dependencies.queueStateReader).toHaveBeenCalledTimes(1)
  })

  it('does not handle unrelated routes or methods', async () => {
    const dependencies = createDependencies()

    expect((await invoke(dependencies, 'POST', '/codex-api/thread-queue-state')).handled).toBe(false)
    expect((await invoke(dependencies, 'GET', '/codex-api/unknown')).handled).toBe(false)
    expect(dependencies.completions.read).not.toHaveBeenCalled()
    expect(dependencies.completions.acknowledge).not.toHaveBeenCalled()
    expect(dependencies.queueStateReader).not.toHaveBeenCalled()
  })

  it('rejects acknowledgements without identifiers', async () => {
    const dependencies = createDependencies()
    const result = await invoke(dependencies, 'POST', '/codex-api/thread-completions', { threadId: 'thread' })

    expect(result).toEqual({
      handled: true,
      response: { statusCode: 400, body: JSON.stringify({ error: 'Missing threadId or token' }) },
    })
    expect(dependencies.completions.acknowledge).not.toHaveBeenCalled()
  })
})
