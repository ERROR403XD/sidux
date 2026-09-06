import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { subscribeCodexNotifications } from '../api/codexGateway'
import { readThreadGoal, type ThreadGoal } from '../threadGoal'

export function useThreadGoals(threadIds: Ref<string[]>, selectedId: Ref<string>) {
  const goals = ref<Record<string, ThreadGoal | null>>({})
  const error = ref('')
  let disposed = false
  let loading = false
  let pending = false
  let refreshSelected = false
  let revision = 0
  let ready = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const changedAt = new Map<string, number>()
  const visibleIds = computed(() => new Set([selectedId.value, ...threadIds.value].filter(Boolean)))

  function update(goal: ThreadGoal | null, id: string) {
    goals.value = { ...goals.value, [id]: goal }
    changedAt.set(id, ++revision)
  }

  async function load() {
    if (disposed) return
    if (loading) {
      pending = true
      return
    }
    loading = true
    const refreshId = refreshSelected ? selectedId.value : ''
    refreshSelected = false
    try {
      const ids = [...visibleIds.value]
      const started = revision
      for (let offset = 0; offset < ids.length && !disposed; offset += 100) {
        const batch = ids.slice(offset, offset + 100)
        const response = await fetch('/codex-api/thread-goals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threadIds: batch, ...(batch.includes(refreshId) ? { refreshId } : {}) }),
        })
        if (!response.ok) throw new Error('持续目标读取失败，显示的状态可能已过期。')
        const payload = await response.json() as { data: Record<string, unknown> }
        if (disposed) return
        const next = { ...goals.value }
        for (const id of batch) {
          const goal = readThreadGoal(payload.data?.[id], id)
          if ((changedAt.get(id) ?? 0) <= started) next[id] = goal
        }
        goals.value = next
      }
      error.value = ''
      const currentIds = visibleIds.value
      goals.value = Object.fromEntries(Object.entries(goals.value).filter(([id]) => currentIds.has(id)))
      for (const id of changedAt.keys()) if (!currentIds.has(id)) changedAt.delete(id)
    } catch (cause) {
      if (!disposed) error.value = cause instanceof Error ? cause.message : '持续目标读取失败'
    } finally {
      loading = false
      if (pending && !disposed) {
        pending = false
        void load()
      }
    }
  }

  function schedule(refresh = false) {
    refreshSelected ||= refresh
    clearTimeout(timer)
    timer = setTimeout(() => { void load() }, 150)
  }

  const unsubscribe = subscribeCodexNotifications(notification => {
    if (notification.method === 'ready') {
      if (ready) schedule(true)
      ready = true
      return
    }
    const params = notification.params as { threadId?: string; goal?: unknown }
    if (!params?.threadId || !visibleIds.value.has(params.threadId)) return
    try {
      if (notification.method === 'thread/goal/updated') update(readThreadGoal(params.goal, params.threadId), params.threadId)
      if (notification.method === 'thread/goal/cleared') update(null, params.threadId)
    } catch {
      schedule(true)
    }
  })

  watch(() => [threadIds.value.join(','), selectedId.value], () => schedule(), { immediate: true })
  function onVisible() {
    if (document.visibilityState === 'visible') schedule(true)
  }
  window.addEventListener('focus', onVisible)
  document.addEventListener('visibilitychange', onVisible)
  onBeforeUnmount(() => {
    disposed = true
    clearTimeout(timer)
    unsubscribe()
    window.removeEventListener('focus', onVisible)
    document.removeEventListener('visibilitychange', onVisible)
  })
  return { goals, selectedGoal: computed(() => goals.value[selectedId.value] ?? null), error, update, refresh: () => schedule(true) }
}
