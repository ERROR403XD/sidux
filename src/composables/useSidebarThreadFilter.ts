import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { subscribeCodexNotifications } from '../api/codexGateway'
import type { UiProjectGroup } from '../types/codex'
import { matchesSidebarThreadFilter, type SidebarThreadFilter } from '../sidebarThreadFilter'

export function useSidebarThreadFilter(groups: Ref<UiProjectGroup[]>, selectedId: Ref<string>) {
  const filter = ref<SidebarThreadFilter>('all')
  const retainedThreadId = ref('')
  const interrupted = ref<Record<string, boolean | null>>({})
  const loading = ref(false)
  const error = ref('')
  const threads = computed(() => groups.value.flatMap(group => group.threads))
  let previousMatches = new Set<string>()
  let previousFilter = filter.value
  const matchingIds = computed(() => new Set(threads.value.filter(thread => matchesSidebarThreadFilter(thread, filter.value, '', interrupted.value)).map(thread => thread.id)))
  let lastSelected = selectedId.value
  let disposed = false
  let revision = 0
  let controller: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  function retainBeforeSelect(id: string): void {
    if (filter.value !== 'all' && matchingIds.value.has(id)) retainedThreadId.value = id
  }
  watch([selectedId, matchingIds, filter], () => {
    const id = selectedId.value
    if (filter.value !== previousFilter) {
      retainedThreadId.value = ''
      previousMatches.clear()
      previousFilter = filter.value
    }
    if (id !== lastSelected && retainedThreadId.value !== id) retainedThreadId.value = ''
    if (filter.value !== 'all' && id && (matchingIds.value.has(id) || previousMatches.has(id))) retainedThreadId.value = id
    lastSelected = id
    previousMatches = new Set(matchingIds.value)
  }, { immediate: true })

  async function refresh(): Promise<void> {
    if (disposed || filter.value !== 'interrupted') return
    controller?.abort()
    const request = new AbortController()
    controller = request
    const started = ++revision
    loading.value = true
    error.value = ''
    interrupted.value = {}
    try {
      const ids = threads.value.filter(thread => !thread.inProgress).map(thread => thread.id)
      const versions = new Map(threads.value.map(thread => [thread.id, thread.updatedAtIso]))
      const next: Record<string, boolean | null> = {}
      for (let offset = 0; offset < ids.length; offset += 100) {
        const batch = ids.slice(offset, offset + 100)
        const response = await fetch('/codex-api/sidebar-thread-status', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threadIds: batch, versions: Object.fromEntries(batch.map(id => [id, versions.get(id)])) }), signal: request.signal,
        })
        if (!response.ok) throw new Error('会话状态读取失败，请重试')
        const payload = await response.json() as { data: Record<string, boolean | null> }
        if (disposed || started !== revision) return
        for (const id of batch) next[id] = typeof payload.data?.[id] === 'boolean' ? payload.data[id]! : null
        interrupted.value = { ...next }
      }
      interrupted.value = next
      if (Object.values(next).some(value => value === null)) error.value = '部分会话状态未能确认，请重试'
    } catch {
      if (!request.signal.aborted && !disposed && started === revision) error.value = '会话状态读取失败，请重试'
    } finally {
      if (!disposed && started === revision) loading.value = false
    }
  }
  function schedule(): void {
    clearTimeout(timer)
    if (filter.value === 'interrupted') timer = setTimeout(() => { void refresh() }, 150)
  }
  watch(() => [filter.value, threads.value.map(thread => `${thread.id}:${thread.updatedAtIso}:${thread.inProgress}`).join('|')], () => {
    revision += 1
    controller?.abort()
    loading.value = false
    schedule()
  })
  const unsubscribe = subscribeCodexNotifications(notification => {
    if (notification.method === 'ready') { schedule(); return }
    if (!['turn/started', 'turn/completed', 'turn/cancelled', 'thread/status/changed', 'thread/quotaErrorIgnored/changed'].includes(notification.method)) return
    const params = notification.params as { threadId?: string; thread_id?: string }
    const id = params?.threadId || params?.thread_id
    if (!id) return
    // Drop stale matches immediately; re-read the final turn after the event.
    delete interrupted.value[id]
    revision += 1
    controller?.abort()
    loading.value = false
    schedule()
  })
  function onVisible(): void {
    if (document.visibilityState === 'visible') schedule()
  }
  window.addEventListener('focus', onVisible)
  document.addEventListener('visibilitychange', onVisible)
  onBeforeUnmount(() => {
    disposed = true
    controller?.abort()
    clearTimeout(timer)
    unsubscribe()
    window.removeEventListener('focus', onVisible)
    document.removeEventListener('visibilitychange', onVisible)
  })
  return { filter, retainedThreadId, interrupted, loading, error, refresh, retainBeforeSelect }
}
