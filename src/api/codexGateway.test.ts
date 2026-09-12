import { invalidateModelCatalog } from './modelCatalog'
afterEach(() => invalidateModelCatalog())
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  completeCodexLogin,
  directoryAppsFromRuntime,
  getAccounts,
  normalizeAccountEntry,
  getAvailableModelIds,
  getThreadDetail,
  resumeThread,
  startCodexLogin,
  startThreadTurn,
  switchAccount,
  searchThreads,
} from './codexGateway'

it('shows runtime-only Apps without inventing catalog connectivity or install actions', () => {
  const apps = directoryAppsFromRuntime([{ id: 'app', name: 'Runtime App', enabled: true, callable: true }])
  expect(apps[0]).toMatchObject({ id: 'app', name: 'Runtime App', runtimeOnly: true, isEnabled: true, isAccessible: false, installUrl: '' })
})

function mockRpcFetch(): { requests: Array<{ method: string, params: Record<string, unknown> }> } {
  const requests: Array<{ method: string, params: Record<string, unknown> }> = []
  const saved = new Map<string, string>()
  vi.stubGlobal('localStorage', { get length() { return saved.size }, key: (index: number) => [...saved.keys()][index] ?? null, getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key) })

  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (String(_input).endsWith('/delivery-context')) return new Response(JSON.stringify({ data: { contextId: 'fixture-account' } }))
    const body = typeof init?.body === 'string'
      ? JSON.parse(init.body) as { method: string, params: Record<string, unknown>, message?: { id: string } }
      : { method: '', params: {} }

    requests.push({ ...body, method: String(_input).endsWith('/delivery') ? 'delivery/submit' : body.method })

    if (String(_input).endsWith('/delivery')) return new Response(JSON.stringify({ data: { id: body.message?.id, status: 'accepted', turnId: `turn-${requests.length}` } }))
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
  it('does not let display observers block submission or turn acceptance into failure', async () => {
    const { requests } = mockRpcFetch()
    const fail = () => { throw new Error('display-only failure') }
    expect(await startThreadTurn('thread-1', 'fixture', [], undefined, undefined, undefined, [], undefined, undefined, 'steer', { id: 'delivery-ui-test', onPrepared: fail, onResult: fail })).toMatch(/^turn-/)
    expect(requests.filter(row => row.method === 'delivery/submit')).toHaveLength(1)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends default collaboration mode explicitly after a plan turn', async () => {
    const { requests } = mockRpcFetch()

    await startThreadTurn('thread-1', 'make a plan', [], 'gpt-5.4', 'medium', undefined, [], 'plan')
    await startThreadTurn('thread-1', 'implement it', [], 'gpt-5.4', 'medium', undefined, [], 'default')

    expect(requests).toHaveLength(2)
    expect(requests[0].method).toBe('delivery/submit')
    expect(requests[0].params.collaborationMode).toEqual({
      mode: 'plan',
      settings: {
        model: 'gpt-5.4',
        reasoning_effort: 'medium',
        developer_instructions: null,
      },
    })
    expect(requests[1].method).toBe('delivery/submit')
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
          quotaSnapshot: { primary: { usedPercent: 50, windowMinutes: 300, resetsAt: 1788865200 } },
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
        quotaSnapshot: { primary: { usedPercent: 50, windowDurationMins: 300, windowMinutes: 300 } },
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
      requests.push({ ...body, method: String(_input).endsWith('/delivery') ? 'delivery/submit' : body.method })
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
      requests.push({ ...body, method: String(_input).endsWith('/delivery') ? 'delivery/submit' : body.method })
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

it('does not acknowledge a queued question answer as delivered and reuses its identity', async () => {
  mockRpcFetch()
  const original = globalThis.fetch
  const submitted: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/delivery')) {
      const body = JSON.parse(String(init?.body))
      submitted.push(body.message.id)
      expect(body.mode).toBe('steer')
      return new Response(JSON.stringify({ data: { id: body.message.id, status: 'queued' } }))
    }
    return original(input, init)
  }))
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(startThreadTurn('q', 'answer', [], 'm', undefined, undefined, [], undefined, null, 'steer', { id: 'question:q:t:0', requireConfirmed: true })).rejects.toThrow('尚未确认送达')
    }
    expect(submitted).toEqual(['question:q:t:0', 'question:q:t:0'])
  } finally { vi.unstubAllGlobals() }
})

describe('native plugin catalog isolation', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps local plugins visible when a different marketplace fails', async () => {
    const { listDirectoryPlugins, readDirectoryPlugin, installDirectoryPlugin } = await import('./codexGateway')
    const calls: string[] = []
    const summary = { id: 'local@fixture', name: 'local', source: { type: 'local', path: '/fixture/plugin' }, installed: false, enabled: false }
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body))
      calls.push(request.method)
      const result = request.method === 'plugin/list'
        ? { marketplaces: [{ name: 'fixture', path: '/fixture/.agents/plugins/marketplace.json', plugins: [summary] }], marketplaceLoadErrors: [{ message: 'remote HTTP 403' }] }
        : request.method === 'plugin/read' ? { plugin: { summary, apps: [{ id: 'connection', name: 'Service', needsAuth: true }], skills: [] } }
          : { appsNeedingAuth: [{ id: 'connection', name: 'Service', needsAuth: true, installUrl: 'https://example.com/connect' }] }
      return new Response(JSON.stringify({ result }))
    }))
    const warnings: string[] = []
    const plugins = await listDirectoryPlugins(undefined, false, rows => warnings.push(...rows))
    expect(plugins).toHaveLength(1)
    expect(warnings).toEqual(['remote HTTP 403'])
    const detail = await readDirectoryPlugin(plugins[0])
    expect(detail.apps[0].needsAuth).toBe(true)
    expect((await installDirectoryPlugin(plugins[0])).appsNeedingAuth[0].installUrl).toBe('https://example.com/connect')
    expect(calls).toEqual(['plugin/list', 'plugin/read', 'plugin/install'])
  })
})

it('retains local display aliases without substituting routing identity during account normalization', () => {
  const account = normalizeAccountEntry({ accountId: 'identity', storageId: 'storage', email: 'original@example.test', alias: '本地别名', credentialRevision: 7 })
  expect(account).toMatchObject({ accountId: 'identity', storageId: 'storage', email: 'original@example.test', alias: '本地别名', credentialRevision: 7 })
})


it('passes the search scope and normalizes older matched metadata without extra thread reads', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ data: {
    threadIds: ['old'], indexedThreadCount: 120,
    threads: [{ id: 'old', name: 'Older match', cwd: '/tmp/project', preview: '', createdAt: 1, updatedAt: 2 }],
  } })))
  vi.stubGlobal('fetch', fetch)
  try {
    const signal = new AbortController().signal
    const result = await searchThreads('key', 50, signal, 'body')
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/codex-api/thread-search', expect.objectContaining({
      signal, body: JSON.stringify({ query: 'key', limit: 50, mode: 'body' }),
    }))
    expect(result.groups?.[0]?.threads[0]).toMatchObject({ id: 'old', title: 'Older match', cwd: '/tmp/project' })
  } finally {
    vi.unstubAllGlobals()
  }
})
