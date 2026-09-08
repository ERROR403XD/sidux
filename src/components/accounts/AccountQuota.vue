<template>
  <div class="account-quota-grid" :class="{ 'is-compact': compact }">
    <div v-for="(window, index) in windows" :key="index" class="account-quota-window">
      <span>{{ duration(window.windowDurationMins ?? window.windowMinutes) }}</span>
      <span class="account-quota-track" role="progressbar" :aria-valuenow="remaining(window.usedPercent)" aria-valuemin="0" aria-valuemax="100" :aria-label="`${duration(window.windowDurationMins ?? window.windowMinutes)} 剩余额度`" :style="{ '--quota-color': quotaColor(window.usedPercent) }">
        <span :style="{ width: `${remaining(window.usedPercent)}%` }" />
      </span>
      <strong>{{ remaining(window.usedPercent) }}%</strong>
      <time :title="window.resetsAt ? `${formatLocalDateTime(window.resetsAt * 1000)} 重置` : '重置时间未知'">{{ window.resetsAt ? resetTime(window.resetsAt) : '—' }}</time>
    </div>
    <small v-if="!windows.length">暂无用量</small>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import type { UiRateLimitSnapshot, UiRateLimitWindow } from '../../types/codex'
import { formatLocalDateTime } from '../../dateTime'
import { quotaColor, quotaRemaining as remaining } from '../../quotaPresentation'
const props = defineProps<{ snapshot: UiRateLimitSnapshot; compact?: boolean }>()
const windows = computed(() => [props.snapshot.primary, props.snapshot.secondary].filter((value): value is UiRateLimitWindow => value != null))
function duration(minutes: number | null): string {
  if (!minutes) return '限额'
  if (minutes % 1440 === 0) return `${minutes / 1440}天限额`
  if (minutes % 60 === 0) return `${minutes / 60}小时限额`
  return `${minutes}分钟限额`
}
function resetTime(seconds: number): string {
  return formatLocalDateTime(seconds * 1000, { year: undefined, month: undefined, day: undefined, hour: '2-digit', minute: '2-digit' }, 'zh-CN')
}
</script>
