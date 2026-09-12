import { afterEach, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent } from 'vue'
import { useThreadInterruptions } from './useThreadInterruptions'

const renderer = createRenderer<any, any>({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {}, setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {} })
let unmount = () => {}
afterEach(() => { unmount(); vi.unstubAllGlobals(); vi.clearAllMocks() })
function mount() {
  let state!: ReturnType<typeof useThreadInterruptions>
  const app = renderer.createApp(defineComponent({ setup() { state = useThreadInterruptions(); return () => null } }))
  app.mount({})
  state.observe({ method: 'ready', params: {} })
  unmount = () => app.unmount()
  return { state, notify: (method: string, params?: unknown) => state.observe({ method, params }) }
}

it('coalesces ready snapshots and overlays new/ignored problems on a late response without acknowledging reading', async () => {
  let finish!: (value: unknown) => void
  const fetcher = vi.fn(() => new Promise(resolve => { finish = resolve }))
  vi.stubGlobal('fetch', fetcher)
  const { state, notify } = mount()
  notify('ready')
  notify('codexapp/interruptions/changed', { threadId: 'a', issues: [{ turnId: 'new', kind: 'error' }] })
  notify('codexapp/interruptions/changed', { threadId: 'b', issues: [] })
  finish({ ok: true, json: async () => ({ data: { a: [{ turnId: 'old', kind: 'quota' }], b: [{ turnId: 'ignored', kind: 'error' }] } }) })
  await state.refresh()
  notify('codexapp/completions/changed', { threadId: 'a', token: null })
  notify('turn/started', { threadId: 'a', turnId: 'later' })
  expect(state.issues.value).toEqual({ a: [{ turnId: 'new', kind: 'error' }] })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('ignores only the captured IDs, preserves concurrent new errors and retains problems on save/read failures', async () => {
  let finish!: (value: unknown) => void
  let failRead = false
  const fetcher = vi.fn((url, options) => {
    if (options?.method === 'POST') return new Promise(resolve => { finish = resolve })
    return Promise.resolve({ ok: !failRead, json: async () => ({ data: { a: [{ turnId: 'old', kind: 'error' }] } }) })
  })
  vi.stubGlobal('fetch', fetcher)
  const { state, notify } = mount()
  await state.refresh()
  const saving = state.ignoreThread('a')
  notify('codexapp/interruptions/changed', { threadId: 'a', issues: [{ turnId: 'new', kind: 'quota' }] })
  failRead = true
  finish({ ok: true })
  await saving
  const posts = fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')
  expect(posts).toHaveLength(1)
  expect(JSON.parse(posts[0]![1].body)).toEqual({ threadId: 'a', turnId: 'old', ignored: true })
  expect(state.issues.value).toEqual({ a: [{ turnId: 'new', kind: 'quota' }] })
  const failing = state.ignoreThread('a')
  finish({ ok: false })
  await failing
  expect(state.issues.value.a).toEqual([{ turnId: 'new', kind: 'quota' }])
  expect(state.error.value).toBe('忽略标记保存失败，请重试')
})
