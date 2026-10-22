import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, nextTick, ref } from 'vue'
import { useConversationScrollState } from './useConversationScrollState'

type HostNode = { children: HostNode[] }
const renderer = createRenderer<HostNode, HostNode>({
  createElement: () => ({ children: [] }),
  createText: () => ({ children: [] }),
  createComment: () => ({ children: [] }),
  insert: (node, parent) => { parent.children.push(node) },
  remove: () => undefined,
  setText: () => undefined,
  setElementText: () => undefined,
  parentNode: () => null,
  nextSibling: () => null,
  patchProp: () => undefined,
})
const cleanups: Array<() => void> = []
let frames: Map<number, FrameRequestCallback>
let nextFrame: number

function flushFrame(): void {
  const callbacks = [...frames.entries()]
  frames.clear()
  for (const [, callback] of callbacks) callback(0)
}

function setup(options: { scrollTop?: number; loading?: boolean; images?: HTMLImageElement[] } = {}) {
  const container = ref({
    scrollHeight: 1000, clientHeight: 500, scrollTop: options.scrollTop ?? 484,
    querySelectorAll: vi.fn(() => options.images ?? []),
  } as unknown as HTMLElement)
  const anchor = { scrollIntoView: vi.fn(() => {
    container.value.scrollTop = Math.min(container.value.scrollTop, container.value.scrollHeight - container.value.clientHeight)
  }) } as unknown as HTMLElement
  let state!: ReturnType<typeof useConversationScrollState>
  const app = renderer.createApp({
    setup() {
      state = useConversationScrollState({ container, bottomAnchor: ref(anchor), isLoading: ref(options.loading ?? false) })
      return () => null
    },
  })
  app.mount({ children: [] })
  let mounted = true
  const unmount = () => { if (mounted) { mounted = false; app.unmount() } }
  cleanups.push(unmount)
  return { state, container, anchor, unmount }
}

function pendingImage() {
  const image = Object.assign(new EventTarget(), { complete: false }) as unknown as HTMLImageElement
  vi.spyOn(image, 'addEventListener')
  vi.spyOn(image, 'removeEventListener')
  return image
}

beforeEach(() => {
  frames = new Map()
  nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)))
})
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('mounted Conversation scrolling lifecycle', () => {
  it('follows output at the bottom and pauses when the user scrolls away', () => {
    const { state, container } = setup()
    state.onScroll()
    expect(state.autoFollowOutput.value).toBe(true)
    container.value.scrollTop = 100
    state.onScroll()
    expect(state.autoFollowOutput.value).toBe(false)
  })

  it('does not process scroll state while messages are loading', () => {
    const { state } = setup({ scrollTop: 100, loading: true })
    state.onScroll()
    expect(state.autoFollowOutput.value).toBe(true)
  })

  it('coalesces concurrent scroll schedules into one frame and one image scan', async () => {
    const { state, container, anchor } = setup()
    const first = state.scheduleConversationScroll()
    const second = state.scheduleConversationScroll()
    await nextTick()
    expect(frames.size).toBe(1)
    flushFrame()
    await Promise.all([first, second])
    expect(anchor.scrollIntoView).toHaveBeenCalledTimes(1)
    expect(container.value.querySelectorAll).toHaveBeenCalledTimes(1)
  })

  it('settles a scheduled scroll when unmounted before its animation frame', async () => {
    const { state, unmount, anchor } = setup()
    let settled = false
    void state.scheduleConversationScroll().then(() => { settled = true })
    await nextTick()
    expect(frames.size).toBe(1)
    unmount()
    await nextTick()
    await nextTick()
    expect(settled).toBe(true)
    expect(frames.size).toBe(0)
    expect(anchor.scrollIntoView).not.toHaveBeenCalled()
  })

  it('does not enqueue work when unmounted before the nextTick continuation', async () => {
    const { state, unmount } = setup()
    let settled = false
    void state.scheduleConversationScroll().then(() => { settled = true })
    unmount()
    await nextTick()
    await nextTick()
    expect(frames.size).toBe(0)
    expect(settled).toBe(true)
  })

  it('removes both image handlers on unmount and ignores a late image event', async () => {
    const image = pendingImage()
    const { state, unmount, anchor } = setup({ images: [image] })
    const scheduled = state.scheduleConversationScroll()
    await nextTick()
    flushFrame()
    await scheduled
    expect(image.addEventListener).toHaveBeenCalledTimes(2)
    unmount()
    expect(image.removeEventListener).toHaveBeenCalledTimes(2)
    image.dispatchEvent(new Event('load'))
    expect(frames.size).toBe(0)
    expect(anchor.scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it.each(['load', 'error'])('removes the paired handlers when a pending image emits %s', async event => {
    const image = pendingImage()
    const { state } = setup({ images: [image] })
    const scheduled = state.scheduleConversationScroll()
    await nextTick()
    flushFrame()
    await scheduled
    image.dispatchEvent(new Event(event))
    expect(image.removeEventListener).toHaveBeenCalledTimes(2)
    expect(frames.size).toBe(1)
    const cancelCount = vi.mocked(cancelAnimationFrame).mock.calls.length
    image.dispatchEvent(new Event(event === 'load' ? 'error' : 'load'))
    expect(vi.mocked(cancelAnimationFrame).mock.calls.length).toBe(cancelCount)
  })

  it('prunes pending image handlers when a render removes the image', async () => {
    const image = pendingImage()
    const images = [image]
    const { state } = setup({ images })
    let scheduled = state.scheduleConversationScroll()
    await nextTick()
    flushFrame()
    await scheduled
    images.pop()
    scheduled = state.scheduleConversationScroll()
    await nextTick()
    flushFrame()
    await scheduled
    expect(image.removeEventListener).toHaveBeenCalledTimes(2)
  })

  it('invalidates queued frames and images on reset while allowing new schedules', async () => {
    const image = pendingImage()
    const { state, anchor } = setup({ images: [image] })
    const scheduled = state.scheduleConversationScroll()
    await nextTick()
    flushFrame()
    await scheduled
    const oldLock = [...frames.values()][0]!
    const oldImage = vi.mocked(image.addEventListener).mock.calls[0]![1] as EventListener
    state.reset()
    oldLock(0)
    oldImage(new Event('load'))
    expect(frames.size).toBe(0)
    expect(anchor.scrollIntoView).toHaveBeenCalledTimes(1)
    const next = state.scheduleConversationScroll()
    await nextTick()
    flushFrame()
    await next
    expect(anchor.scrollIntoView).toHaveBeenCalledTimes(2)
  })

  it('stops idempotently and rejects later scheduling, scrolling and jumping', async () => {
    const { state, container, anchor } = setup({ scrollTop: 100 })
    state.onScroll()
    state.stop()
    state.stop()
    state.reset()
    state.jumpToLatest()
    state.enforceBottomState()
    state.scheduleBottomLock()
    await state.scheduleConversationScroll()
    container.value.scrollTop = 500
    state.onScroll()
    expect(state.autoFollowOutput.value).toBe(false)
    expect(frames.size).toBe(0)
    expect(anchor.scrollIntoView).not.toHaveBeenCalled()
  })

  it('keeps following when output grows at the same pinned position before its frame, but respects a user scroll', async () => {
    const { state, container } = setup()
    state.jumpToLatest()
    const pinnedTop = container.value.scrollTop
    const scheduled = state.scheduleConversationScroll()
    Object.defineProperty(container.value, 'scrollHeight', { value: 1031, configurable: true })
    state.onScroll()
    expect(state.autoFollowOutput.value).toBe(true)
    expect(container.value.scrollTop).toBe(pinnedTop)
    container.value.scrollTop = 200
    state.onScroll()
    expect(state.autoFollowOutput.value).toBe(false)
    await nextTick()
    flushFrame()
    await scheduled
    expect(container.value.scrollTop).toBe(200)
  })
})
