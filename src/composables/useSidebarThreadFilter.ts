import { computed, onBeforeUnmount, reactive, ref, watch, type Ref } from 'vue'
import { subscribeCodexNotifications } from '../api/codexGateway'
import type { UiProjectGroup } from '../types/codex'
import { matchesSidebarThreadFilter, type SidebarThreadFilter } from '../sidebarThreadFilter'
import { ActiveSidebarSession } from '../activeSidebarSession'
import { useThreadInterruptions } from './useThreadInterruptions'

export function useSidebarThreadFilter(groups: Ref<UiProjectGroup[]>, selectedId: Ref<string>) {
  const filter = ref<SidebarThreadFilter>('all')
  const retainedThreadId = ref('')
  const { issues: problems, error: problemError, refresh: refreshProblems, ignoring: ignoringProblems, ignoreThread: ignoreThreadProblems, observe: observeProblems } = useThreadInterruptions()
  const loadedInterrupted = ref<Record<string, boolean | null>>({})
  const interrupted = computed(() => ({ ...loadedInterrupted.value, ...Object.fromEntries(Object.keys(problems.value).map(id => [id, true])) }))
  const loading = ref(false)
  const error = ref('')
  const threads = computed(() => groups.value.flatMap(group => group.threads))
  const activeSession = reactive(new ActiveSidebarSession())
  let previousMatches = new Set<string>()
  // Synchronous reset also handles off/on within one render tick as a new cycle.
  watch(filter, value => {
    activeSession.reset(value === 'active', threads.value, selectedId.value)
    retainedThreadId.value = ''
    previousMatches.clear()
  }, { flush: 'sync' })
  watch(() => [filter.value === 'active' ? threads.value.map(({ id, inProgress, unread }) => ({ id, inProgress, unread })) : [], selectedId.value] as const,
    ([rows, id]) => activeSession.update(rows, id))
  const matchingIds = computed(() => new Set(threads.value.filter(thread => matchesSidebarThreadFilter(thread, filter.value, '', interrupted.value, activeSession.retainedIds)).map(thread => thread.id)))
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
    if (id !== lastSelected && retainedThreadId.value !== id) retainedThreadId.value = ''
    if (filter.value !== 'all' && id && (matchingIds.value.has(id) || previousMatches.has(id))) retainedThreadId.value = id
    lastSelected = id
    previousMatches = new Set(matchingIds.value)
  }, { immediate: true })

  async function refresh(): Promise<void> {
    if (disposed || filter.value !== 'interrupted') return
    if (problemError.value) void refreshProblems()
    controller?.abort()
    const request = new AbortController()
    controller = request
    const started = ++revision
    loading.value = true
    error.value = ''
    loadedInterrupted.value = {}
    try {
      const ids = threads.value.filter(thread => !thread.inProgress && !problems.value[thread.id]?.length).map(thread => thread.id)
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
        loadedInterrupted.value = { ...next }
      }
      loadedInterrupted.value = next
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
    observeProblems(notification)
    if (notification.method === 'turn/started') {
      const params = notification.params as { threadId?: string; thread_id?: string }
      activeSession.started(params?.threadId || params?.thread_id || '')
    }
    if (notification.method === 'ready') { schedule(); return }
    if (!['turn/started', 'turn/completed', 'turn/cancelled', 'thread/status/changed', 'thread/quotaErrorIgnored/changed'].includes(notification.method)) return
    const params = notification.params as { threadId?: string; thread_id?: string }
    const id = params?.threadId || params?.thread_id
    if (!id) return
    // Drop stale matches immediately; re-read the final turn after the event.
    delete loadedInterrupted.value[id]
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
  return { filter, retainedThreadId, activeSession, problems, problemError, ignoringProblems, ignoreThreadProblems, interrupted, loading, error: computed(() => error.value || problemError.value), refresh, retainBeforeSelect }
}
