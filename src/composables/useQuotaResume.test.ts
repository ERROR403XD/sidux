import { afterEach, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent } from 'vue'
import { useQuotaResume } from './useQuotaResume'
vi.mock('../api/codexGateway', () => ({ subscribeCodexNotifications: () => () => {} }))
const renderer = createRenderer<any, any>({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {}, setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {} })
let unmount = () => {}
afterEach(() => { unmount(); vi.unstubAllGlobals() })
it('keeps the last known mark and exposes the server recovery instruction on save failure', async () => {
  const marks = { fixture: { status: 'waiting', blockedTurnId: 'turn', attemptId: null } }
  const failure = '续跑状态保存结果未确认，已停止续跑；请检查存储并重启服务核对。'
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => options
    ? { ok: false, json: async () => ({ error: failure }) }
    : { ok: true, json: async () => ({ data: marks }) }))
  let state!: ReturnType<typeof useQuotaResume>
  const app = renderer.createApp(defineComponent({ setup() { state = useQuotaResume(); return () => null } }))
  app.mount({})
  unmount = () => app.unmount()
  await vi.waitFor(() => expect(state.marks.value).toEqual(marks))
  await state.toggle('fixture')
  expect(state.marks.value).toEqual(marks)
  expect(state.error.value).toBe(failure)
})
