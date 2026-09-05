<template>
  <section class="automation-history" aria-label="执行记录">
    <div class="automation-history-heading">
      <h3>执行记录</h3>
      <button type="button" :disabled="busy || !runtime?.ready || runtime.draining" @click="runNow()">{{ busy ? '提交中…' : '立即运行' }}</button>
    </div>
    <p class="automation-history-schedule">{{ nextTime }} · {{ metadata?.timezone || automation.timezone || runtime?.timezone }}</p>
    <p v-if="error" class="automations-error" role="alert">{{ error }}</p>
    <p v-if="!runs.length" class="automation-history-muted">尚无执行记录。完成表示模型回合正常结束；业务产物可在执行会话中核对。</p>
    <ol v-else class="automation-history-list">
      <li v-for="run in runs" :key="run.runId" :data-run-status="run.status">
        <div class="automation-history-line"><strong>{{ statusLabels[run.status] }}</strong><span>{{ triggerLabels[run.trigger] }} · 第 {{ run.attempt }} 次</span></div>
        <div class="automation-history-line"><time>{{ formatTime(run.scheduledAt, run.timezone) }}</time><span>{{ duration(run) }}</span></div>
        <p v-if="run.target !== target" class="automation-history-muted">{{ run.target }}</p>
        <p v-if="run.error" class="automation-history-error">{{ run.error }}</p>
        <div class="automation-history-links">
          <a v-if="run.threadId" :href="`#/thread/${encodeURIComponent(run.threadId)}`">打开会话</a>
          <button v-if="['failed', 'interrupted', 'missed'].includes(run.status)" type="button" :disabled="busy || !runtime?.ready || runtime.draining" @click="runNow(run)">检查结果后重试</button>
          <small v-if="run.model">{{ run.model }}</small>
        </div>
      </li>
    </ol>
    <button v-if="cursor" class="automation-history-more" type="button" :disabled="loading" @click="load(true)">更早记录</button>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getAutomationRuns, createAutomationRequestId, getAutomationRuntime, runAutomationNow, subscribeCodexNotifications, type AutomationRuntimeStatus } from '../../api/automationGateway'
import type { UiThreadAutomation } from '../../types/codex'
import type { AutomationRun } from '../../server/automationStore'
const props = defineProps<{ automation: UiThreadAutomation; target: string }>()
const runs = ref<AutomationRun[]>([])
const runtime = ref<AutomationRuntimeStatus | null>(null)
const cursor = ref<number | null>(null)
const busy = ref(false), loading = ref(false), error = ref('')
let generation = 0, reloadTimer: ReturnType<typeof setTimeout> | undefined, interval: ReturnType<typeof setInterval> | undefined
let unsubscribe: (() => void) | undefined
const metadata = computed(() => runtime.value?.definitions.find((row) => row.id === props.automation.id))
const nextTime = computed(() => props.automation.status === 'PAUSED' ? '已暂停' : metadata.value?.nextRunAtMs ? `下次 ${formatTime(metadata.value.nextRunAtMs, metadata.value.timezone)}` : '暂无下次运行时间')
const statusLabels = { queued: '排队中', starting: '启动 / 核对中', running: '运行中', waiting_input: '等待处理', completed: '完成', failed: '失败', interrupted: '中断，需检查', missed: '漏跑', skipped: '已合并', cancelled: '已取消' }
const triggerLabels = { manual: '手动', schedule: '定时', retry: '重试' }
function formatTime(at: number, zone?: string) { return new Date(at).toLocaleString('zh-CN', { timeZone: zone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }
function duration(run: AutomationRun) { return run.startedAt ? `${Math.max(0, Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000))} 秒` : '—' }
async function load(older = false) {
  const current = ++generation
  loading.value = true
  try {
    const [history, state] = await Promise.all([getAutomationRuns(props.automation.id, older ? cursor.value : null), getAutomationRuntime()])
    if (current !== generation) return
    runs.value = older ? [...runs.value, ...history.data] : history.data
    cursor.value = history.nextCursor; runtime.value = state
  } catch (cause) { if (current === generation) error.value = cause instanceof Error ? cause.message : '读取记录失败' }
  finally { if (current === generation) loading.value = false }
}
async function runNow(previous?: AutomationRun) {
  if (busy.value) return
  busy.value = true; error.value = ''
  try {
    await runAutomationNow({ automationId: props.automation.id, target: previous?.target ?? props.target, kind: props.automation.kind, requestId: createAutomationRequestId(), retryOf: previous?.runId })
    await load()
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '提交失败' }
  finally { busy.value = false }
}
watch(() => props.automation.id, () => { runs.value = []; cursor.value = null; void load() })
onMounted(() => {
  void load()
  unsubscribe = subscribeCodexNotifications((notification) => {
    if (notification.method !== 'automation/changed' || reloadTimer) return
    reloadTimer = setTimeout(() => { reloadTimer = undefined; if (document.visibilityState === 'visible') void load() }, 500)
  })
  interval = setInterval(() => { if (document.visibilityState === 'visible' && !loading.value) void load() }, 30000)
})
onBeforeUnmount(() => { generation++; unsubscribe?.(); clearTimeout(reloadTimer); clearInterval(interval) })
</script>
