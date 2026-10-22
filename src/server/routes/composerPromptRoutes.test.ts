import type { IncomingMessage, ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { readAnyJsonBody } from '../httpUtils.js'
import { createComposerPromptRoutes } from './composerPromptRoutes.js'

type TestResponse = { statusCode: number; body: string; headers: Record<string, string> }
let capturedResponse: TestResponse | null = null

async function invoke(
  handler: ReturnType<typeof createComposerPromptRoutes>,
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
    end: (chunk?: unknown) => { capturedResponse = { statusCode: response.statusCode, body: typeof chunk === 'string' ? chunk : '', headers } },
  } as unknown as ServerResponse
  capturedResponse = null
  return handler(request as never as IncomingMessage, response, new URL(pathname, 'http://localhost'), {
    readJsonBody: () => readAnyJsonBody(request as never as IncomingMessage),
  })
}

describe('composer prompt routes', () => {
  it('lists prompts', async () => {
    const prompts = [{ name: 'prompt', path: '/prompts/prompt.md', content: 'content', description: 'content' }]
    const listPrompts = vi.fn(async () => prompts)

    const handled = await invoke(createComposerPromptRoutes({
      createPrompt: vi.fn(),
      listPrompts,
      removePrompt: vi.fn(),
    }), 'GET', '/codex-api/prompts')

    expect(handled).toBe(true)
    expect(capturedResponse).toEqual({
      statusCode: 200,
      body: JSON.stringify({ data: prompts }),
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  })

  it('requires name and content before calling the create service', async () => {
    const createPrompt = vi.fn()
    const handler = createComposerPromptRoutes({ createPrompt, listPrompts: vi.fn(), removePrompt: vi.fn() })

    await invoke(handler, 'POST', '/codex-api/prompts', { name: '  ', content: 'content' })
    expect(capturedResponse?.statusCode).toBe(400)
    expect(JSON.parse(capturedResponse!.body)).toEqual({ error: 'Prompt name and content are required' })

    await invoke(handler, 'POST', '/codex-api/prompts', { name: 'name', content: '  ' })
    expect(createPrompt).not.toHaveBeenCalled()
  })

  it('creates a prompt and preserves service failures in the 500 boundary', async () => {
    const prompt = { name: 'name', path: '/prompts/name.md', content: 'content\n', description: 'content' }
    const handler = createComposerPromptRoutes({
      createPrompt: vi.fn(async () => prompt),
      listPrompts: vi.fn(),
      removePrompt: vi.fn(),
    })
    await invoke(handler, 'POST', '/codex-api/prompts', { name: ' name ', content: ' content ' })
    expect(JSON.parse(capturedResponse!.body)).toEqual({ data: prompt })

    const failing = createComposerPromptRoutes({
      createPrompt: async () => { throw new Error('write failed') },
      listPrompts: vi.fn(),
      removePrompt: vi.fn(),
    })
    await invoke(failing, 'POST', '/codex-api/prompts', { name: 'name', content: 'content' })
    expect(capturedResponse?.statusCode).toBe(500)
    expect(JSON.parse(capturedResponse!.body)).toEqual({ error: 'write failed' })
  })

  it('removes prompts only with a path and preserves the 400 boundary', async () => {
    const removePrompt = vi.fn(async () => true)
    const handler = createComposerPromptRoutes({
      createPrompt: vi.fn(),
      listPrompts: vi.fn(),
      removePrompt,
    })
    await invoke(handler, 'DELETE', '/codex-api/prompts')
    expect(capturedResponse?.statusCode).toBe(400)
    expect(JSON.parse(capturedResponse!.body)).toEqual({ error: 'Missing path' })
    expect(removePrompt).not.toHaveBeenCalled()

    await invoke(handler, 'DELETE', '/codex-api/prompts?path=%2Fprompts%2Fname.md')
    expect(capturedResponse?.statusCode).toBe(200)
    expect(JSON.parse(capturedResponse!.body)).toEqual({ data: { removed: true } })

    const failing = createComposerPromptRoutes({
      createPrompt: vi.fn(),
      listPrompts: vi.fn(),
      removePrompt: async () => { throw new Error('Invalid prompt path') },
    })
    await invoke(failing, 'DELETE', '/codex-api/prompts?path=%2Foutside%2Fname.md')
    expect(capturedResponse?.statusCode).toBe(400)
    expect(JSON.parse(capturedResponse!.body)).toEqual({ error: 'Invalid prompt path' })
  })
})
