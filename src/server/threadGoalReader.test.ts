import { describe, expect, it } from 'vitest'
import { ThreadGoalReader } from './threadGoalReader'
import type { ThreadGoal } from '../api/threadCommands'
const goal = (threadId: string): ThreadGoal => ({ threadId, objective: 'fixture goal', status: 'paused', tokenBudget: 1000, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 })
describe('bounded native goal summaries', () => {
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
})
