import { afterEach, describe, expect, it, vi } from 'vitest'
import { listTaskPage } from './tasks'
afterEach(() => vi.unstubAllGlobals())
describe('bounded task lookup', () => {
  it('keeps native cursor, parent and source filters and rejects unrelated children', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result: { data: [{ id: 'child', parentThreadId: 'parent' }], nextCursor: 'next' } }) })
    vi.stubGlobal('fetch', fetcher)
    const page = await listTaskPage({ parentId: 'parent', cursor: 'before' })
    expect(page.nextCursor).toBe('next')
    expect(page.rows[0].parentThreadId).toBe('parent')
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ method: 'thread/list', params: { parentThreadId: 'parent', cursor: 'before', limit: 20, sourceKinds: ['subAgentThreadSpawn'] } })
    await expect(listTaskPage({ parentId: 'another' })).rejects.toThrow('父任务关系')
  })
  it('uses explicit native body search and caps the snippet', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result: { data: [{ thread: { id: 'found' }, snippet: 'x'.repeat(5000) }] } }) })
    vi.stubGlobal('fetch', fetcher)
    const page = await listTaskPage({ query: 'needle', mode: 'body' })
    expect(JSON.parse(fetcher.mock.calls[0][1].body).method).toBe('thread/search')
    expect(page.rows[0].snippet?.length).toBe(2000)
    expect(page.nextCursor).toBe(null)
  })
})
