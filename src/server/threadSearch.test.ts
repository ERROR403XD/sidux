import { describe, expect, it, vi } from 'vitest'
import { ThreadSearch } from './threadSearch'

function fixture(count = 4) {
  let rows = Array.from({ length: count }, (_, i) => ({ id: String(i), name: `title-${i}`, preview: '', updatedAt: 1 }))
  const content = new Map(rows.map(row => [row.id, `body-${row.id}`]))
  const titles: Record<string, string> = {}
  const dependencies = {
    list: vi.fn(async (cursor: string | null) => {
      const start = Number(cursor ?? 0)
      return { data: rows.slice(start, start + 100), nextCursor: start + 100 < rows.length ? String(start + 100) : null }
    }),
    body: vi.fn(async (row: Record<string, unknown> & { id: string }) => ({ text: content.get(row.id) || '', truncated: false })),
    titles: vi.fn(async () => titles),
  }
  const search = new ThreadSearch(dependencies)
  const run = (query: string, signal = new AbortController().signal) => search.search(query, 1000, signal)
  return { search, run, dependencies, content, titles, rows, remove(id: string) { rows = rows.filter(row => row.id !== id) } }
}

describe('bounded thread search', () => {
  it('reuses bodies and only rereads changed threads, including changes within the same timestamp', async () => {
    const f = fixture()
    expect((await f.run('body-1')).threadIds).toEqual(['1'])
    await f.run('body-2')
    expect(f.dependencies.list).toHaveBeenCalledTimes(1)
    expect(f.dependencies.body).toHaveBeenCalledTimes(4)
    f.content.set('1', 'new phrase')
    f.search.invalidate('1')
    expect((await f.run('new phrase')).threadIds).toEqual(['1'])
    expect(f.dependencies.body).toHaveBeenCalledTimes(5)
    expect((await f.run('body-1')).threadIds).toEqual([])
  })

  it('updates renamed titles and removes archived threads from results', async () => {
    const f = fixture()
    await f.run('title-1')
    f.titles['1'] = 'renamed'
    f.search.invalidate('1')
    expect((await f.run('renamed')).threadIds).toEqual(['1'])
    expect((await f.run('title-1')).threadIds).toEqual([])
    f.remove('1')
    f.search.invalidate('1')
    expect((await f.run('renamed')).threadIds).toEqual([])
  })

  it('reports title and body coverage and bounds title pages and body reads', async () => {
    const f = fixture(1200)
    const result = await f.run('title-999')
    expect(result.threadIds).toEqual(['999'])
    expect(result).toMatchObject({ indexedThreadCount: 1000, titleScopeComplete: false, bodyThreadCount: 100, bodyThreadLimit: 100, bodyTurnLimit: 50 })
    expect(f.dependencies.list).toHaveBeenCalledTimes(10)
    expect(f.dependencies.body).toHaveBeenCalledTimes(100)
    expect((await f.run('body-101')).threadIds).toEqual([])
  })

  it('reports individual body failures and truncation without treating them as complete coverage', async () => {
    const f = fixture()
    f.dependencies.body.mockImplementation(async row => {
      if (row.id === '1') throw new Error('unavailable')
      return { text: row.id === '2' ? 'x'.repeat(200_001) : `body-${row.id}`, truncated: row.id === '3' }
    })
    expect(await f.run('body-0')).toMatchObject({ threadIds: ['0'], bodyThreadCount: 3, partialBodyCount: 2, failedBodyCount: 1 })
  })

  it('does not publish a body that completed after invalidation', async () => {
    const f = fixture(1)
    let finish: (value: { text: string; truncated: boolean }) => void = () => {}
    f.dependencies.body.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = f.run('updated')
    await vi.waitFor(() => expect(f.dependencies.body).toHaveBeenCalledTimes(1))
    f.content.set('0', 'updated')
    f.search.invalidate('0')
    finish({ text: 'stale', truncated: false })
    expect((await pending).threadIds).toEqual(['0'])
    expect(f.dependencies.body).toHaveBeenCalledTimes(2)
    expect((await f.run('stale')).threadIds).toEqual([])
    expect(f.dependencies.body).toHaveBeenCalledTimes(2)
  })

  it('cancels after the current four reads, does not start extra batches, and bounds concurrent clients', async () => {
    const f = fixture(12)
    const releases: Array<() => void> = []
    let active = 0
    let peak = 0
    f.dependencies.body.mockImplementation(row => new Promise(resolve => {
      active += 1
      peak = Math.max(peak, active)
      releases.push(() => { active -= 1; resolve({ text: `body-${row.id}`, truncated: false }) })
    }))
    const controller = new AbortController()
    const cancelled = f.run('body', controller.signal).catch(error => error.message)
    await vi.waitFor(() => expect(releases).toHaveLength(4))
    controller.abort()
    const nextController = new AbortController()
    const next = f.run('body', nextController.signal).catch(error => error.message)
    nextController.abort()
    for (const release of releases) release()
    expect(await cancelled).toBe('Search cancelled')
    expect(await next).toBe('Search cancelled')
    expect(f.dependencies.body).toHaveBeenCalledTimes(4)
    expect(peak).toBe(4)
  })

  it('refreshes expired metadata and invalidates bodies when updatedAt changes without a live event', async () => {
    const f = fixture(1)
    await f.run('body-0')
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 6000)
    try {
      f.rows[0].updatedAt = 2
      f.content.set('0', 'external update')
      expect((await f.run('external update')).threadIds).toEqual(['0'])
      expect(f.dependencies.body).toHaveBeenCalledTimes(2)
    } finally {
      clock.mockRestore()
    }
  })
})


it('checks the file version even when metadata timestamps do not change', async () => {
  const f = fixture(1)
  let version = 'file-1'
  const search = new ThreadSearch({ ...f.dependencies, version: async () => version })
  const run = (query: string) => search.search(query, 10, new AbortController().signal)
  await run('body-0')
  f.content.set('0', 'external append')
  version = 'file-2'
  expect((await run('external append')).threadIds).toEqual(['0'])
  expect(f.dependencies.body).toHaveBeenCalledTimes(2)
})

it('retains the newest text when a large body reaches the character limit', async () => {
  const f = fixture(1)
  f.content.set('0', 'x'.repeat(200_100) + 'LATEST_CONTENT')
  expect(await f.run('LATEST_CONTENT')).toMatchObject({ threadIds: ['0'], partialBodyCount: 1 })
})
