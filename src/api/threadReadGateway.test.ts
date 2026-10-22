import { describe, expect, it, vi } from 'vitest'
import {
  getOlderThreadMessages,
  getThreadGroupsPage,
  invalidateThreadResumeCache,
  resumeThread,
} from './threadReadGateway'

function rpcRequestBody(init?: RequestInit): { method: string, params: Record<string, unknown> } {
  expect(typeof init?.body).toBe('string')
  return JSON.parse(String(init?.body)) as { method: string, params: Record<string, unknown> }
}

describe('threadReadGateway', () => {
  it('keeps the background thread list request explicit and singleton-owned', async () => {
    const requests: Array<{ method: string, params: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = rpcRequestBody(init)
      requests.push(body)
      return new Response(JSON.stringify({
        result: {
          data: [],
          nextCursor: null,
        },
      }), { headers: { 'Content-Type': 'application/json' } })
    }))

    await getThreadGroupsPage('thread-cursor', 100)

    expect(requests).toEqual([{
      method: 'thread/list',
      params: {
        archived: false,
        limit: 100,
        sortKey: 'updated_at',
        modelProviders: [],
        cursor: 'thread-cursor',
      },
    }])
  })

  it('passes the native cursor and source through the older-history request', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('/codex-api/thread-turn-page?threadId=thread-a&beforeTurnId=turn-1&limit=7&cursor=history-cursor&source=native')
      return new Response(JSON.stringify({
        result: { thread: { turns: [] } },
        hasMoreOlder: true,
        nextCursor: 'next-cursor',
        source: 'native',
        startTurnIndex: 12,
      }), { headers: { 'Content-Type': 'application/json' } })
    }))

    await expect(getOlderThreadMessages('thread-a', 'turn-1', 7, {
      nextCursor: 'history-cursor',
      source: 'native',
    })).resolves.toMatchObject({
      hasMoreOlder: true,
      historyPosition: { nextCursor: 'next-cursor', source: 'native' },
      startTurnIndex: 12,
      turnIndexByTurnId: {},
    })
  })

  it('invalidating a thread releases only its coalesced resume request', async () => {
    const requests: Array<{ threadId: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = rpcRequestBody(init)
      requests.push({ threadId: String(body.params.threadId) })
      return new Response(JSON.stringify({
        result: { thread: { turns: [] } },
      }), { headers: { 'Content-Type': 'application/json' } })
    }))

    const first = resumeThread('thread-a')
    invalidateThreadResumeCache('thread-a')
    const second = resumeThread('thread-a')
    await first
    const firstResult = await second
    void firstResult

    expect(requests).toEqual([{ threadId: 'thread-a' }, { threadId: 'thread-a' }])
  })
})
