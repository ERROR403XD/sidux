import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { subscribeCodexNotifications } from '../api/codexGateway'
import type { ThreadGoal } from '../api/threadCommands'

export function useThreadGoals(threadIds: Ref<string[]>, selectedId: Ref<string>) {
  const goals = ref<Record<string, ThreadGoal | null>>({})
  const error = ref('')
  let disposed = false, loading = false, pending = false, revision = 0
  const changedAt = new Map<string, number>()
  function update(goal: ThreadGoal | null, id: string) {
    goals.value = { ...goals.value, [id]: goal }
    changedAt.set(id, ++revision)
  }
  async function load() {
    if (disposed) return
    if (loading) { pending = true; return }
    loading = true
    try {
      const ids = [...new Set([selectedId.value, ...threadIds.value].filter(Boolean))], started = revision
      for (let offset = 0; offset < ids.length && !disposed; offset += 100) {
        const response = await fetch('/codex-api/thread-goals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadIds: ids.slice(offset, offset + 100) }) })
        if (!response.ok) throw new Error('持续目标读取失败，可从“＋ → 持续目标”重新检查')
        const payload = await response.json() as { data: Record<string, ThreadGoal | null> }
        if (disposed) return
        const next = { ...goals.value }
        for (const [id, goal] of Object.entries(payload.data ?? {})) if ((changedAt.get(id) ?? 0) <= started) next[id] = goal
        goals.value = next
      }
      error.value = ''
    } catch (cause) { if (!disposed) error.value = cause instanceof Error ? cause.message : '持续目标读取失败' }
    finally { loading = false; if (pending && !disposed) { pending = false; void load() } }
  }
  const unsubscribe = subscribeCodexNotifications(notification => {
    const params = notification.params as { threadId?: string; goal?: ThreadGoal }
    if (!params?.threadId) return
    if (notification.method === 'thread/goal/updated' && params.goal) update(params.goal, params.threadId)
    if (notification.method === 'thread/goal/cleared') update(null, params.threadId)
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  function schedule() { clearTimeout(timer); timer = setTimeout(() => { void load() }, 150) }
  watch(() => [threadIds.value.join(','), selectedId.value], schedule, { immediate: true })
  function onVisible() { if (document.visibilityState === 'visible') schedule() }
  window.addEventListener('focus', onVisible)
  document.addEventListener('visibilitychange', onVisible)
  onBeforeUnmount(() => { disposed = true; clearTimeout(timer); unsubscribe(); window.removeEventListener('focus', onVisible); document.removeEventListener('visibilitychange', onVisible) })
  return { goals, selectedGoal: computed(() => goals.value[selectedId.value] ?? null), error, update }
}
