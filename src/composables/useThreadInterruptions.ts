import { onBeforeUnmount, ref } from 'vue'
import type { ThreadInterruption, ThreadInterruptionSnapshot } from '../threadInterruption'

export function useThreadInterruptions() {
  const issues = ref<ThreadInterruptionSnapshot>({})
  const error = ref('')
  const ignoring = ref(false)
  let pending: Promise<void> | undefined
  let changes: ThreadInterruptionSnapshot | undefined
  let disposed = false
  let controller: AbortController | undefined

  async function ignoreThread(threadId: string): Promise<void> {
    if (ignoring.value) return
    // Freeze exactly the shown problem IDs; a concurrent new failure stays unhandled.
    const current = [...(issues.value[threadId] || [])]
    ignoring.value = true
    error.value = ''
    try {
      for (const issue of current) {
        const response = await fetch('/codex-api/ignored-quota-errors', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threadId, turnId: issue.turnId, ignored: true }),
        })
        if (!response.ok) throw new Error('忽略标记保存失败，请重试')
      }
      await refresh()
    } catch {
      error.value = '忽略标记保存失败，请重试'
    } finally {
      ignoring.value = false
    }
  }

  function refresh(): Promise<void> {
    if (pending) return pending
    const request = new AbortController()
    controller = request
    changes = Object.create(null)
    pending = fetch('/codex-api/thread-interruptions', { signal: request.signal }).then(async response => {
      if (!response.ok) throw new Error('会话状态读取失败，请重试')
      const payload = await response.json() as { data: ThreadInterruptionSnapshot }
      if (disposed) return
      const next = { ...payload.data, ...changes }
      for (const id of Object.keys(next)) if (!next[id]?.length) delete next[id]
      issues.value = next
      error.value = ''
    }).catch(() => {
      if (!disposed && !request.signal.aborted) error.value = '会话状态读取失败，请重试'
    }).finally(() => { pending = undefined; changes = undefined })
    return pending
  }
  function observe(notification: { method: string; params?: unknown }): void {
    if (notification.method === 'ready') { void refresh(); return }
    if (notification.method !== 'codexapp/interruptions/changed') return
    const params = notification.params as { threadId?: string; issues?: ThreadInterruption[] }
    if (!params?.threadId || !Array.isArray(params.issues)) return
    if (changes) changes[params.threadId] = params.issues
    if (params.issues.length) issues.value = { ...issues.value, [params.threadId]: params.issues }
    else {
      const next = { ...issues.value }
      delete next[params.threadId]
      issues.value = next
    }
  }
  // Read after subscription readiness, closing the snapshot/event gap with one
  // initial request. Reconnection takes another snapshot; focus alone does not.
  onBeforeUnmount(() => { disposed = true; controller?.abort() })
  return { issues, error, refresh, ignoring, ignoreThread, observe }
}
