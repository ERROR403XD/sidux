import { describe, expect, it, vi } from 'vitest'
import { ThreadGoalReader } from './threadGoalReader'
import type { ThreadGoal } from '../api/threadCommands'
const goal = (threadId: string): ThreadGoal => ({ threadId, objective: 'fixture goal', status: 'paused', tokenBudget: 1000, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 })
describe('bounded native goal summaries', () => {
  it('supplies known GOAL statuses synchronously without extra reads or TTL expiry during a long turn', async () => {
    let now = 1
    const rpc = vi.fn(async () => ({ goal: { ...goal('thread'), status: 'active' } }))
    const reader = new ThreadGoalReader(rpc, () => now)
    expect(reader.peekStatus('thread')).toBeUndefined()
    await reader.snapshot(['thread'])
    now += 60_000
    expect(reader.peekStatus('thread')).toBe('active')
    expect(rpc).toHaveBeenCalledOnce()
    reader.observe({ method: 'thread/goal/updated', params: { threadId: 'thread', goal: { ...goal('thread'), status: 'complete' } } })
    expect(reader.peekStatus('thread')).toBe('complete')
    reader.observe({ method: 'thread/goal/cleared', params: { threadId: 'thread' } })
    expect(reader.peekStatus('thread')).toBeNull()
    expect(rpc).toHaveBeenCalledOnce()
  })
  it('bounds native concurrency across batches and caches empty and present goals', async () => {
    let active = 0, peak = 0, requests = 0, now = 1
    const reader = new ThreadGoalReader(async (_method, params) => { requests++; active++; peak = Math.max(active, peak); await new Promise(resolve => setTimeout(resolve, 1)); active--; const id = (params as { threadId: string }).threadId; return { goal: id === 'goal-thread' ? goal(id) : null } }, () => now)
    const ids = ['goal-thread', ...Array.from({ length: 40 }, (_, i) => String(i))]
    const [a, b] = await Promise.all([reader.snapshot(ids), reader.snapshot(ids)])
    expect(a).toEqual(b); expect(a['goal-thread']?.status).toBe('paused'); expect(peak).toBe(4); expect(requests).toBe(ids.length)
    now += 30001; await reader.snapshot(['goal-thread']); expect(requests).toBe(ids.length + 1)
    reader.observe({ method: 'thread/goal/cleared', params: { threadId: 'goal-thread' } }); expect((await reader.snapshot(['goal-thread']))['goal-thread']).toBeNull()
    await expect(reader.snapshot(Array(101).fill('thread'))).rejects.toThrow('100')
  })
  it('does not overwrite a newer goal notification with an in-flight stale read', async () => {
    let finish!: (value: unknown) => void
    const reader = new ThreadGoalReader(() => new Promise(resolve => { finish = resolve }))
    const pending = reader.snapshot(['fixture']); await Promise.resolve()
    reader.observe({ method: 'thread/goal/updated', params: { threadId: 'fixture', goal: goal('fixture') } })
    finish({ goal: null }); expect((await pending).fixture).toEqual(goal('fixture'))
  })
  it('refreshes only the selected stale goal after reconnection and degrades failed native data', async () => {
    let reads = 0
    let current = goal('selected')
    const reader = new ThreadGoalReader(async (_method, params) => {
      reads += 1
      return { goal: (params as { threadId: string }).threadId === 'selected' ? current : null }
    })
    await reader.snapshot(['selected', 'sidebar'])
    current = { ...current, status: 'blocked', tokensUsed: 200 }
    expect((await reader.snapshot(['selected', 'sidebar'])).selected?.status).toBe('paused')
    expect((await reader.snapshot(['selected', 'sidebar'], 'selected')).selected?.tokensUsed).toBe(200)
    expect(reads).toBe(3)
    const degraded = new ThreadGoalReader(async (_, params) => {
      const id = (params as { threadId: string }).threadId
      if (id === 'selected') return { goal: goal(id) }
      throw new Error('unavailable')
    })
    expect(await degraded.snapshot(['selected', 'sidebar'])).toEqual({ selected: goal('selected') })
    const malformed = new ThreadGoalReader(async () => ({ goal: {} }))
    expect(await malformed.snapshot(['selected'])).toEqual({})
  })

  it('keeps a cached goal when an individual native read fails', async () => {
    const rpc = vi.fn(async (_method: string, params: unknown) => {
      const id = (params as { threadId: string }).threadId
      if (id === 'cached') return { goal: goal(id) }
      throw new Error('unavailable')
    })
    const reader = new ThreadGoalReader(rpc)
    await reader.snapshot(['cached'])
    expect(await reader.snapshot(['cached', 'failed'])).toEqual({ cached: goal('cached') })
    expect(rpc).toHaveBeenCalledTimes(2)
  })
})
