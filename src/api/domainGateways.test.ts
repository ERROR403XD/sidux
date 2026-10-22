import { afterEach, describe, expect, it, vi } from 'vitest'
import { getFreeModeStatus, setCustomProvider, setFreeMode, setFreeModeCustomKey } from './providerGateway'
import { getGitBranchCommits } from './gitGateway'
import { getReviewSummary, getThreadReviewResult, startThreadReview } from './reviewGateway'
import { getTelegramConfig } from './telegramGateway'

afterEach(() => vi.unstubAllGlobals())

describe('migrated gateway contracts', () => {
  it('keeps compatibility exports as the same operations without network initialization', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const facade: Record<string, unknown> = await import('./codexGateway')
    const domains = await Promise.all([
      import('./providerGateway'), import('./executionSettingsGateway'),
      import('./gitGateway'), import('./reviewGateway'), import('./threadQueueGateway'),
      import('./threadSearchGateway'), import('./telegramGateway'), import('./skillsGateway'),
      import('./composerPromptsGateway'), import('./mediaGateway'), import('./runtimeGateway'),
    ])
    for (const domain of domains) {
      for (const [name, operation] of Object.entries(domain)) {
        expect(facade[name], name).toBe(operation)
      }
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('preserves provider endpoint bodies and the existing JSON error envelope', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(JSON.stringify({ ok: false, error: 'busy' }), { status: 409 })
    ))
    vi.stubGlobal('fetch', fetch)
    await expect(getFreeModeStatus()).resolves.toEqual({ ok: false, error: 'busy' })
    await expect(setFreeMode(false)).resolves.toEqual({ ok: false, error: 'busy' })
    await setFreeModeCustomKey('fixture-key')
    await setCustomProvider('https://provider.example.test/v1', 'fixture-key', {
      wireApi: 'chat', provider: 'custom',
    })
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/codex-api/free-mode/status', '/codex-api/free-mode',
      '/codex-api/free-mode/custom-key', '/codex-api/free-mode/custom-provider',
    ])
    expect(fetch.mock.calls.slice(1).map(([, init]) => JSON.parse(init!.body as string))).toEqual([
      { enable: false }, { key: 'fixture-key' },
      { baseUrl: 'https://provider.example.test/v1', apiKey: 'fixture-key', wireApi: 'chat', provider: 'custom' },
    ])
  })

  it('keeps Git request normalization and reset-history options', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [
      { sha: ' abc ', shortSha: ' abc ', subject: '', date: ' 2026-10-11 ' },
      { sha: '', shortSha: 'invalid' },
    ] })))
    vi.stubGlobal('fetch', fetch)
    await expect(getGitBranchCommits(' /fixture ', ' feature/a ', { includeResetHistory: false })).resolves.toEqual([
      { sha: 'abc', shortSha: 'abc', subject: 'abc', date: '2026-10-11' },
    ])
    expect(fetch).toHaveBeenCalledWith('/codex-api/git/branch-commits?cwd=%2Ffixture&branch=feature%2Fa&includeResetHistory=false')
  })

  it('keeps review response projection and error precedence without extra requests', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { fileCount: 2, addedLineCount: 3, removedLineCount: 1 } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'specific message', error: 'fallback' }), { status: 500 }))
    vi.stubGlobal('fetch', fetch)
    await expect(getReviewSummary('/fixture', 'staged')).resolves.toEqual({ fileCount: 2, addedLineCount: 3, removedLineCount: 1 })
    await expect(getReviewSummary('/fixture', 'unstaged')).rejects.toThrow('specific message')
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/codex-api/review/summary?cwd=%2Ffixture&workspaceView=staged',
      '/codex-api/review/summary?cwd=%2Ffixture&workspaceView=unstaged',
    ])
  })

  it('retains thread review parsing and the original RPC owner', async () => {
    const requests: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(init!.body as string)
      requests.push(request)
      const result = request.method === 'thread/read' ? { thread: { id: 'fixture', turns: [{ items: [
        { type: 'enteredReviewMode', review: 'Workspace' },
        { type: 'exitedReviewMode', review: 'Summary\nFull review comments:\n- [P1] Fix issue \u2014 /fixture/code.ts:2-3\n  Details' },
      ] }] } } : {}
      return new Response(JSON.stringify({ result }))
    }))
    await expect(getThreadReviewResult('fixture')).resolves.toMatchObject({
      enteredReviewLabel: 'Workspace',
      result: { summary: 'Summary', findings: [{ title: '[P1] Fix issue', absolutePath: '/fixture/code.ts', startLine: 2, endLine: 3 }] },
    })
    await startThreadReview('fixture', 'baseBranch', 'unstaged', ' main ')
    expect(requests).toEqual([
      { method: 'thread/read', params: { threadId: 'fixture', includeTurns: true } },
      { method: 'review/start', params: { threadId: 'fixture', target: { type: 'baseBranch', branch: 'main' }, delivery: 'inline' } },
    ])
  })

  it('preserves Telegram config normalization using synthetic data only', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: {
      botToken: '', allowedUserIds: ['*', 12.5, 'ignored'],
    } })))
    vi.stubGlobal('fetch', fetch)
    await expect(getTelegramConfig()).resolves.toMatchObject({
      notificationsEnabled: false, quietEnabled: false,
      quietStart: '22:00', quietEnd: '08:00', timezone: 'Asia/Shanghai', allowedUserIds: ['*', 12],
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
