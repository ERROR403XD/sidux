import { computed, nextTick, onScopeDispose, readonly, ref, watch, type Ref } from 'vue'
import type { UiLiveOverlay, UiMessage, UiServerRequest } from '../types/codex'
import { useConversationScrollState } from './useConversationScrollState'

const RENDER_WINDOW_SIZE = 50
const LOAD_MORE_CHUNK = 30
const LOAD_MORE_SCROLL_THRESHOLD_PX = 200

type ConversationViewportOptions = {
  container: Ref<HTMLElement | null>
  bottomAnchor: Ref<HTMLElement | null>
  getThreadId: () => string
  getCwd: () => string
  getAccountRevision: () => number
  getMessages: () => UiMessage[]
  getPendingRequests: () => UiServerRequest[]
  getLiveOverlay: () => UiLiveOverlay | null
  isLoading: () => boolean
  hasMorePersistedAbove: () => boolean
  isLoadingPersistedAbove: () => boolean
  loadEarlierMessages: (threadId: string) => Promise<void> | undefined
}

export function useConversationViewport(options: ConversationViewportOptions) {
  const scroll = useConversationScrollState({
    container: options.container,
    bottomAnchor: options.bottomAnchor,
    isLoading: computed(options.isLoading),
  })
  const renderWindowStart = ref(Math.max(0, options.getMessages().length - RENDER_WINDOW_SIZE))
  const isLoadingMore = ref(false)
  const historyLoadError = ref('')
  let stopped = false
  let generation = 0
  let historyLoadSequence = 0
  let scrollIntentRevision = 0

  const visibleMessages = computed(() => options.getMessages().slice(renderWindowStart.value))
  const hasMoreAbove = computed(() => renderWindowStart.value > 0 || options.hasMorePersistedAbove())
  const showJumpToLatestButton = computed(() => !scroll.autoFollowOutput.value && (
    options.getMessages().length > 0 || options.getPendingRequests().length > 0 || Boolean(options.getLiveOverlay())
  ))

  function pinRenderWindow(): void {
    renderWindowStart.value = Math.max(0, options.getMessages().length - RENDER_WINDOW_SIZE)
  }

  async function loadMoreAbove(): Promise<void> {
    const container = options.container.value
    if (stopped || !container || !hasMoreAbove.value || isLoadingMore.value || options.isLoadingPersistedAbove()) return

    isLoadingMore.value = true
    historyLoadError.value = ''
    const sequence = ++historyLoadSequence
    const startedGeneration = generation
    const startedScrollIntentRevision = scrollIntentRevision
    const threadId = options.getThreadId()
    const isCurrent = () => !stopped && generation === startedGeneration && historyLoadSequence === sequence
    const prevScrollHeight = container.scrollHeight
    const prevScrollTop = container.scrollTop

    try {
      if (renderWindowStart.value > 0) {
        renderWindowStart.value = Math.max(0, renderWindowStart.value - LOAD_MORE_CHUNK)
      } else if (options.hasMorePersistedAbove()) {
        await options.loadEarlierMessages(threadId)
      }
      if (!isCurrent()) return
      await nextTick()
      if (isCurrent() && scrollIntentRevision === startedScrollIntentRevision && options.container.value === container) {
        container.scrollTop = prevScrollTop + (container.scrollHeight - prevScrollHeight)
      }
    } catch (cause) {
      if (isCurrent()) historyLoadError.value = cause instanceof Error ? cause.message : '加载历史失败，请重试。'
    } finally {
      if (isCurrent()) isLoadingMore.value = false
    }
  }

  function onConversationScroll(): void {
    const container = options.container.value
    if (stopped || !container || options.isLoading()) return
    scroll.onScroll()
    if (hasMoreAbove.value && !historyLoadError.value && !isLoadingMore.value && container.scrollTop < LOAD_MORE_SCROLL_THRESHOLD_PX) {
      void loadMoreAbove()
    }
  }

  function jumpToLatest(): void {
    if (stopped) return
    scrollIntentRevision += 1
    pinRenderWindow()
    scroll.jumpToLatest()
    void scroll.scheduleConversationScroll()
  }

  const stopWatches = [
    watch([options.container, options.bottomAnchor], ([container, anchor]) => {
      scroll.reset()
      if (stopped || !container || !anchor || options.isLoading()) return
      void scroll.scheduleConversationScroll()
    }, { immediate: true, flush: 'sync' }),
    watch(options.getMessages, next => {
      if (stopped || options.isLoading()) return
      if (scroll.autoFollowOutput.value) {
        pinRenderWindow()
      } else {
        // History readers keep their expanded window, including after rollback.
        renderWindowStart.value = Math.min(renderWindowStart.value, Math.max(0, next.length - 1))
      }
      void scroll.scheduleConversationScroll()
    }),
    watch(options.getPendingRequests, () => {
      if (stopped || options.isLoading()) return
      void scroll.scheduleConversationScroll()
    }, { deep: true }),
    watch(options.getLiveOverlay, async overlay => {
      if (stopped || !overlay || !scroll.autoFollowOutput.value) return
      const startedGeneration = generation
      await nextTick()
      if (stopped || generation !== startedGeneration || !scroll.autoFollowOutput.value) return
      scroll.enforceBottomState()
      scroll.scheduleBottomLock(8)
    }, { deep: true }),
    watch(options.isLoading, loading => {
      if (stopped || loading) return
      pinRenderWindow()
      void scroll.scheduleConversationScroll()
    }),
    watch([options.getThreadId, options.getCwd, options.getAccountRevision], () => {
      generation += 1
      historyLoadSequence += 1
      scroll.reset()
      scroll.autoFollowOutput.value = true
      isLoadingMore.value = false
      historyLoadError.value = ''
      pinRenderWindow()
      void scroll.scheduleConversationScroll()
    }, { flush: 'sync' }),
  ]

  function stop(): void {
    if (stopped) return
    stopped = true
    generation += 1
    historyLoadSequence += 1
    for (const stopWatch of stopWatches) stopWatch()
    isLoadingMore.value = false
    scroll.stop()
  }

  onScopeDispose(stop)

  return {
    visibleMessages,
    hasMoreAbove,
    isLoadingMore: readonly(isLoadingMore),
    historyLoadError: readonly(historyLoadError),
    showJumpToLatestButton,
    loadMoreAbove,
    onConversationScroll,
    jumpToLatest,
    stop,
  }
}
