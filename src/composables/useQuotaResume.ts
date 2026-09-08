import { onBeforeUnmount, onMounted, ref } from 'vue'
import { subscribeCodexNotifications } from '../api/codexGateway'
import type { QuotaResumeMark } from '../server/threadQuotaResume'

export function useQuotaResume() {
  const marks = ref<Record<string, QuotaResumeMark>>({})
  const error = ref('')
  let disposed = false
  let pending = false
  let timer: ReturnType<typeof setTimeout> | undefined
  async function request(input?: { threadId: string; enabled: boolean }) {
    const response = await fetch('/codex-api/thread-quota-resume', input ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : undefined)
    if (!response.ok) throw new Error('续跑标记保存或读取失败，请重试。')
    const result = await response.json()
    if (!disposed) marks.value = result.data
    error.value = ''
  }
  async function refresh() {
    if (pending || disposed) return
    pending = true
    try { await request() } catch (cause) { error.value = String(cause) }
    finally { pending = false }
  }
  async function toggle(threadId: string) {
    try { await request({ threadId, enabled: !marks.value[threadId] }) }
    catch (cause) { error.value = String(cause) }
  }
  const unsubscribe = subscribeCodexNotifications(notification => {
    if (['ready', 'thread/quotaResume/changed'].includes(notification.method)) {
      clearTimeout(timer)
      timer = setTimeout(() => { void refresh() }, 150)
    }
  })
  onMounted(refresh)
  onBeforeUnmount(() => {
    disposed = true
    clearTimeout(timer)
    unsubscribe()
  })
  return { marks, error, toggle }
}
