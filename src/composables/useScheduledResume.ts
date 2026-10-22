import { onBeforeUnmount, onMounted, ref } from 'vue'
import { subscribeRpcNotifications } from '../api/codexRpcClient'
import type { ScheduledResumeChoice, ScheduledResumeMark } from '../threadScheduledResume'

export function useScheduledResume() {
  const marks = ref<Record<string, ScheduledResumeMark>>({})
  const error = ref('')
  let stopped = false
  let revision = 0
  let pending = false
  let needed = false
  let mutations = 0
  let chain = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  async function request(input?: { threadId: string; at: number | null; choice?: ScheduledResumeChoice }) {
    const response = await fetch('/codex-api/thread-scheduled-resume', input ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    } : undefined)
    const result = await response.json()
    if (!response.ok || !result?.data || Array.isArray(result.data)) throw new Error(result.error || '定时续跑状态读取或保存失败')
    return result.data as Record<string, ScheduledResumeMark>
  }
  function scheduleRefresh(delay = 150): void {
    if (stopped) return
    needed = true
    clearTimeout(timer)
    timer = setTimeout(() => { void refresh() }, delay)
  }
  async function refresh(): Promise<void> {
    if (stopped || pending || mutations) return
    pending = true
    needed = false
    const current = revision
    try {
      const data = await request()
      if (!stopped && current === revision) {
        marks.value = data
        error.value = ''
      }
    } catch (cause) {
      if (!stopped && current === revision) error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      pending = false
      if (needed) scheduleRefresh()
    }
  }
  async function set(threadId: string, at: number | null, choice?: ScheduledResumeChoice): Promise<boolean> {
    revision++
    mutations++
    let saved = false
    const work = chain.then(async () => {
      if (stopped) return
      try {
        const data = await request({ threadId, at, choice })
        if (stopped) return
        marks.value = data
        error.value = ''
        saved = true
      } catch (cause) {
        if (!stopped) error.value = cause instanceof Error ? cause.message : String(cause)
      }
    }).finally(() => {
      mutations--
      if (!mutations && needed) scheduleRefresh()
    })
    chain = work
    await work
    return saved
  }
  const unsubscribe = subscribeRpcNotifications(notification => {
    if (['ready', 'thread/scheduledResume/changed'].includes(notification.method)) scheduleRefresh()
  })
  onMounted(() => scheduleRefresh(500))
  onBeforeUnmount(() => {
    stopped = true
    clearTimeout(timer)
    unsubscribe()
  })
  return { marks, error, set }
}
