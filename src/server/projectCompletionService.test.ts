import { expect, it, vi } from 'vitest'
import { createProjectCompletionService } from './projectCompletionService'

it('includes unloaded rows, limits reads to four, and acknowledges only the project click snapshot', async () => {
  const entries = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`t-${index}`, `turn-${index}`]))
  let active = 0
  let maximum = 0
  const completions = { read: vi.fn(async () => ({ ...entries })), acknowledgeMany: vi.fn(async () => {}) }
  const rpc = vi.fn(async (_method, { threadId, includeTurns }) => {
    expect(includeTurns).toBe(false)
    active++
    maximum = Math.max(maximum, active)
    await new Promise(resolve => setTimeout(resolve, 2))
    active--
    if (threadId === 't-11') throw new Error('thread not found')
    return { thread: { cwd: threadId === 't-10' ? '/other' : '/workspace/project' } }
  })
  const read = createProjectCompletionService(completions, { rpc } as never, async () => ({
    order: ['/workspace/project', '/other'], labels: {}, active: [], projectOrder: [],
  }) as never)
  await read('project')
  expect(maximum).toBe(4)
  expect(rpc).toHaveBeenCalledTimes(12)
  expect(completions.acknowledgeMany).toHaveBeenCalledExactlyOnceWith(Object.fromEntries(Object.entries(entries).slice(0, 10)))
})

it('preserves every mark if metadata fails for an uncertain reason', async () => {
  const completions = { read: async () => ({ marked: 'turn' }), acknowledgeMany: vi.fn() }
  const read = createProjectCompletionService(completions, { rpc: vi.fn(async () => { throw new Error('connection unavailable') }) } as never, async () => ({ order: [], labels: {}, active: [], projectOrder: [] }) as never)
  await expect(read('project')).rejects.toThrow('unavailable')
  expect(completions.acknowledgeMany).not.toHaveBeenCalled()
})
