import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent } from 'vue'
import { useQuotaResume } from './useQuotaResume'
import type { RpcNotification } from '../api/codexRpcClient'

const transport = vi.hoisted(() => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }))
vi.mock('../api/codexRpcClient', () => ({ subscribeRpcNotifications: transport.subscribe }))
const renderer = createRenderer<any, any>({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {}, setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {} })
const mark = { status: 'waiting', blockedTurnId: 'turn', attemptId: null }
const response = (data = {}, ok = true, error = '') => ({ ok, json: async () => ({ data, error }) })
const fetchMock = vi.fn()
const cleanups: (() => void)[] = []

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function setup() {
  let state!: ReturnType<typeof useQuotaResume>
  const app = renderer.createApp(defineComponent({ setup() { state = useQuotaResume(); return () => null } }))
  app.mount({})
  const notify = transport.subscribe.mock.calls.at(-1)![0] as (notification: RpcNotification) => void
  let mounted = true
  const unmount = () => {
    if (mounted) app.unmount()
    mounted = false
  }
  cleanups.push(unmount)
  return { state, unmount, emit: (method = 'ready') => notify({ method, params: {}, atIso: 'fixture' }) }
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  transport.subscribe.mockReturnValue(transport.unsubscribe)
  fetchMock.mockResolvedValue(response())
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  for (const unmount of cleanups.splice(0)) unmount()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('quota resume snapshot coordination', () => {
  it('reads once after first ready instead of before and after the connection', async () => {
    const test = setup()
    await vi.advanceTimersByTimeAsync(100)
    expect(fetchMock).not.toHaveBeenCalled()
    test.emit()
    await vi.advanceTimersByTimeAsync(149)
    expect(fetchMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('preserves ready delivered during subscription setup', async () => {
    transport.subscribe.mockImplementation(notify => {
      notify({ method: 'ready', params: {}, atIso: 'fixture' })
      return transport.unsubscribe
    })
    setup()
    await vi.advanceTimersByTimeAsync(150)
    expect(fetchMock).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(500)
    expect(fetchMock).toHaveBeenCalledOnce()
  })
  it('falls back at 500ms without ready, then reconciles on late ready', async () => {
    const test = setup()
    await vi.advanceTimersByTimeAsync(499)
    expect(fetchMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledOnce()
    fetchMock.mockResolvedValue(response({ fixture: mark }))
    test.emit()
    await vi.advanceTimersByTimeAsync(150)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(test.state.marks.value).toEqual({ fixture: mark })
  })
  it.each(['ready', 'thread/quotaResume/changed'])('does not drop %s while a snapshot is in flight', async method => {
    const pending = deferred<ReturnType<typeof response>>()
    fetchMock.mockReturnValueOnce(pending.promise).mockResolvedValue(response({ fixture: mark }))
    const test = setup()
    await vi.advanceTimersByTimeAsync(500)
    test.emit(method)
    await vi.advanceTimersByTimeAsync(150)
    expect(fetchMock).toHaveBeenCalledOnce()
    pending.resolve(response())
    await vi.advanceTimersByTimeAsync(150)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(test.state.marks.value).toEqual({ fixture: mark })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('debounces bursts and refreshes again after reconnect', async () => {
    const test = setup()
    for (let i = 0; i < 20; i++) test.emit()
    await vi.advanceTimersByTimeAsync(150)
    expect(fetchMock).toHaveBeenCalledOnce()
    for (let i = 0; i < 20; i++) test.emit('thread/quotaResume/changed')
    await vi.advanceTimersByTimeAsync(150)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    test.emit()
    await vi.advanceTimersByTimeAsync(150)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
  it.each(['success', 'failure'])('ignores stale GET %s after a toggle', async outcome => {
    const pending = deferred<ReturnType<typeof response>>()
    fetchMock.mockReturnValueOnce(pending.promise).mockResolvedValue(response({ fixture: mark }))
    const test = setup()
    test.emit()
    await vi.advanceTimersByTimeAsync(150)
    await test.state.toggle('fixture')
    if (outcome === 'success') pending.resolve(response())
    else pending.reject(new Error('old failure'))
    await vi.advanceTimersByTimeAsync(0)
    expect(test.state.marks.value).toEqual({ fixture: mark })
    expect(test.state.error.value).toBe('')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('serializes repeated toggles using the committed prior state', async () => {
    const pending = deferred<ReturnType<typeof response>>()
    fetchMock.mockReturnValueOnce(pending.promise).mockResolvedValue(response())
    const test = setup()
    const first = test.state.toggle('fixture')
    const second = test.state.toggle('fixture')
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).enabled).toBe(true)
    pending.resolve(response({ fixture: mark }))
    await Promise.all([first, second])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).enabled).toBe(false)
    expect(test.state.marks.value).toEqual({})
  })
  it('defers notification reads until pending mutations complete', async () => {
    const test = setup()
    test.emit()
    await vi.advanceTimersByTimeAsync(150)
    const pending = deferred<ReturnType<typeof response>>()
    fetchMock.mockReturnValueOnce(pending.promise).mockResolvedValue(response({ fixture: mark }))
    const toggle = test.state.toggle('fixture')
    await vi.advanceTimersByTimeAsync(0)
    test.emit('thread/quotaResume/changed')
    await vi.advanceTimersByTimeAsync(150)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    pending.resolve(response({ fixture: mark }))
    await toggle
    await vi.advanceTimersByTimeAsync(150)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(test.state.marks.value).toEqual({ fixture: mark })
  })
  it('keeps the last mark and exposes server recovery instructions on save failure', async () => {
    const failure = '续跑状态保存结果未确认，已停止续跑；请检查存储并重启服务核对。'
    fetchMock.mockResolvedValueOnce(response({ fixture: mark })).mockResolvedValue(response({}, false, failure))
    const test = setup()
    test.emit()
    await vi.advanceTimersByTimeAsync(150)
    await test.state.toggle('fixture')
    expect(test.state.marks.value).toEqual({ fixture: mark })
    expect(test.state.error.value).toBe(failure)
  })
  it.each(['read', 'toggle'].flatMap(operation => ['success', 'failure'].map(outcome => ({ operation, outcome }))))
    ('ignores late $operation $outcome and callbacks after unmount', async ({ operation, outcome }) => {
      const pending = deferred<ReturnType<typeof response>>()
      fetchMock.mockReturnValueOnce(pending.promise)
      const test = setup()
      let toggle: Promise<void> | undefined
      if (operation === 'read') {
        test.emit()
        await vi.advanceTimersByTimeAsync(150)
      } else {
        toggle = test.state.toggle('fixture')
        await vi.advanceTimersByTimeAsync(0)
      }
      test.unmount()
      expect(transport.unsubscribe).toHaveBeenCalledOnce()
      test.emit()
      if (outcome === 'success') pending.resolve(response({ fixture: mark }))
      else pending.reject(new Error('late error'))
      await toggle
      await vi.advanceTimersByTimeAsync(1000)
      expect(test.state.marks.value).toEqual({})
      expect(test.state.error.value).toBe('')
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    })
  it('clears all timers over ten real mount/unmount cycles', async () => {
    for (let i = 0; i < 10; i++) {
      const test = setup()
      test.emit()
      test.unmount()
      test.emit()
      expect(vi.getTimerCount()).toBe(0)
    }
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(transport.unsubscribe).toHaveBeenCalledTimes(10)
  })
})
