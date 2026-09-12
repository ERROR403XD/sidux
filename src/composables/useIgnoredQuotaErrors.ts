import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { subscribeCodexNotifications } from '../api/codexGateway'

export function useIgnoredQuotaErrors(threadId: Ref<string>) {
  const ignored = ref<string[]>([])
  const pending = ref(false)
  const error = ref('')
  let revision = 0
  let disposed = false
  let controller: AbortController | undefined

  async function refresh(): Promise<void> {
    const id = threadId.value
    controller?.abort()
    const current = ++revision
    if (!id) { ignored.value = []; return }
    const request = new AbortController()
    controller = request
    try {
      const response = await fetch(`/codex-api/ignored-quota-errors?threadId=${encodeURIComponent(id)}`, { signal: request.signal })
      if (!response.ok) throw new Error('忽略标记读取失败，请重试')
      const payload = await response.json()
      if (!disposed && current === revision) { ignored.value = payload.data; error.value = '' }
    } catch (cause) {
      if (!disposed && current === revision && !request.signal.aborted) error.value = String(cause)
    }
  }
  async function toggle(turnId: string): Promise<void> {
    if (pending.value) return
    const id = threadId.value
    pending.value = true
    revision++
    controller?.abort()
    error.value = ''
    try {
      const response = await fetch('/codex-api/ignored-quota-errors', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: id, turnId, ignored: !ignored.value.includes(turnId) }),
      })
      if (!response.ok) throw new Error('忽略标记保存失败，请重试')
      const payload = await response.json()
      if (!disposed && threadId.value === id) ignored.value = payload.data
    } catch (cause) {
      if (!disposed && threadId.value === id) error.value = String(cause)
    } finally {
      pending.value = false
    }
  }
  watch(threadId, () => { ignored.value = []; error.value = ''; void refresh() }, { immediate: true })
  const unsubscribe = subscribeCodexNotifications(notification => {
    if (notification.method === 'ready' || (notification.method === 'thread/quotaErrorIgnored/changed' && (notification.params as { threadId?: string })?.threadId === threadId.value)) void refresh()
  })
  onBeforeUnmount(() => { disposed = true; revision++; controller?.abort(); unsubscribe() })
  return { ignored, pending, error, toggle }
}
