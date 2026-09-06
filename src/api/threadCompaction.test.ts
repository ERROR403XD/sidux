import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ rpcCall: vi.fn() }))
vi.mock('./codexRpcClient', () => mocks)
let values: Map<string, string>
let fetcher: ReturnType<typeof vi.fn>
const turn = (id: string, items: unknown[] = [], status = 'completed') => ({ id, items, status, error: null })
const response = (turns = [turn('baseline')], status = 'idle') => ({ ok: true, json: async () => ({ result: { thread: { id: 't', status: { type: status }, turns } } }) })
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  values = new Map()
  vi.stubGlobal('window', { sessionStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } })
  fetcher = vi.fn().mockResolvedValue(response())
  vi.stubGlobal('fetch', fetcher)
  mocks.rpcCall.mockResolvedValue({})
})
afterEach(() => vi.unstubAllGlobals())

describe('manual compaction request recovery', () => {
  it('persists before native dispatch, coalesces clicks and resolves actual lifecycle notifications', async () => {
    const api = await import('./threadCompaction')
    mocks.rpcCall.mockImplementation(async () => {
      expect(JSON.parse(values.get('codexapp.compaction.v1')!).t.beforeTurnId).toBe('baseline')
      return {}
    })
    await Promise.all([api.compactThread('t'), api.compactThread('t')])
    expect(mocks.rpcCall).toHaveBeenCalledTimes(1)
    await expect(api.compactThread('t')).rejects.toThrow('已有压缩')
    const params = { threadId: 't', turnId: 'new', item: { id: 'compact', type: 'contextCompaction' }, startedAtMs: 100 }
    api.observeCompactionNotification({ method: 'item/started', params, atIso: '' })
    expect(api.compactionRequests.value.t.status).toBe('running')
    api.observeCompactionNotification({ method: 'item/completed', params: { ...params, completedAtMs: 500 }, atIso: '' })
    expect(api.compactionRequests.value.t.progress?.durationMs).toBe(400)
  })
  it('restores an ambiguous request after reload and checks bounded history without resending', async () => {
    let api = await import('./threadCompaction')
    mocks.rpcCall.mockRejectedValueOnce(Error('response lost'))
    await expect(api.compactThread('t')).rejects.toThrow('response lost')
    expect(api.compactionRequests.value.t.status).toBe('unknown')
    vi.resetModules()
    api = await import('./threadCompaction')
    api.restoreCompactionRequests()
    expect(api.compactionRequests.value.t.status).toBe('unknown')
    fetcher.mockResolvedValue(response([turn('baseline'), turn('new', [{ id: 'compact', type: 'contextCompaction' }])]))
    await api.checkThreadCompaction('t')
    expect(api.compactionRequests.value.t.status).toBe('completed')
    expect(mocks.rpcCall).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls.at(-1)![0]).toContain('limit=20')
  })
  it('does not confuse an older compaction or an unknown turn with completion of this request', async () => {
    const api = await import('./threadCompaction')
    fetcher.mockResolvedValue(response([turn('baseline', [{ id: 'old', type: 'contextCompaction' }])]))
    await api.compactThread('t')
    await api.checkThreadCompaction('t')
    expect(api.compactionRequests.value.t.status).toBe('unknown')
    await api.compactThread('t', true)
    expect(mocks.rpcCall).toHaveBeenLastCalledWith('thread/compact/start', { threadId: 't', repeatUnknown: true })
  })
  it('refuses dispatch on storage failure or active native work', async () => {
    const api = await import('./threadCompaction')
    window.sessionStorage.setItem = () => { throw Error('unavailable') }
    await expect(api.compactThread('t')).rejects.toThrow('无法保存')
    expect(mocks.rpcCall).not.toHaveBeenCalled()
    fetcher.mockResolvedValue(response([turn('baseline', [], 'inProgress')], 'active'))
    await expect(api.compactThread('t')).rejects.toThrow('当前任务运行中')
    expect(mocks.rpcCall).not.toHaveBeenCalled()
  })
  it('restores a known interrupted request using its exact turn id even without a native item', async () => {
    const api = await import('./threadCompaction')
    await api.compactThread('t')
    api.observeCompactionNotification({ method: 'item/started', params: { threadId: 't', turnId: 'new', item: { id: 'compact', type: 'contextCompaction' } }, atIso: '' })
    const history = { thread: { id: 't', turns: [turn('baseline'), turn('new', [], 'interrupted')] } }
    api.observeCompactionHistory(history)
    expect(api.compactionRequests.value.t.status).toBe('interrupted')
    expect(api.restoreTrackedCompactionMessage([], history)[0]).toMatchObject({ turnId: 'new', compaction: { status: 'interrupted' } })
    const paginatedHistory = { thread: { id: 't', turns: [...history.thread.turns, turn('later')] } }
    const recovered = api.restoreTrackedCompactionMessage([
      { id: 'earlier', role: 'user', text: 'before', turnIndex: 100 },
      { id: 'later', role: 'assistant', text: 'after', turnIndex: 102 },
    ], paginatedHistory, 100)
    expect(recovered.map(message => message.id)).toEqual(['earlier', 'compact', 'later'])
    expect(recovered[1].turnIndex).toBe(101)
  })
})
