import { onBeforeUnmount, onMounted, ref } from 'vue'
import { subscribeRpcNotifications } from '../api/codexRpcClient'
import type { QuotaResumeMark } from '../server/threadQuotaResume'

export function useQuotaResume() {
  const marks = ref<Record<string, QuotaResumeMark>>({})
  const error = ref('')
  let disposed = false
  let pending = false
  let refreshNeeded = false
  let notificationReady = false
  let mutationRevision = 0
  let pendingMutations = 0
  let mutationChain = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined

  async function request(input?: { threadId: string; enabled: boolean }): Promise<Record<string, QuotaResumeMark>> {
    const response = await fetch('/codex-api/thread-quota-resume', input ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : undefined)
    const result = await response.json().catch(() => null)
    if (!response.ok || !result?.data || typeof result.data !== 'object' || Array.isArray(result.data)) {
      throw new Error(typeof result?.error === 'string' ? result.error : '续跑标记保存或读取失败，请重试。')
    }
    return result.data
  }

  function scheduleRefresh(delay = 150): void {
    if (disposed) return
    refreshNeeded = true
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void refresh()
    }, delay)
  }

  async function refresh() {
    if (pending || pendingMutations || disposed) return
    pending = true
    refreshNeeded = false
    const revision = mutationRevision
    try {
      const data = await request()
      if (disposed || revision !== mutationRevision) return
      marks.value = data
      error.value = ''
    } catch (cause) {
      if (!disposed && revision === mutationRevision) {
        error.value = cause instanceof Error ? cause.message : String(cause)
      }
    } finally {
      pending = false
      // A notification received during the read may describe a newer server snapshot.
      if (refreshNeeded) scheduleRefresh()
    }
  }

  async function toggle(threadId: string) {
    if (disposed) return
    mutationRevision++
    pendingMutations++
    const operation = mutationChain.then(async () => {
      if (disposed) return
      try {
        const data = await request({ threadId, enabled: !marks.value[threadId] })
        if (disposed) return
        marks.value = data
        error.value = ''
      } catch (cause) {
        if (!disposed) error.value = cause instanceof Error ? cause.message : String(cause)
      }
    }).finally(() => {
      pendingMutations--
      if (!pendingMutations && refreshNeeded) scheduleRefresh()
    })
    mutationChain = operation
    await operation
  }

  const unsubscribe = subscribeRpcNotifications(notification => {
    if (disposed) return
    if (notification.method === 'ready') notificationReady = true
    if (['ready', 'thread/quotaResume/changed'].includes(notification.method)) scheduleRefresh()
  })
  onMounted(() => {
    // Read after the subscription handshake; a failed connection must not hide saved marks.
    if (!notificationReady) scheduleRefresh(500)
  })
  onBeforeUnmount(() => {
    disposed = true
    clearTimeout(timer)
    unsubscribe()
  })
  return { marks, error, toggle }
}
