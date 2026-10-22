import { afterEach, describe, expect, it, vi } from 'vitest'
import { cancelCodexLogin, getCodexLoginStatus } from './accountGateway'

describe('account gateway', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('cancels a login session through the account endpoint', async () => {
    const requests: Array<{ url: string; method: string; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {},
      })
      return new Response('null', { status: 200 })
    }))

    await expect(cancelCodexLogin('session-1')).resolves.toBeUndefined()

    expect(requests).toEqual([{
      url: '/codex-api/accounts/login/cancel',
      method: 'POST',
      body: { loginSessionId: 'session-1' },
    }])
  })

  it('returns null when the server has no active login session', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input))
      return new Response(JSON.stringify({ data: null }), { status: 200 })
    }))

    await expect(getCodexLoginStatus()).resolves.toBeNull()
    expect(requests).toEqual(['/codex-api/accounts/login/status'])
  })
})
