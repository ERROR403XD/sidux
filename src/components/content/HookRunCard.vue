<template>
  <details class="process-card hook-run" :data-status="run.status" @toggle="onToggle">
    <summary><span>{{ run.statusMessage || run.eventName }}</span><span>{{ t(hookStatusLabel(run)) }}<small v-if="run.durationMs !== null"> · {{ run.durationMs }} ms</small></span><small v-if="run.entries.length" class="process-id">{{ run.entries[0]?.text.slice(0, 160) }}</small></summary>
    <p>{{ run.eventName }} · {{ run.handlerType }} · {{ t(run.executionMode === 'async' ? '异步' : '同步') }}</p>
    <small>{{ run.source }} · {{ run.sourcePath }}</small>
    <p>{{ formatLocalDateTime(run.startedAt * 1000) }}<template v-if="run.completedAt !== null"> → {{ formatLocalDateTime(run.completedAt * 1000) }}</template></p>
    <p v-if="run.status === 'running' && !run.currentRuntime" class="process-note">{{ t('CLI 已重启，未收到这次执行的结束状态。') }}</p>
    <p v-if="loading">{{ t('读取结果中…') }}</p>
    <p v-if="error" class="process-error" role="alert">{{ t(error) }} <AppButton @click="load">{{ t('重试') }}</AppButton></p>
    <template v-if="detail">
      <div v-for="(entry, index) in detail.entries" :key="index"><small>{{ entry.kind }}</small><pre>{{ entry.text }}</pre></div>
      <p v-if="!detail.entries.length">{{ t('无输出记录。') }}</p>
      <small v-if="detail.truncated">{{ t('输出已截断。') }}</small>
    </template>
    <small class="process-id">{{ t('执行') }} {{ run.id }}<template v-if="run.turnId"> {{ t('· 回合') }} {{ run.turnId }}</template></small>
  </details>
</template>

<script setup lang="ts">
import { t } from '../../composables/useUiLanguage'

import { onBeforeUnmount, ref, watch } from 'vue'
import AppButton from '../common/AppButton.vue'
import { formatLocalDateTime } from '../../dateTime'
import { formatDirectoryError } from '../../directory'
import { hookRunKey, hookStatusLabel, type HookRun } from '../../processActivity'
const props = defineProps<{ run: HookRun }>()
const detail = ref<HookRun | null>(null)
const loading = ref(false)
const error = ref('')
let open = false
let controller: AbortController | null = null

async function load() {
  controller?.abort()
  const request = new AbortController()
  controller = request
  loading.value = true
  error.value = ''
  try {
    const response = await fetch('/codex-api/process-activity/hook-detail?' + new URLSearchParams({ threadId: props.run.threadId, runKey: hookRunKey(props.run) }), { signal: request.signal })
    const payload = await response.json()
    if (!response.ok || !payload.data) throw new Error(payload.error || 'Hook 详细记录已不可用')
    if (!request.signal.aborted && controller === request) detail.value = payload.data
  } catch (cause) {
    if (!request.signal.aborted && controller === request) error.value = formatDirectoryError(cause, 'Hook 结果读取失败')
  } finally {
    if (controller === request) loading.value = false
  }
}
function onToggle(event: Event) {
  open = (event.target as HTMLDetailsElement).open
  if (open) void load()
  else controller?.abort()
}
watch(() => props.run, (run, previous) => {
  if (JSON.stringify(run) !== JSON.stringify(previous)) {
    detail.value = null
    if (open) void load()
  }
})
onBeforeUnmount(() => controller?.abort())
</script>
