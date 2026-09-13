import { afterEach, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent } from 'vue'
import { useThreadInterruptions } from './useThreadInterruptions'

const renderer = createRenderer<any, any>({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {}, setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {} })
let unmount = () => {}
afterEach(() => { unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks() })
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

it('replaces a stalled snapshot after confirmed ignore, frees controls, and rejects its late result', async () => {
  let finishOld!: (value: unknown) => void
  const rows: Record<string, { turnId: string; kind: string }[]> = {
    a: [{ turnId: 'old-a', kind: 'error' }], b: [{ turnId: 'old-b', kind: 'quota' }],
  }
  let reads = 0
  let oldSignal: AbortSignal | undefined
  const fetcher = vi.fn((url, options) => {
    if (options?.method === 'POST') {
      const body = JSON.parse(options.body)
      delete rows[body.threadId]
      return Promise.resolve({ ok: true })
    }
    if (++reads === 1) {
      oldSignal = options.signal
      return new Promise(resolve => { finishOld = resolve })
    }
    return Promise.resolve({ ok: true, json: async () => ({ data: structuredClone(rows) }) })
  })
  vi.stubGlobal('fetch', fetcher)
  const { state, notify } = mount()
  for (const [threadId, issues] of Object.entries(rows)) notify('codexapp/interruptions/changed', { threadId, issues })
  await state.ignoreThread('a')
  expect(state.ignoring.value).toBe(false)
  expect(oldSignal?.aborted).toBe(true)
  await state.refresh()
  finishOld({ ok: true, json: async () => ({ data: { a: [{ turnId: 'old-a', kind: 'error' }] } }) })
  await Promise.resolve()
  expect(state.issues.value.a).toBeUndefined()
  expect(state.issues.value.b).toHaveLength(1)
  await state.ignoreThread('b')
  await state.refresh()
  expect(state.issues.value).toEqual({})
  expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(2)
})

it('expires a stalled read and recovers after ready without duplicating healthy snapshots', async () => {
  vi.useFakeTimers()
  let firstSignal: AbortSignal | undefined
  const fetcher = vi.fn((_url, options) => {
    if (fetcher.mock.calls.length === 1) {
      firstSignal = options.signal
      return new Promise(() => {})
    }
    return Promise.resolve({ ok: true, json: async () => ({ data: { a: [{ turnId: 'new', kind: 'error' }] } }) })
  })
  vi.stubGlobal('fetch', fetcher)
  const { state, notify } = mount()
  notify('ready')
  expect(fetcher).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(10000)
  expect(firstSignal?.aborted).toBe(true)
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(state.issues.value.a).toHaveLength(1)
  expect(state.error.value).toBe('')
  expect(vi.getTimerCount()).toBe(0)
})

it('bounds a stalled ignore POST without hiding its problem or automatically retrying it', async () => {
  vi.useFakeTimers()
  let finish!: (value: unknown) => void
  const fetcher = vi.fn((_url, options) => options?.method === 'POST'
    ? new Promise(resolve => { finish = resolve })
    : Promise.resolve({ ok: true, json: async () => ({ data: { a: [{ turnId: 'old', kind: 'error' }] } }) }))
  vi.stubGlobal('fetch', fetcher)
  const { state } = mount()
  await state.refresh()
  const saving = state.ignoreThread('a')
  await vi.advanceTimersByTimeAsync(10000)
  await saving
  expect(state.ignoring.value).toBe(false)
  expect(state.error.value).toBe('忽略标记保存失败，请重试')
  expect(state.issues.value.a).toHaveLength(1)
  finish({ ok: true })
  await Promise.resolve()
  expect(state.issues.value.a).toHaveLength(1)
  expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(0)
})
