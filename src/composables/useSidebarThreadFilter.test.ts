import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, nextTick, ref } from 'vue'
import { useSidebarThreadFilter } from './useSidebarThreadFilter'
import type { UiProjectGroup, UiThread } from '../types/codex'

const gateway = vi.hoisted(() => ({ subscribeCodexNotifications: vi.fn() }))
vi.mock('../api/codexGateway', () => gateway)
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
  gateway.subscribeCodexNotifications.mockImplementation(fn => { listeners.add(fn); return () => listeners.delete(fn) })
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
