import { computed, onBeforeUnmount, ref } from 'vue'
import type { ThreadInterruption, ThreadInterruptionSnapshot } from '../threadInterruption'

const READ_ERROR = '会话状态读取失败，请重试'
const REQUEST_TIMEOUT_MS = 10_000

export function useThreadInterruptions() {
  const issues = ref<ThreadInterruptionSnapshot>({})
  const readError = ref('')
  const saveError = ref('')
  const error = computed(() => saveError.value || readError.value)
  const ignoring = ref(false)
  let pending: Promise<void> | undefined
  let changes: ThreadInterruptionSnapshot | undefined
  let disposed = false
  let controller: AbortController | undefined
  const requests = new Set<AbortController>()

  async function request<T>(control: AbortController, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
    requests.add(control)
    let rejectAbort!: () => void
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(control.signal.reason ?? new Error('请求已取消'))
      control.signal.addEventListener('abort', rejectAbort, { once: true })
    })
    const timer = setTimeout(() => control.abort(new Error('请求超时')), REQUEST_TIMEOUT_MS)
    try {
      return await Promise.race([read(control.signal), aborted])
    } finally {
      clearTimeout(timer)
      control.signal.removeEventListener('abort', rejectAbort)
      requests.delete(control)
    }
  }

  function updateIssues(threadId: string, rows: ThreadInterruption[]): void {
    if (changes) changes[threadId] = rows
    const next = { ...issues.value }
    if (rows.length) next[threadId] = rows
    else delete next[threadId]
    issues.value = next
  }

  async function ignoreThread(threadId: string): Promise<void> {
    if (ignoring.value || disposed) return
    const current = [...(issues.value[threadId] || [])]
    ignoring.value = true
    saveError.value = ''
    readError.value = ''
    try {
      for (const issue of current) {
        const response = await request(new AbortController(), signal => fetch('/codex-api/ignored-quota-errors', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
          body: JSON.stringify({ threadId, turnId: issue.turnId, ignored: true }),
        }))
        if (!response.ok) throw new Error('忽略标记保存失败，请重试')
        if (disposed) return
        // Only acknowledged IDs are removed; reading or new failures never count.
        updateIssues(threadId, (issues.value[threadId] || []).filter(row => row.turnId !== issue.turnId))
      }
      // Snapshot recovery is independent of the completed save. Replace a stale
      // read and keep the controls available even if the new read also stalls.
      void refresh(true)
    } catch {
      if (!disposed) saveError.value = '忽略标记保存失败，请重试'
    } finally {
      ignoring.value = false
    }
  }

  function refresh(replace = false): Promise<void> {
    if (disposed) return Promise.resolve()
    if (pending && !replace) return pending
    controller?.abort()
    const control = new AbortController()
    controller = control
    changes = Object.create(null)
    pending = request(control, async signal => {
      const response = await fetch('/codex-api/thread-interruptions', { signal })
      if (!response.ok) throw new Error(READ_ERROR)
      return await response.json() as { data: ThreadInterruptionSnapshot }
    }).then(payload => {
      if (disposed || controller !== control || control.signal.aborted) return
      const next = { ...payload.data, ...changes }
      for (const id of Object.keys(next)) if (!next[id]?.length) delete next[id]
      issues.value = next
      readError.value = ''
    }).catch(() => {
      if (!disposed && controller === control) readError.value = READ_ERROR
    }).finally(() => {
      if (controller === control) {
        pending = undefined
        changes = undefined
      }
    })
    return pending
  }

  function observe(notification: { method: string; params?: unknown }): void {
    if (notification.method === 'ready') {
      void refresh().then(() => {
        // A reconnect may arrive while the old read is pending. Retry once if
        // that shared read fails; concurrent ready events still share one read.
        if (!disposed && readError.value === READ_ERROR) void refresh()
      })
      return
    }
    if (notification.method !== 'codexapp/interruptions/changed') return
    const params = notification.params as { threadId?: string; issues?: ThreadInterruption[] }
    if (!params?.threadId || !Array.isArray(params.issues)) return
    updateIssues(params.threadId, params.issues)
  }

  onBeforeUnmount(() => {
    disposed = true
    for (const control of requests) control.abort()
  })
  return { issues, error, refresh, ignoring, ignoreThread, observe }
}
