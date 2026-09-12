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
  let notify!: (n: any) => void
  gateway.subscribeCodexNotifications.mockImplementation(fn => { notify = fn; return () => {} })
  const groups = ref<UiProjectGroup[]>([{ projectName: 'project', threads: ['a', 'b'].map(id => ({ id, unread: true, inProgress: false, updatedAtIso: 'now' } as UiThread)) }])
  const selected = ref('')
  let state!: ReturnType<typeof useSidebarThreadFilter>
  const app = renderer.createApp(defineComponent({ setup() { state = useSidebarThreadFilter(groups, selected); return () => null } }))
  app.mount({})
  unmount = () => app.unmount()
  return { groups, selected, state, notify: (method: string, params: unknown) => notify({ method, params }) }
}
describe('sidebar selection lifetime', () => {
  it('retains a clicked blue-dot row through acknowledgement until another conversation is selected', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const { groups, selected, state } = mount()
    state.filter.value = 'unread'
    await nextTick()
    state.retainBeforeRead('a')
    groups.value[0]!.threads[0]!.unread = false
    await nextTick() // acknowledgement can precede route selection
    expect(state.retainedUnreadId.value).toBe('a')
    selected.value = 'a'
    await nextTick()
    expect(state.retainedUnreadId.value).toBe('a')
    state.retainBeforeRead('b')
    groups.value[0]!.threads[1]!.unread = false
    selected.value = 'b'
    await nextTick()
    expect(state.retainedUnreadId.value).toBe('b')
    selected.value = 'already-read'
    await nextTick()
    expect(state.retainedUnreadId.value).toBe('')
    state.filter.value = 'active'
    await vi.advanceTimersByTimeAsync(200)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('ignores late quota results after a new turn or leaving the filter', async () => {
    let finish!: (v: unknown) => void
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise(r => { finish = r })).mockResolvedValue({ ok: true, json: async () => ({ data: { a: false, b: false } }) })
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
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
