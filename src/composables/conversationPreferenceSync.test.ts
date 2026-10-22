import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWebConversationPreferences, WEB_CONVERSATION_PREFERENCES_KEY } from '../webConversationPreferences'
import { CONVERSATION_PENDING_KEY, createConversationPreferenceSync } from './conversationPreferenceSync'

const api = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }))
vi.mock('../api/threadPreferencesGateway', () => ({ getConversationPreferences: api.read, persistConversationPreferences: api.write }))
const a = { model: 'astra', provider: 'codex', effort: 'high', tier: 'priority' }
const b = { model: 'sol', provider: 'codex', effort: 'low', tier: '' }
const empty = () => ({ defaults: null, remember: true, threads: {} })
function setup(initial = empty()) {
  const storage = { getItem: () => JSON.stringify(initial), setItem: vi.fn() }
  const preferences = useWebConversationPreferences(storage, patch => sync.save(patch))
  const sync = createConversationPreferenceSync(preferences)
  return { preferences, sync, storage }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
beforeEach(() => { vi.resetAllMocks(); api.write.mockResolvedValue(undefined); api.read.mockResolvedValue(empty()) })

describe('server conversation preference synchronization', () => {
  it('loads server settings into a browser without any local conversation memory', async () => {
    const test = setup()
    api.read.mockResolvedValue({ defaults: b, remember: true, threads: { A: { source: 'web', saved: a } } })
    expect(await test.sync.refresh('A', () => true)).toBe(true)
    expect(test.preferences.enter('A', b)).toEqual(a)
    expect(test.preferences.enter('', a)).toEqual(b)
    expect(api.write).not.toHaveBeenCalled()
  })
  it('caches remote preferences for offline reentry after a reload', async () => {
    const test = setup()
    api.read.mockResolvedValue({ defaults: b, remember: true, threads: { A: { source: 'web', saved: a } } })
    await test.sync.refresh('A', () => true)
    expect(test.storage.setItem).toHaveBeenCalledWith(WEB_CONVERSATION_PREFERENCES_KEY, expect.any(String))
    const cached = JSON.parse(test.storage.setItem.mock.calls.at(-1)![1])
    expect(cached.threads.A.saved).toEqual(a)
    expect(api.write).not.toHaveBeenCalled()
  })

  it('coalesces rapid model and effort edits and sends only changed entries', async () => {
    const test = setup()
    test.preferences.register('A', a)
    test.preferences.select('A', { ...a, effort: 'ultra' })
    await test.sync.flush()
    expect(api.write).toHaveBeenCalledExactlyOnceWith({ threads: { A: { source: 'web', saved: { ...a, effort: 'ultra' } } } })
  })
  it('imports legacy data once per page and never sends it as an authoritative snapshot', async () => {
    const initial = { defaults: a, remember: false, threads: { A: { source: 'web' as const, saved: a } } }
    const preferences = useWebConversationPreferences({ getItem: key => key === WEB_CONVERSATION_PREFERENCES_KEY ? JSON.stringify(initial) : null, setItem: vi.fn() })
    const sync = createConversationPreferenceSync(preferences)
    await sync.refresh('A', () => true)
    await sync.refresh('B', () => true)
    expect(api.write).toHaveBeenCalledExactlyOnceWith({ migrate: initial })
  })
  it('ignores a late read after a user edit or navigation', async () => {
    const test = setup()
    const read = deferred<ReturnType<typeof empty>>()
    api.read.mockReturnValueOnce(read.promise)
    const refresh = test.sync.refresh('A', () => true)
    await vi.waitFor(() => expect(api.read).toHaveBeenCalledOnce())
    test.preferences.register('A', a)
    read.resolve(empty())
    expect(await refresh).toBe(false)
    expect(test.preferences.state.value.threads.A.saved).toEqual(a)
    await test.sync.flush()
    expect(await test.sync.refresh('B', () => false)).toBe(false)
    expect(test.preferences.state.value.threads.A.saved).toEqual(a)
  })
  it('retains failed edits, displays an error, and retries before reading shared state', async () => {
    const test = setup()
    api.write.mockRejectedValueOnce(new Error('offline'))
    test.preferences.register('A', a)
    expect(await test.sync.flush()).toBe(false)
    expect(test.preferences.error.value).toContain('保存失败')
    test.preferences.select('A', b)
    await test.sync.flush()
    expect(api.write).toHaveBeenLastCalledWith({ threads: { A: { source: 'web', saved: b } } })
    expect(test.preferences.error.value).toBe('')
  })
  it('keeps local state when the server read fails', async () => {
    const test = setup()
    test.preferences.register('A', a)
    api.read.mockRejectedValueOnce(new Error('offline'))
    expect(await test.sync.refresh('A', () => true)).toBe(false)
    expect(test.preferences.state.value.threads.A.saved).toEqual(a)
    expect(test.preferences.error.value).toContain('同步失败')
  })

  it.each(['failed', 'in flight'])('replays only unconfirmed edits after reload when a write was %s', async phase => {
    const tab = new Map<string, string>()
    const storage = { getItem: (key: string) => tab.get(key) ?? null, setItem: (key: string, value: string) => { tab.set(key, value) }, removeItem: (key: string) => { tab.delete(key) } }
    const preferences = useWebConversationPreferences(undefined, patch => sync.save(patch))
    const sync = createConversationPreferenceSync(preferences, storage)
    const blocked = deferred<void>()
    if (phase === 'failed') api.write.mockRejectedValueOnce(new Error('offline'))
    else api.write.mockReturnValueOnce(blocked.promise)
    preferences.register('A', b)
    if (phase === 'failed') expect(await sync.flush()).toBe(false)
    else await vi.waitFor(() => expect(api.write).toHaveBeenCalledOnce())
    expect(JSON.parse(tab.get(CONVERSATION_PENDING_KEY)!).threads.A.saved).toEqual(b)
    const reloaded = useWebConversationPreferences()
    const reloadSync = createConversationPreferenceSync(reloaded, storage)
    await reloadSync.flush()
    expect(api.write).toHaveBeenLastCalledWith({ threads: { A: { source: 'web', saved: b } } })
    expect(tab.has(CONVERSATION_PENDING_KEY)).toBe(false)
    blocked.resolve()
    await sync.flush()
  })

  it('keeps edits made during a write in the reload record until their own acknowledgement', async () => {
    const tab = new Map<string, string>()
    const storage = { getItem: (key: string) => tab.get(key) ?? null, setItem: (key: string, value: string) => { tab.set(key, value) }, removeItem: (key: string) => { tab.delete(key) } }
    const preferences = useWebConversationPreferences(undefined, patch => sync.save(patch))
    const sync = createConversationPreferenceSync(preferences, storage)
    const first = deferred<void>()
    api.write.mockReturnValueOnce(first.promise).mockRejectedValueOnce(new Error('offline'))
    preferences.register('A', a)
    await vi.waitFor(() => expect(api.write).toHaveBeenCalledOnce())
    preferences.select('A', b)
    preferences.register('B', a)
    expect(JSON.parse(tab.get(CONVERSATION_PENDING_KEY)!).threads.A.saved).toEqual(b)
    first.resolve()
    expect(await sync.flush()).toBe(false)
    const pending = JSON.parse(tab.get(CONVERSATION_PENDING_KEY)!)
    expect(pending.threads.A.saved).toEqual(b)
    expect(pending.threads.B.saved).toEqual(a)
  })
})
