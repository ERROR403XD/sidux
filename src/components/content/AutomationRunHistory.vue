<template>
  <section class="automation-history" :aria-label="t('执行记录')">
    <div class="automation-history-heading">
      <h3>{{ t('执行记录') }}</h3>
      <AppButton type="button" :disabled="runDisabled" @click="runNow()">{{ t(busy ? '提交中…' : '立即运行') }}</AppButton>
    </div>
    <p class="automation-history-schedule">{{ t(nextTime) }}</p>
    <p v-if="error" class="automations-error" role="alert">{{ t(error) }}</p>
    <p v-if="!runs.length" class="automation-history-muted">{{ t(loading ? '读取中…' : '尚无执行记录。') }}</p>
    <AutomationRunList :runs="runs" :target="target" :disabled="runDisabled" @retry="runNow" />
    <AppButton class="automation-history-all" type="button" @click="openHistory">{{ t('查看全部') }}</AppButton>
    <AppDialog ref="historyDialog" :open="allOpen" :title="t(`${automation.name} · 全部执行记录`)" @close="closeHistory">
      <section class="automation-history automation-history-full" :aria-busy="pageLoading">
        <p v-if="pageError" class="automation-history-error" role="alert">{{ t(pageError) }}</p>
        <p v-if="pageLoading" class="automation-history-muted">{{ t('读取中…') }}</p>
        <p v-else-if="!pageRuns.length" class="automation-history-muted">{{ t('尚无执行记录。') }}</p>
        <AutomationRunList :runs="pageRuns" :target="target" :disabled="runDisabled" @retry="runNow" />
      </section>
      <template #footer>
        <span>{{ t('第') }} {{ pageIndex + 1 }} {{ t('页 · 每页 100 条') }}</span>
        <div class="automation-history-pagination">
          <AppButton type="button" :disabled="pageLoading || pageIndex === 0" @click="loadPage(pageIndex - 1)">{{ t('上一页') }}</AppButton>
          <AppButton type="button" :disabled="pageLoading || !nextCursor" @click="loadPage(pageIndex + 1)">{{ t('下一页') }}</AppButton>
          <AppButton type="button" :disabled="pageLoading" @click="refreshHistory">{{ t('刷新') }}</AppButton>
        </div>
      </template>
    </AppDialog>
  </section>
</template>
<script setup lang="ts">
import { notifyOperation } from '../../composables/useOperationToast'
import { t } from '../../composables/useUiLanguage'

import { formatLocalDateTime } from '../../dateTime'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppDialog from '../common/AppDialog.vue'
import AppButton from '../common/AppButton.vue'
import AutomationRunList from './AutomationRunList.vue'
import { getAutomationRuns, createAutomationRequestId, getAutomationRuntime, runAutomationNow, subscribeCodexNotifications, type AutomationRuntimeStatus } from '../../api/automationGateway'
import type { UiThreadAutomation } from '../../types/codex'
import type { AutomationRun } from '../../server/automationStore'
const props = defineProps<{ automation: UiThreadAutomation; target: string }>()
const runs = ref<AutomationRun[]>([]), pageRuns = ref<AutomationRun[]>([])
const runtime = ref<AutomationRuntimeStatus | null>(null)
const busy = ref(false), loading = ref(false), error = ref('')
const allOpen = ref(false), pageLoading = ref(false), pageError = ref(''), pageIndex = ref(0)
const nextCursor = ref<string | null>(null)
const historyDialog = ref<{ scrollToTop(): void } | null>(null)
let cursors: (string | null)[] = [null], pageGeneration = 0
let generation = 0, reloadTimer: ReturnType<typeof setTimeout> | undefined, interval: ReturnType<typeof setInterval> | undefined
let unsubscribe: (() => void) | undefined
const metadata = computed(() => runtime.value?.definitions.find(row => row.id === props.automation.id))
const runDisabled = computed(() => busy.value || !runtime.value?.ready || runtime.value.draining)
const nextTime = computed(() => props.automation.status === 'PAUSED' ? '已暂停' : metadata.value?.nextRunAtMs ? `下次 ${formatLocalDateTime(metadata.value.nextRunAtMs)}` : '暂无下次运行时间')
async function load() {
  const current = ++generation
  loading.value = true
  try {
    const [history, state] = await Promise.all([getAutomationRuns(props.automation.id, null, 5), getAutomationRuntime()])
    if (current !== generation) return
    runs.value = history.data; runtime.value = state; error.value = ''
  } catch (cause) { if (current === generation) error.value = cause instanceof Error ? cause.message : '读取记录失败' }
  finally { if (current === generation) loading.value = false }
}
async function loadPage(index: number) {
  const current = ++pageGeneration
  pageLoading.value = true; pageError.value = ''
  try {
    const history = await getAutomationRuns(props.automation.id, cursors[index] ?? null, 100)
    if (current !== pageGeneration || !allOpen.value) return
    pageRuns.value = history.data; nextCursor.value = history.nextCursor; pageIndex.value = index
    cursors[index + 1] = history.nextCursor
    await nextTick(); historyDialog.value?.scrollToTop()
  } catch (cause) { if (current === pageGeneration) pageError.value = cause instanceof Error ? cause.message : '读取历史失败' }
  finally { if (current === pageGeneration) pageLoading.value = false }
}
function refreshHistory() { cursors = [null]; pageIndex.value = 0; pageRuns.value = []; nextCursor.value = null; void loadPage(0) }
function openHistory() { allOpen.value = true; pageRuns.value = []; refreshHistory() }
function closeHistory() { allOpen.value = false; pageGeneration++; pageLoading.value = false }
async function runNow(previous?: AutomationRun) {
  if (runDisabled.value) return
  busy.value = true; error.value = ''
  try {
    await runAutomationNow({ automationId: props.automation.id, target: previous?.target ?? props.target, kind: props.automation.kind, requestId: createAutomationRequestId(), retryOf: previous?.runId })
    await load()
  } catch (cause) { notifyOperation(cause instanceof Error ? cause.message : '提交失败') }
  finally { busy.value = false }
}
watch(() => props.automation.id, () => { closeHistory(); runs.value = []; void load() })
onMounted(() => {
  void load()
  unsubscribe = subscribeCodexNotifications(notification => {
    if (notification.method !== 'automation/changed' || reloadTimer) return
    reloadTimer = setTimeout(() => { reloadTimer = undefined; if (document.visibilityState === 'visible') void load() }, 500)
  })
  interval = setInterval(() => { if (document.visibilityState === 'visible' && !loading.value) void load() }, 30000)
})
onBeforeUnmount(() => { generation++; pageGeneration++; unsubscribe?.(); clearTimeout(reloadTimer); clearInterval(interval) })
</script>
