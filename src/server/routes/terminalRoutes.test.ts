import type { IncomingMessage, ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { readAnyJsonBody } from '../httpUtils.js'
import { createTerminalRoutes } from './terminalRoutes.js'

type TestResponse = { statusCode: number; body: string; headers: Record<string, string> }

let capturedResponse: TestResponse | null = null

async function invoke(
  handler: ReturnType<typeof createTerminalRoutes>,
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
  return handler(
    request as never as IncomingMessage,
    response,
    new URL(pathname, 'http://localhost'),
    { readJsonBody: () => readAnyJsonBody(request as never as IncomingMessage) },
  )
}

function fixture(overrides: Partial<Parameters<typeof createTerminalRoutes>[0]> = {}) {
  const terminalManager = {
    getAvailability: vi.fn(() => ({ available: true, reason: null })),
    attach: vi.fn(() => ({ id: 'session-1', threadId: 'thread-1', cwd: '/repo', shell: 'zsh', buffer: '', truncated: false })),
    write: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
    getSnapshotForThread: vi.fn(() => null),
  }
  const listQuickCommands = vi.fn(async () => [{ label: 'Dev', value: 'pnpm dev', source: 'script' as const }])
  const handler = createTerminalRoutes({ terminalManager, listQuickCommands, ...overrides })
  return { handler, terminalManager, listQuickCommands }
}

function expectResponse(statusCode: number, payload: unknown) {
  expect(capturedResponse).toEqual({
    statusCode,
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

describe('terminal routes', () => {
  it('returns availability and quick commands', async () => {
    const { handler, listQuickCommands } = fixture()
    expect(await invoke(handler, 'GET', '/codex-api/thread-terminal/status')).toBe(true)
    expectResponse(200, { available: true, reason: null })
    expect(await invoke(handler, 'GET', '/codex-api/thread-terminal/quick-commands?cwd=/repo')).toBe(true)
    expectResponse(200, { commands: [{ label: 'Dev', value: 'pnpm dev', source: 'script' }] })
    expect(listQuickCommands).toHaveBeenCalledWith('/repo')
  })

  it('requires cwd and maps quick-command failures to 500', async () => {
    const { handler } = fixture({
      listQuickCommands: async () => { throw new Error('Terminal cwd is not a directory') },
    })
    await invoke(handler, 'GET', '/codex-api/thread-terminal/quick-commands')
    expectResponse(400, { error: 'Missing cwd' })
    await invoke(handler, 'GET', '/codex-api/thread-terminal/quick-commands?cwd=/missing')
    expectResponse(500, { error: 'Terminal cwd is not a directory' })
  })

  it('attaches with normalized fields and preserves missing optional dimensions', async () => {
    const { handler, terminalManager } = fixture()
    await invoke(handler, 'POST', '/codex-api/thread-terminal/attach', { threadId: ' thread-1 ', cwd: '/repo', sessionId: '  ' })
    expect(terminalManager.attach).toHaveBeenCalledWith({
      threadId: 'thread-1',
      cwd: '/repo',
      sessionId: undefined,
      cols: undefined,
      rows: undefined,
      newSession: false,
    })
    expectResponse(200, { session: { id: 'session-1', threadId: 'thread-1', cwd: '/repo', shell: 'zsh', buffer: '', truncated: false } })
  })

  it('rejects unavailable mutation and missing session ids', async () => {
    const { handler, terminalManager } = fixture({
      terminalManager: {
        getAvailability: () => ({ available: false, reason: 'PTY unavailable' }),
      } as never,
    })
    await invoke(handler, 'POST', '/codex-api/thread-terminal/input', { sessionId: 'session-1', data: 'x' })
    expectResponse(503, { error: 'PTY unavailable' })
    await invoke(handler, 'POST', '/codex-api/thread-terminal/close', {})
    expectResponse(503, { error: 'PTY unavailable' })
    expect(terminalManager.write).not.toHaveBeenCalled()
  })

  it('dispatches input, resize and close with one response each', async () => {
    const { handler, terminalManager } = fixture()
    await invoke(handler, 'POST', '/codex-api/thread-terminal/input', { sessionId: 'session-1', data: 'dir\n' })
    expect(terminalManager.write).toHaveBeenCalledWith('session-1', 'dir\n')
    expectResponse(200, { ok: true })
    await invoke(handler, 'POST', '/codex-api/thread-terminal/resize', { sessionId: 'session-1', cols: 120, rows: 40 })
    expect(terminalManager.resize).toHaveBeenCalledWith('session-1', 120, 40)
    await invoke(handler, 'POST', '/codex-api/thread-terminal/close', { sessionId: 'session-1' })
    expect(terminalManager.close).toHaveBeenCalledWith('session-1')
  })

  it('requires and returns active thread snapshots', async () => {
    const { handler } = fixture()
    await invoke(handler, 'GET', '/codex-api/thread-terminal-snapshot')
    expectResponse(400, { error: 'Missing threadId' })
    await invoke(handler, 'GET', '/codex-api/thread-terminal-snapshot?threadId=thread-1')
    expectResponse(200, { session: null })
  })
})
