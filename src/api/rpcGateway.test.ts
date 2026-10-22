import { afterEach, describe, expect, it, vi } from 'vitest'
import { callRpc } from './rpcGateway'
import { compactionRequests } from './threadCompaction'

describe('callRpc', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    compactionRequests.value = {}
  })

  it('observes compaction history once for successful thread reads', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(input))
      const body = JSON.parse(String(init?.body)) as { method: string }
      expect(body.method).toBe('thread/read')
      return new Response(JSON.stringify({
        result: {
          thread: {
            id: 'thread-1',
            turns: [{
              id: 'turn-1',
              status: 'completed',
              items: [{
                id: 'message-1',
                type: 'contextCompaction',
              }],
            }],
          },
        },
      }))
    }))

    compactionRequests.value = {
      'thread-1': {
        threadId: 'thread-1',
        beforeTurnId: '',
        requestedAtMs: 1,
        status: 'requested',
      },
    }

    await expect(callRpc('thread/read', { threadId: 'thread-1' })).resolves.toMatchObject({
      thread: { id: 'thread-1' },
    })

    expect(requests).toEqual(['/codex-api/rpc'])
    expect(compactionRequests.value['thread-1']).toMatchObject({
      turnId: 'turn-1',
      itemId: 'message-1',
      status: 'completed',
    })
  })

  it('does not observe compaction history for failed thread resumes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'no rollout found',
    }), { status: 502 })))

    compactionRequests.value = {
      'thread-1': {
        threadId: 'thread-1',
        beforeTurnId: '',
        requestedAtMs: 1,
        status: 'requested',
      },
    }

    await expect(callRpc('thread/resume', { threadId: 'thread-1' })).rejects.toMatchObject({
      name: 'CodexApiError',
      code: 'http_error',
      method: 'thread/resume',
      status: 502,
    })

    expect(compactionRequests.value['thread-1']).toMatchObject({ status: 'requested' })
  })
})
