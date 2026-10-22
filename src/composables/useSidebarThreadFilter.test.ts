import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, nextTick, ref } from 'vue'
import { useSidebarThreadFilter } from './useSidebarThreadFilter'
import type { UiProjectGroup, UiThread } from '../types/codex'

const gateway = vi.hoisted(() => ({ subscribeRpcNotifications: vi.fn() }))
vi.mock('../api/codexRpcClient', () => gateway)
const toast = vi.hoisted(() => ({ notifyOperation: vi.fn() }))
vi.mock('./useOperationToast', () => toast)
const renderer = createRenderer<any, any>({
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  insert() {}, remove() {}, setText() {}, setElementText() {},
  parentNode: () => null, nextSibling: () => null, patchProp() {},
})
let unmount = () => {}
afterEach(() => { unmount(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks() })
function mount() {
  vi.useFakeTimers()
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
  const listeners = new Set<(n: any) => void>()
  gateway.subscribeRpcNotifications.mockImplementation(fn => { listeners.add(fn); return () => listeners.delete(fn) })
  const groups = ref<UiProjectGroup[]>([{ projectName: 'project', threads: ['a', 'b'].map(id => ({ id, unread: true, inProgress: false, updatedAtIso: 'now' } as UiThread)) }])
  const selected = ref('')
  let state!: ReturnType<typeof useSidebarThreadFilter>
  const app = renderer.createApp(defineComponent({ setup() { state = useSidebarThreadFilter(groups, selected); return () => null } }))
  app.mount({})
  listeners.forEach(fn => fn({ method: 'ready', params: {} }))
  unmount = () => app.unmount()
  return { groups, selected, state, notify: (method: string, params: unknown) => listeners.forEach(fn => fn({ method, params })) }
}
describe('sidebar selection lifetime', () => {
  it.each(['unknown', 'failure'] as const)('preserves cached matches across 201 rows when a later batch returns %s', async outcome => {
    let phase = 0
    let release!: () => void
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      if (url === '/codex-api/thread-interruptions') return { ok: true, json: async () => ({ data: {} }) }
      const ids: string[] = JSON.parse(options.body).threadIds
      if (phase && ids[0] === 'row-100') {
        await new Promise<void>(resolve => { release = resolve })
        if (outcome === 'failure') return { ok: false }
      }
      return { ok: true, json: async () => ({ data: Object.fromEntries(ids.map(id => [id, phase && id === 'row-200' ? null : id === 'row-200'])) }) }
    }))
    const { groups, state } = mount()
    groups.value[0]!.threads = Array.from({ length: 201 }, (_, index) => ({ id: `row-${index}`, inProgress: false, updatedAtIso: 'v1' } as UiThread))
    state.filter.value = 'interrupted'
    await vi.advanceTimersByTimeAsync(150)
    expect(state.interrupted.value['row-200']).toBe(true)
    phase = 1
    const reading = state.refresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(state.interrupted.value['row-200']).toBe(true)
    expect(state.loading.value).toBe(true)
    release()
    await reading
    expect(state.interrupted.value['row-200']).toBe(true)
    expect(state.incomplete.value).toBe(true)
    expect(toast.notifyOperation).toHaveBeenCalledOnce()
  })

  it('distinguishes initial unknown results from confirmed empty and only warns once until recovery', async () => {
    let known = false
    vi.stubGlobal('fetch', vi.fn(async url => ({ ok: true, json: async () => ({ data: url === '/codex-api/thread-interruptions' ? {} : { a: known ? false : null, b: false } }) })))
    const { state } = mount()
    state.filter.value = 'interrupted'
    await vi.advanceTimersByTimeAsync(150)
    await state.refresh()
    expect(state.incomplete.value).toBe(true)
    expect(state.loading.value).toBe(false)
    expect(state.interrupted.value.a).toBeNull()
    expect(toast.notifyOperation).toHaveBeenCalledOnce()
    known = true
    await state.refresh()
    expect(state.incomplete.value).toBe(false)
    expect(state.interrupted.value).toEqual({ a: false, b: false })
    known = false
    await state.refresh()
    expect(toast.notifyOperation).toHaveBeenCalledTimes(2)
  })

  it('retains known statuses when individual reads are unknown and warns once per request outage', async () => {
    const fetcher = vi.fn(url => {
      if (url === '/codex-api/thread-interruptions') return Promise.resolve({ ok: true, json: async () => ({ data: {} }) })
      if (fetcher.mock.calls.filter(call => call[0] === url).length <= 2) return Promise.resolve({ ok: true, json: async () => ({ data: { a: true, b: false } }) })
      if (fetcher.mock.calls.filter(call => call[0] === url).length === 3) return Promise.resolve({ ok: true, json: async () => ({ data: { a: null, b: null } }) })
      return Promise.resolve({ ok: false })
    })
    vi.stubGlobal('fetch', fetcher)
    const { groups, state } = mount()
    state.filter.value = 'interrupted'
    await vi.advanceTimersByTimeAsync(150)
    expect(state.interrupted.value).toEqual({ a: true, b: false })
    groups.value[0]!.threads[0]!.updatedAtIso = 'changed'
    await vi.advanceTimersByTimeAsync(150)
    expect(state.interrupted.value).toEqual({ a: true, b: false })
    groups.value[0]!.threads[1]!.updatedAtIso = 'changed'
    await vi.advanceTimersByTimeAsync(150)
    expect(state.interrupted.value).toEqual({ a: true, b: false })
    groups.value[0]!.threads[0]!.updatedAtIso = 'changed-again'
    await vi.advanceTimersByTimeAsync(150)
    expect(state.interrupted.value).toEqual({ a: true, b: false })
    expect(toast.notifyOperation).toHaveBeenCalledTimes(1)
    expect(toast.notifyOperation).toHaveBeenCalledWith('会话状态读取失败，请重试', 'warning', 'conversation-status')
  })

  it('keeps known interrupted matches visible while a new status read is pending', async () => {
    let finish!: (value: unknown) => void
    const fetcher = vi.fn(url => {
      if (url === '/codex-api/thread-interruptions') return Promise.resolve({ ok: true, json: async () => ({ data: {} }) })
      return new Promise(resolve => { finish = resolve })
    })
    vi.stubGlobal('fetch', fetcher)
    const { state, notify } = mount()
    notify('codexapp/interruptions/changed', { threadId: 'a', issues: [{ turnId: 'turn-a', kind: 'quota' }] })
    state.filter.value = 'interrupted'
    await nextTick()
    expect(state.loading.value).toBe(true)
    expect(state.interrupted.value).toEqual({ a: true })
    await vi.advanceTimersByTimeAsync(150)
    finish({ ok: true, json: async () => ({ data: { a: false, b: false } }) })
    await vi.advanceTimersByTimeAsync(200)
    expect(state.interrupted.value).toEqual({ a: true, b: false })
  })

  it('keeps the interrupted empty state suppressed while a stale status is reread', async () => {
    const fetcher = vi.fn(url => {
      if (url === '/codex-api/thread-interruptions') return Promise.resolve({ ok: true, json: async () => ({ data: {} }) })
      return Promise.resolve({ ok: true, json: async () => ({ data: { a: true, b: false } }) })
    })
    vi.stubGlobal('fetch', fetcher)
    const { state, notify } = mount()
    state.filter.value = 'interrupted'
    await vi.advanceTimersByTimeAsync(150)
    notify('thread/status/changed', { threadId: 'a' })
    expect(state.interrupted.value).toEqual({ b: false })
    expect(state.loading.value).toBe(true)
    await vi.advanceTimersByTimeAsync(150)
    expect(fetcher.mock.calls.filter(call => call[0] === '/codex-api/sidebar-thread-status')).toHaveLength(2)
    expect(state.loading.value).toBe(false)
    expect(state.interrupted.value).toEqual({ a: true, b: false })
  })

  it('retains a clicked blue-dot row through acknowledgement until another conversation is selected', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) })
    vi.stubGlobal('fetch', fetcher)
    const { groups, selected, state } = mount()
    state.filter.value = 'unread'
    await nextTick()
    state.retainBeforeSelect('a')
    groups.value[0]!.threads[0]!.unread = false
    await nextTick() // acknowledgement can precede route selection
    expect(state.retainedThreadId.value).toBe('a')
    selected.value = 'a'
    await nextTick()
    expect(state.retainedThreadId.value).toBe('a')
    state.retainBeforeSelect('b')
    groups.value[0]!.threads[1]!.unread = false
    selected.value = 'b'
    await nextTick()
    expect(state.retainedThreadId.value).toBe('b')
    selected.value = 'already-read'
    await nextTick()
    expect(state.retainedThreadId.value).toBe('')
    state.filter.value = 'active'
    await vi.advanceTimersByTimeAsync(200)
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/codex-api/thread-interruptions'])
  })
  it('ignores late quota results after a new turn or leaving the filter', async () => {
    let finish!: (v: unknown) => void
    let statusReads = 0
    const fetcher = vi.fn(url => {
      if (url === '/codex-api/thread-interruptions') return Promise.resolve({ ok: true, json: async () => ({ data: {} }) })
      if (++statusReads === 1) return new Promise(r => { finish = r })
      return Promise.resolve({ ok: true, json: async () => ({ data: { a: false, b: false } }) })
    })
    vi.stubGlobal('fetch', fetcher)
    const { state, notify } = mount()
    state.filter.value = 'interrupted'
    await nextTick()
    await vi.advanceTimersByTimeAsync(150)
    notify('turn/started', { threadId: 'a' })
    finish({ ok: true, json: async () => ({ data: { a: true, b: true } }) })
    await vi.advanceTimersByTimeAsync(150)
    expect(state.interrupted.value).toEqual({ a: false, b: false })
    state.filter.value = 'all'
    await nextTick()
    notify('turn/completed', { threadId: 'a' })
    await vi.advanceTimersByTimeAsync(200)
    expect(statusReads).toBe(2)
  })
})


it.each(['active', 'interrupted'] as const)('retains the selected %s match after it stops matching, until selection changes', async filter => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { a: false, b: false } }) }))
  const { groups, selected, state, notify } = mount()
  groups.value[0]!.threads[0]!.inProgress = filter === 'active'
  selected.value = 'a'
  state.filter.value = filter
  if (filter === 'interrupted') notify('codexapp/interruptions/changed', { threadId: 'a', issues: [{ turnId: 'test', kind: 'quota' }] })
  await nextTick()
  expect(state.retainedThreadId.value).toBe('a')
  if (filter === 'active') groups.value[0]!.threads[0]!.inProgress = false
  else notify('thread/quotaErrorIgnored/changed', { threadId: 'a' })
  await nextTick()
  await vi.advanceTimersByTimeAsync(200)
  expect(state.retainedThreadId.value).toBe('a')
  selected.value = 'b'
  await nextTick()
  expect(state.retainedThreadId.value).toBe('')
})
