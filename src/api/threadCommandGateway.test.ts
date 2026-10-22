import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./codexRpcClient', () => ({ rpcCall: vi.fn() }))

import { rpcCall } from './codexRpcClient'
import { forkThread } from './threadCommandGateway'

describe('thread command gateway', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('preserves the single-argument extended-history fork contract', async () => {
    vi.mocked(rpcCall).mockResolvedValueOnce({
      model: 'gpt-6-astra',
      thread: {
        id: 'forked-thread',
        cwd: '/workspace/project',
        turns: [{
          id: 'turn-1',
          status: 'completed',
          items: [{ id: 'message-1', type: 'agentMessage', text: 'Forked history' }],
        }],
      },
    })

    await expect(forkThread('source-thread')).resolves.toEqual({
      threadId: 'forked-thread',
      cwd: '/workspace/project',
      model: 'gpt-6-astra',
      messages: [expect.objectContaining({ id: 'message-1', text: 'Forked history' })],
    })
    expect(rpcCall).toHaveBeenCalledWith('thread/fork', {
      threadId: 'source-thread',
      persistExtendedHistory: true,
    })
  })
})
