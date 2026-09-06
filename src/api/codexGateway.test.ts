import { invalidateModelCatalog } from './modelCatalog'
afterEach(() => invalidateModelCatalog())
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  completeCodexLogin,
  getAccounts,
  getAvailableModelIds,
  getThreadDetail,
  listDirectoryComposioConnectors,
  resumeThread,
  startCodexLogin,
  startThreadTurn,
  switchAccount,
} from './codexGateway'

function mockRpcFetch(): { requests: Array<{ method: string, params: Record<string, unknown> }> } {
  const requests: Array<{ method: string, params: Record<string, unknown> }> = []

  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string'
      ? JSON.parse(init.body) as { method: string, params: Record<string, unknown> }
      : { method: '', params: {} }

    requests.push(body)

    return new Response(JSON.stringify({
      result: {
        turn: {
          id: `turn-${requests.length}`,
        },
      },
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    })
  }))

  return { requests }
}

describe('startThreadTurn collaboration mode payloads', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends default collaboration mode explicitly after a plan turn', async () => {
    const { requests } = mockRpcFetch()

    await startThreadTurn('thread-1', 'make a plan', [], 'gpt-5.4', 'medium', undefined, [], 'plan')
    await startThreadTurn('thread-1', 'implement it', [], 'gpt-5.4', 'medium', undefined, [], 'default')

    expect(requests).toHaveLength(2)
    expect(requests[0].method).toBe('turn/start')
    expect(requests[0].params.collaborationMode).toEqual({
      mode: 'plan',
      settings: {
        model: 'gpt-5.4',
        reasoning_effort: 'medium',
        developer_instructions: null,
      },
    })
    expect(requests[1].method).toBe('turn/start')
    expect(requests[1].params.collaborationMode).toEqual({
      mode: 'default',
      settings: {
        model: 'gpt-5.4',
        reasoning_effort: 'medium',
        developer_instructions: null,
      },
    })
  })
})

describe('dynamic execution settings', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('sends advertised new values and clears a previous service tier explicitly', async () => {
    const { requests } = mockRpcFetch()
    await startThreadTurn('fixture', 'first', [], 'future', 'ultra', undefined, [], 'default', 'priority')
    await startThreadTurn('fixture', 'second', [], 'future', 'max', undefined, [], 'plan', null)
    expect(requests[0].params).toMatchObject({ model: 'future', effort: 'ultra', serviceTier: 'priority', collaborationMode: { settings: { reasoning_effort: 'ultra' } } })
    expect(requests[1].params).toMatchObject({ effort: 'max', serviceTier: null, collaborationMode: { settings: { reasoning_effort: 'max' } } })
  })
})

describe('listDirectoryComposioConnectors', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends search queries as query params expected by the server', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input))
      return new Response(JSON.stringify({
        data: [],
        nextCursor: null,
        total: 0,
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      })
    }))

    await listDirectoryComposioConnectors('instagram', '50', 25)

    expect(requests).toEqual(['/codex-api/composio/connectors?query=instagram&cursor=50&limit=25'])
  })
})

describe('getAvailableModelIds', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses provider models without waiting for model/list when provider models are required', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input))
      if (String(input) === '/codex-api/provider-models') {
        return new Response(JSON.stringify({
          data: ['big-pickle', 'deepseek-v4-flash-free'],
          exclusive: true,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw new Error(`unexpected request ${String(input)}`)
    }))

    await expect(getAvailableModelIds({
      includeProviderModels: true,
      requireProviderModels: true,
    })).resolves.toEqual(['big-pickle', 'deepseek-v4-flash-free'])
    expect(requests).toEqual(['/codex-api/provider-models'])
  })

  it('requests models for an explicit thread provider', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input))
      if (String(input) === '/codex-api/provider-models?provider=opencode-zen') {
        return new Response(JSON.stringify({
          data: ['big-pickle', 'ring-2.6-1t-free'],
          exclusive: true,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw new Error(`unexpected request ${String(input)}`)
    }))

    await expect(getAvailableModelIds({
      includeProviderModels: true,
      requireProviderModels: true,
      providerId: 'opencode-zen',
    })).resolves.toEqual(['big-pickle', 'ring-2.6-1t-free'])
    expect(requests).toEqual(['/codex-api/provider-models?provider=opencode-zen'])
  })

  it('falls back to model/list when provider models are optional and unavailable', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(input))
      if (String(input) === '/codex-api/provider-models') {
        return new Response(JSON.stringify({ data: [] }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { method: string }
        : { method: '' }
      expect(body.method).toBe('model/list')
      return new Response(JSON.stringify({
        result: {
          data: [
            { id: 'gpt-5.5' },
            { model: 'gpt-5.4-mini' },
          ],
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await expect(getAvailableModelIds({
      includeProviderModels: true,
    })).resolves.toEqual(['gpt-5.5', 'gpt-5.4-mini'])
    expect(requests).toEqual(['/codex-api/provider-models', '/codex-api/rpc'])
  })
})

describe('account coordinator gateway', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('normalizes versioned account state and action fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: {
        activeAccountId: 'account-a',
        activeStorageId: 'storage-a',
        operation: { kind: 'refresh', storageId: 'storage-b', startedAt: 123 },
        accounts: [{
          accountId: 'account-a',
          storageId: 'storage-a',
          credentialRevision: 4,
          authStatus: 'reauth_required',
          quotaStatus: 'error',
          unavailableReason: 'reauth_required',
          actionRequired: 'reauthenticate',
          canSwitch: false,
        }],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    await expect(getAccounts()).resolves.toMatchObject({
      activeStorageId: 'storage-a',
      operation: { kind: 'refresh', storageId: 'storage-b', startedAt: 123 },
      accounts: [{
        storageId: 'storage-a',
        credentialRevision: 4,
        authStatus: 'reauth_required',
        actionRequired: 'reauthenticate',
        canSwitch: false,
        isActive: true,
      }],
    })
  })

  it('keeps isolated login session identity in start and complete requests', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
      requests.push({ url, body })
      if (url.endsWith('/start')) {
        return new Response(JSON.stringify({ data: { loginSessionId: 'session-1', loginUrl: 'https://auth.openai.com/oauth/authorize?test=1' } }), { status: 200 })
      }
      return new Response(JSON.stringify({ data: {
        outcome: 'reauthenticated',
        activeAccountId: 'account-a',
        activeStorageId: 'storage-a',
        poolSize: 1,
        account: { accountId: 'account-a', storageId: 'storage-a', credentialRevision: 2, authStatus: 'ready' },
        accounts: [{ accountId: 'account-a', storageId: 'storage-a', credentialRevision: 2, authStatus: 'ready' }],
      } }), { status: 200 })
    }))

    await startCodexLogin('reauth', 'storage-a')
    const completed = await completeCodexLogin('session-1', 'http://localhost:1455/auth/callback?code=fake')

    expect(requests).toEqual([
      { url: '/codex-api/accounts/login/start', body: { intent: 'reauth', targetStorageId: 'storage-a' } },
      { url: '/codex-api/accounts/login/complete', body: { loginSessionId: 'session-1', callbackUrl: 'http://localhost:1455/auth/callback?code=fake' } },
    ])
    expect(completed).toMatchObject({ outcome: 'reauthenticated', poolSize: 1, activeStorageId: 'storage-a' })
  })

  it('sends optimistic active-account and thread continuity inputs when switching', async () => {
    let requestBody: Record<string, unknown> = {}
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
      return new Response(JSON.stringify({ data: {
        activeStorageId: 'storage-b',
        account: { accountId: 'account-b', storageId: 'storage-b', credentialRevision: 1, authStatus: 'ready' },
        workspaceContinuity: { checked: true, restored: true, threadId: 'thread-1' },
      } }), { status: 200 })
    }))

    await expect(switchAccount('storage-b', 'storage-a', 'thread-1')).resolves.toMatchObject({
      activeStorageId: 'storage-b',
      workspaceContinuity: { checked: true, restored: true, threadId: 'thread-1' },
    })
    expect(requestBody).toEqual({ storageId: 'storage-b', expectedActiveStorageId: 'storage-a', resumeThreadId: 'thread-1' })
  })
})

describe('getThreadDetail', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads modelProvider from nested thread payloads returned by thread/read', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { method: string; params: Record<string, unknown> }
        : { method: '', params: {} }
      expect(body.method).toBe('thread/read')
      return new Response(JSON.stringify({
        result: {
          thread: {
            id: body.params.threadId,
            modelProvider: 'opencode_zen',
            turns: [],
          },
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await expect(getThreadDetail('legacy-thread')).resolves.toMatchObject({
      modelProvider: 'opencode_zen',
    })
  })
})

describe('resumeThread', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('coalesces repeated resume failures for the same thread', async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { method: string; params: Record<string, unknown> }
        : { method: '', params: {} }
      requests.push(body)
      return new Response(JSON.stringify({ error: 'no rollout found for thread id missing-thread' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    const results = await Promise.allSettled([
      resumeThread('missing-thread'),
      resumeThread('missing-thread'),
    ])

    expect(results.every((result) => result.status === 'rejected')).toBe(true)
    expect(requests).toEqual([
      { method: 'thread/resume', params: { threadId: 'missing-thread' } },
    ])
  })

  it('evicts a stalled resume so later resume attempts are not pinned forever', async () => {
    vi.useFakeTimers()
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { method: string; params: Record<string, unknown> }
        : { method: '', params: {} }
      requests.push(body)
      return new Promise<Response>(() => undefined)
    }))

    const first = resumeThread('stalled-thread')
    void resumeThread('stalled-thread')
    expect(requests).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(30_000)

    const retried = resumeThread('stalled-thread')
    expect(retried).not.toBe(first)
    expect(requests).toEqual([
      { method: 'thread/resume', params: { threadId: 'stalled-thread' } },
      { method: 'thread/resume', params: { threadId: 'stalled-thread' } },
    ])
  })
})
