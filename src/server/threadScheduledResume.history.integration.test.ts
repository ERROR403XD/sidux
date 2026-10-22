import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { ThreadHistory } from './threadHistory'
import { ThreadScheduledResume } from './threadScheduledResume'
import { createThreadScheduledResumeRuntime } from './threadScheduledResumeRuntime'

it.each(['submitted', 'unknown', 'failed'] as const)('clears a recovered %s schedule from acceptance with zero history RPCs', async status => {
  const home = await mkdtemp(join(tmpdir(), 'sidux-full-review-history-'))
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const turn = { id: 'scheduled-turn', status: 'completed', error: null }
  const history = new ThreadHistory(async (method, params) => {
    calls.push({ method, params })
    if (method === 'thread/turns/list') {
      if (params.cursor === 'older') return { data: [turn], nextCursor: null }
      return {
        data: Array.from({ length: 10 }, (_, index) => ({ id: `newer-${index}`, status: 'completed' })),
        nextCursor: 'older',
      }
    }
    throw new Error(`Unexpected RPC: ${method}`)
  }, async () => ({ historyPaging: true, resumeInitialPage: true, exactFork: true }))
  const queue = {
    history,
    deliveries: {
      result: vi.fn(async () => ({ id: 'attempt', threadId: 'thread', status: 'accepted', turnId: turn.id })),
      reconcile: vi.fn(),
    },
    store: { remove: vi.fn() },
    submit: vi.fn(),
  }
  const runtime = createThreadScheduledResumeRuntime({ notifyScheduledResumeChanged: vi.fn() }, queue as never)
  await writeFile(join(home, 'codexapp-scheduled-resume.json'), JSON.stringify({
    version: 1,
    marks: {
      thread: {
        at: 1000,
        status,
        attemptId: 'attempt',
        attemptedAt: 1000,
        contextId: 'context',
        choice: { model: 'model', effort: 'high', tier: '' },
      },
    },
  }))
  const scheduler = new ThreadScheduledResume(home, runtime, () => 2000, false)
  try {
    await scheduler.ready
    for (let index = 0; index < 3; index += 1) await scheduler.tick()
    expect(await scheduler.snapshot()).toEqual({})
    expect(calls).toEqual([])
    expect(queue.submit).not.toHaveBeenCalled()
  } finally {
    await scheduler.close()
    await rm(home, { recursive: true, force: true })
  }
})
