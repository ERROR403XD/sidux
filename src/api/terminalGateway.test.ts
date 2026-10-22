import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachThreadTerminal, getThreadTerminalStatus } from './terminalGateway'

describe('terminal gateway', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('attaches a terminal and preserves the session contract', async () => {
    const requests: Array<{ url: string; method: string; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {},
      })
      return new Response(JSON.stringify({
        session: {
          id: 'session-1',
          threadId: 'thread-1',
          cwd: '/repo',
          shell: '/bin/zsh',
          buffer: 'ready',
          truncated: true,
        },
      }))
    }))

    await expect(attachThreadTerminal({
      threadId: 'thread-1',
      cwd: '/repo',
      cols: 120,
      rows: 30,
    })).resolves.toMatchObject({
      id: 'session-1',
      threadId: 'thread-1',
      cwd: '/repo',
      shell: '/bin/zsh',
      buffer: 'ready',
      truncated: true,
    })

    expect(requests).toEqual([{
      url: '/codex-api/thread-terminal/attach',
      method: 'POST',
      body: { threadId: 'thread-1', cwd: '/repo', cols: 120, rows: 30 },
    }])
  })

  it('preserves terminal status defaults', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))

    await expect(getThreadTerminalStatus()).resolves.toEqual({
      available: false,
      reason: null,
    })
  })
})
