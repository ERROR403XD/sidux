import { nextTick, onScopeDispose, ref, type Ref } from 'vue'

const BOTTOM_THRESHOLD_PX = 16

export function useConversationScrollState(options: {
  container: Ref<HTMLElement | null>
  bottomAnchor: Ref<HTMLElement | null>
  isLoading: Ref<boolean>
}) {
  const autoFollowOutput = ref(true)
  let stopped = false
  let conversationScrollFrame = 0
  let bottomLockFrame = 0
  let bottomLockFramesLeft = 0
  let bottomLockSequence = 0
  let pinnedContainer: HTMLElement | null = null
  let pinnedScrollTop: number | null = null
  let conversationScrollPromise: Promise<void> | null = null
  let settleConversationScroll: (() => void) | null = null
  const pendingImageHandlers = new Map<HTMLImageElement, () => void>()

  function removePendingImageHandlers(image: HTMLImageElement): void {
    const handler = pendingImageHandlers.get(image)
    if (!handler) return
    image.removeEventListener('load', handler)
    image.removeEventListener('error', handler)
    pendingImageHandlers.delete(image)
  }

  function reset(): void {
    if (conversationScrollFrame) cancelAnimationFrame(conversationScrollFrame)
    if (bottomLockFrame) cancelAnimationFrame(bottomLockFrame)
    conversationScrollFrame = 0
    bottomLockFrame = 0
    bottomLockFramesLeft = 0
    bottomLockSequence += 1
    pinnedContainer = null
    pinnedScrollTop = null
    const settle = settleConversationScroll
    settleConversationScroll = null
    conversationScrollPromise = null
    settle?.()
    for (const image of pendingImageHandlers.keys()) removePendingImageHandlers(image)
  }

  function stop(): void {
    if (stopped) return
    stopped = true
    reset()
  }

  function isAtBottom(container: HTMLElement): boolean {
    const distance = container.scrollHeight - (container.scrollTop + container.clientHeight)
    return distance <= BOTTOM_THRESHOLD_PX
  }

  function scrollToBottom(): void {
    if (stopped) return
    const container = options.container.value
    const anchor = options.bottomAnchor.value
    if (!container || !anchor) return
    container.scrollTop = container.scrollHeight
    anchor.scrollIntoView({ block: 'end' })
    pinnedContainer = container
    pinnedScrollTop = container.scrollTop
  }

  function enforceBottomState(): void {
    const container = options.container.value
    if (!container) return
    scrollToBottom()
  }

  function applyConversationScrollState(): void {
    if (!autoFollowOutput.value) return
    enforceBottomState()
  }

  function runBottomLockFrame(sequence: number): void {
    if (sequence !== bottomLockSequence) return
    if (stopped || !autoFollowOutput.value) {
      bottomLockFramesLeft = 0
      bottomLockFrame = 0
      return
    }

    enforceBottomState()
    bottomLockFramesLeft -= 1
    if (bottomLockFramesLeft <= 0) {
      bottomLockFrame = 0
      return
    }
    bottomLockFrame = requestAnimationFrame(() => runBottomLockFrame(sequence))
  }

  function scheduleBottomLock(frames = 6): void {
    if (stopped || !autoFollowOutput.value) return
    if (bottomLockFrame) cancelAnimationFrame(bottomLockFrame)
    const sequence = ++bottomLockSequence
    bottomLockFramesLeft = Math.max(frames, 1)
    bottomLockFrame = requestAnimationFrame(() => runBottomLockFrame(sequence))
  }

  function bindPendingImageHandlers(): void {
    if (stopped || !autoFollowOutput.value) return
    const container = options.container.value
    if (!container) return

    const images = container.querySelectorAll<HTMLImageElement>('img.message-image-preview')
    const currentImages = new Set(images)
    for (const image of pendingImageHandlers.keys()) {
      if (!currentImages.has(image) || image.complete) removePendingImageHandlers(image)
    }
    for (const image of images) {
      if (image.complete || pendingImageHandlers.has(image)) continue
      const handler = () => {
        // An old image may settle after a reset even if its event was already queued.
        if (pendingImageHandlers.get(image) !== handler) return
        removePendingImageHandlers(image)
        if (options.container.value === container) scheduleBottomLock(3)
      }
      pendingImageHandlers.set(image, handler)
      image.addEventListener('load', handler, { once: true })
      image.addEventListener('error', handler, { once: true })
    }
  }

  function scheduleConversationScroll(): Promise<void> {
    if (stopped) return Promise.resolve()
    if (conversationScrollPromise) return conversationScrollPromise

    const promise = new Promise<void>((resolve) => { settleConversationScroll = resolve })
    conversationScrollPromise = promise
    void nextTick().then(() => {
      if (stopped || conversationScrollPromise !== promise) return
      conversationScrollFrame = requestAnimationFrame(() => {
        if (stopped || conversationScrollPromise !== promise) return
        conversationScrollFrame = 0
        const settle = settleConversationScroll
        settleConversationScroll = null
        conversationScrollPromise = null
        applyConversationScrollState()
        bindPendingImageHandlers()
        scheduleBottomLock()
        settle?.()
      })
    })

    return promise
  }

  function onScroll(): void {
    if (stopped) return
    const container = options.container.value
    if (!container || options.isLoading.value) return
    // Output can grow before its follow frame; an unchanged pinned position is not a user scroll.
    if (autoFollowOutput.value && conversationScrollPromise && pinnedContainer === container && pinnedScrollTop === container.scrollTop) return
    autoFollowOutput.value = isAtBottom(container)
  }

  function jumpToLatest(): void {
    if (stopped) return
    autoFollowOutput.value = true
    enforceBottomState()
    scheduleBottomLock(4)
  }

  onScopeDispose(stop)

  return {
    autoFollowOutput,
    scheduleConversationScroll,
    onScroll,
    jumpToLatest,
    enforceBottomState,
    scheduleBottomLock,
    reset,
    stop,
  }
}
