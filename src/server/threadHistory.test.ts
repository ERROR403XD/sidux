import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadHistory, isHistoryPagingUnsupported, LEGACY_HISTORY_BYTE_LIMIT } from './threadHistory'

const support = async () => ({ historyPaging: true, resumeInitialPage: true, exactFork: true })
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

describe('native history', () => {
  it('rejects paginated or active rollback from metadata before any full read or mutation', async () => {
    for (const thread of [{ historyMode: 'paginated' }, { historyMode: 'legacy', status: { type: 'active' } }]) {
      const rpc = vi.fn(async () => ({ thread }))
      await expect(new ThreadHistory(rpc, support).assertRollbackAllowed('t')).rejects.toThrow(thread.historyMode === 'paginated' ? '不支持撤回' : '等待当前回合')
      expect(rpc).toHaveBeenCalledExactlyOnceWith('thread/read', { threadId: 't', includeTurns: false })
    }
    const rpc = vi.fn(async () => ({ thread: { historyMode: 'legacy', status: { type: 'idle' } } }))
    await expect(new ThreadHistory(rpc, support).assertRollbackAllowed('t')).resolves.toBeUndefined()
  })

  it('bootstraps recent turns in one resume call and preserves an opaque cursor', async () => {
    const rpc = vi.fn(async () => ({ thread: { id: 't', turns: [] }, initialTurnsPage: { data: [{ id: 'b', items: [] }, { id: 'a', items: [] }], nextCursor: 'opaque/+=' } }))
    const result = await new ThreadHistory(rpc, support).initial('thread/resume', { threadId: 't' })
    expect(rpc).toHaveBeenCalledExactlyOnceWith('thread/resume', { threadId: 't', excludeTurns: true, initialTurnsPage: { limit: 10, sortDirection: 'desc', itemsView: 'full' } })
    expect(result).toMatchObject({ thread: { turns: [{ id: 'a' }, { id: 'b' }] }, threadHistory: { nextCursor: 'opaque/+=', hasMoreOlder: true, source: 'native' } })
    expect(result).not.toHaveProperty('initialTurnsPage')
  })

  it('passes cursor verbatim and never turns a cursor error into a full read', async () => {
    const rpc = vi.fn(async (method: string) => {
      if (method === 'thread/read') return { thread: { id: 't', turns: [] } }
      throw new Error('invalid cursor')
    })
    await expect(new ThreadHistory(rpc, support).page('t', { cursor: 'opaque/+=' })).rejects.toThrow('invalid cursor')
    expect(rpc.mock.calls).toHaveLength(2)
    expect(rpc).toHaveBeenLastCalledWith('thread/turns/list', { threadId: 't', limit: 10, cursor: 'opaque/+=', sortDirection: 'desc', itemsView: 'full' })
  })

  it('loads one turn across item pages without losing question order or other items', async () => {
    const rpc = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'thread/read') return { thread: { id: 't', turns: [] } }
      return params.cursor
        ? { data: [{ turnId: 'turn', item: { id: 'q2', questions: [{ title: 'second' }] } }], nextCursor: null }
        : { data: [{ turnId: 'turn', item: { id: 'q1', questions: [{ title: 'first' }] } }], nextCursor: 'next' }
    })
    const result = await new ThreadHistory(rpc, support).turn('t', 'turn')
    expect(result).toMatchObject({ thread: { turns: [{ id: 'turn', items: [{ id: 'q1' }, { id: 'q2' }] }] } })
    expect(rpc).toHaveBeenLastCalledWith('thread/items/list', { threadId: 't', turnId: 'turn', limit: 100, sortDirection: 'asc', cursor: 'next' })
  })

  it('stops repeated item cursors and rejects items from another turn', async () => {
    for (const mode of ['repeated', 'wrong-turn']) {
      const rpc = vi.fn(async (method: string) => method === 'thread/read' ? { thread: {} } : { data: [{ turnId: mode === 'repeated' ? 'turn' : 'other', item: {} }], nextCursor: 'same' })
      await expect(new ThreadHistory(rpc, support).turn('t', 'turn')).rejects.toThrow(mode === 'repeated' ? '游标重复' : '其他回合')
      expect(rpc.mock.calls.length).toBeLessThanOrEqual(3)
    }
  })

  it('forks through the actual turn with Goal continuation deferred and never rolls back', async () => {
    const rpc = vi.fn(async () => ({ thread: { id: 'fork' } }))
    await new ThreadHistory(rpc, support).fork('t', 'last')
    expect(rpc).toHaveBeenCalledExactlyOnceWith('thread/fork', { threadId: 't', lastTurnId: 'last', excludeTurns: true, deferGoalContinuation: true })
    rpc.mockClear()
    await expect(new ThreadHistory(rpc, async () => ({ ...await support(), exactFork: false })).fork('t', 'last')).rejects.toThrow('不支持')
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('bounded legacy history', () => {
  async function fixture(size = 10) {
    const dir = await mkdtemp(join(tmpdir(), 'history-test-'))
    dirs.push(dir)
    const path = join(dir, 'thread.jsonl')
    await writeFile(path, 'x'.repeat(size))
    const metadata = { thread: { id: 't', preview: 'fixture', path } }
    return { metadata, path }
  }

  it('coalesces bounded reads and invalidates the cache on changes', async () => {
    const { metadata } = await fixture()
    const rpc = vi.fn(async () => ({ thread: { ...metadata.thread, turns: Array.from({ length: 12 }, (_, i) => ({ id: String(i), items: [] })) } }))
    const history = new ThreadHistory(rpc, async () => ({ historyPaging: false, resumeInitialPage: false, exactFork: false }))
    const [first, second] = await Promise.all([history.page('t', { metadata }), history.page('t', { metadata })])
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(first).toEqual(second)
    expect(first).toMatchObject({ source: 'legacy', hasMoreOlder: true })
    await history.page('t', { metadata, beforeTurnId: '2' })
    expect(rpc).toHaveBeenCalledTimes(1)
    history.invalidate('t')
    await history.page('t', { metadata })
    expect(rpc).toHaveBeenCalledTimes(2)
    await expect(history.page('t', { metadata, beforeTurnId: 'missing' })).rejects.toThrow('历史位置已变化')
  })

  it('rejects oversized files before requesting full history', async () => {
    const { metadata } = await fixture(LEGACY_HISTORY_BYTE_LIMIT + 1)
    const rpc = vi.fn()
    const history = new ThreadHistory(rpc, async () => ({ historyPaging: false, resumeInitialPage: false, exactFork: false }))
    await expect(history.page('t', { metadata })).rejects.toThrow('8 MB')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('keeps old browser beforeTurnId requests bounded and never returns the latest page by mistake', async () => {
    const { metadata } = await fixture()
    const rpc = vi.fn(async () => ({ thread: { ...metadata.thread, turns: [{ id: 'old', items: [] }, { id: 'anchor', items: [] }] } }))
    const history = new ThreadHistory(rpc, support)
    const page = await history.page('t', { metadata, beforeTurnId: 'anchor' })
    expect(page).toMatchObject({ result: { thread: { turns: [{ id: 'old' }] } }, source: 'legacy', hasMoreOlder: false })
    expect(rpc).toHaveBeenCalledExactlyOnceWith('thread/read', { threadId: 't', includeTurns: true })
    await expect(history.page('t', { metadata, beforeTurnId: 'anchor', source: 'native' })).rejects.toThrow('缺少历史游标')
  })

  it('does not cache a read that overlaps a change notification', async () => {
    const { metadata } = await fixture()
    let finish: (value: unknown) => void = () => {}
    const rpc = vi.fn(() => new Promise(resolve => { finish = resolve }))
    const history = new ThreadHistory(rpc, async () => ({ historyPaging: false, resumeInitialPage: false, exactFork: false }))
    const first = history.page('t', { metadata })
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1))
    history.invalidate('t')
    finish({ thread: { ...metadata.thread, turns: [] } })
    await first
    const second = history.page('t', { metadata })
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2))
    finish({ thread: { ...metadata.thread, turns: [] } })
    await second
  })

  it('only recognizes explicit unsupported paging errors', () => {
    expect(isHistoryPagingUnsupported(new Error('pagination is not supported'))).toBe(true)
    for (const message of ['unauthorized', 'invalid cursor', 'thread not found', 'request timed out']) expect(isHistoryPagingUnsupported(new Error(message))).toBe(false)
  })
})
