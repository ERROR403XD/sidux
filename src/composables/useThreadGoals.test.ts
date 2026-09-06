import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, nextTick, ref } from 'vue'
import type { RpcNotification } from '../api/codexRpcClient'
import { useThreadGoals } from './useThreadGoals'
import type { ThreadGoal } from '../threadGoal'

const gateway = vi.hoisted(() => ({ subscribeCodexNotifications: vi.fn() }))
vi.mock('../api/codexGateway', () => gateway)
const renderer = createRenderer<any, any>({
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  insert: () => {}, remove: () => {}, setText: () => {}, setElementText: () => {},
  parentNode: () => null, nextSibling: () => null, patchProp: () => {},
})
const goal: ThreadGoal = { threadId: 'selected', objective: 'sample', status: 'paused', tokenBudget: 1000, tokensUsed: 100, timeUsedSeconds: 1, createdAt: 1, updatedAt: 1 }
const answer = (data: unknown) => ({ ok: true, json: async () => ({ data }) })
let unmount = () => {}
afterEach(() => { unmount(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks() })
function mount() {
  vi.useFakeTimers()
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
  let notify!: (notification: RpcNotification) => void
  gateway.subscribeCodexNotifications.mockImplementation(fn => { notify = fn; return () => {} })
  let state!: ReturnType<typeof useThreadGoals>
  const app = renderer.createApp(defineComponent({ setup() { state = useThreadGoals(ref(['selected', 'sidebar']), ref('selected')); return () => null } }))
  app.mount({})
  unmount = () => app.unmount()
  return { get state() { return state }, notify: (method: string, params: unknown) => notify({ method, params, atIso: '' }) }
}

describe('goal snapshot recovery', () => {
  it('keeps newer notifications when an older snapshot finishes and refreshes on reconnect', async () => {
    let finish!: (value: unknown) => void
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetcher)
    const { state, notify } = mount()
    notify('ready', {})
    await vi.advanceTimersByTimeAsync(150)
    notify('thread/goal/updated', { threadId: 'selected', goal: { ...goal, status: 'blocked', tokensUsed: 300 } })
    finish(answer({ selected: goal, sidebar: null }))
    await vi.advanceTimersByTimeAsync(1)
    expect(state.selectedGoal.value?.status).toBe('blocked')
    fetcher.mockResolvedValue(answer({ selected: { ...goal, tokensUsed: 500 }, sidebar: null }))
    notify('ready', {})
    await vi.advanceTimersByTimeAsync(150)
    expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body).refreshId).toBe('selected')
    expect(state.selectedGoal.value?.tokensUsed).toBe(500)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('preserves the last known goal on failure and exposes a retry', async () => {
    const fetcher = vi.fn().mockResolvedValue(answer({ selected: goal, sidebar: null }))
    vi.stubGlobal('fetch', fetcher)
    const { state } = mount()
    await vi.advanceTimersByTimeAsync(150)
    fetcher.mockResolvedValue({ ok: false })
    state.refresh()
    await vi.advanceTimersByTimeAsync(150)
    expect(state.error.value).toContain('可能已过期')
    expect(state.selectedGoal.value).toEqual(goal)
    fetcher.mockResolvedValue(answer({ selected: null, sidebar: null }))
    state.refresh()
    await vi.advanceTimersByTimeAsync(150)
    await nextTick()
    expect(state.selectedGoal.value).toBeNull()
    expect(state.error.value).toBe('')
  })
})
