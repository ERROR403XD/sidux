<template>
  <div class="account-quota-grid" :class="{ 'is-compact': compact }">
    <div v-for="(window, index) in windows" :key="index" class="account-quota-window">
      <span>{{ t(duration(window.windowDurationMins ?? window.windowMinutes)) }}</span>
      <span class="account-quota-track" role="progressbar" :aria-valuenow="remaining(window.usedPercent)" aria-valuemin="0" aria-valuemax="100" :aria-label="t(`${t(duration(window.windowDurationMins ?? window.windowMinutes))} 剩余额度`)" :style="{ '--quota-color': quotaColor(window.usedPercent) }">
        <span :style="{ width: `${remaining(window.usedPercent)}%` }" />
      </span>
      <strong>{{ remaining(window.usedPercent) }}%</strong>
      <time :title="t(window.resetsAt ? `${formatLocalDateTime(window.resetsAt * 1000)} 重置` : '重置时间未知')">{{ window.resetsAt ? quotaResetTime(window.resetsAt, window.windowDurationMins ?? window.windowMinutes, now) : '—' }}</time>
    </div>
    <small v-if="!windows.length">{{ t('暂无用量') }}</small>
  </div>
</template>
<script setup lang="ts">
import { t } from '../../composables/useUiLanguage'

import { computed } from 'vue'
import { useQuotaClock } from '../../composables/useQuotaClock'
import type { UiRateLimitSnapshot, UiRateLimitWindow } from '../../types/codex'
import { formatLocalDateTime } from '../../dateTime'
import { quotaColor, quotaResetTime, quotaRemaining as remaining } from '../../quotaPresentation'
const now = useQuotaClock()
const props = defineProps<{ snapshot: UiRateLimitSnapshot; compact?: boolean }>()
const windows = computed(() => [props.snapshot.primary, props.snapshot.secondary].filter((value): value is UiRateLimitWindow => value != null))
function duration(minutes: number | null): string {
  if (!minutes) return '限额'
  if (minutes % 1440 === 0) return `${minutes / 1440}天限额`
  if (minutes % 60 === 0) return `${minutes / 60}小时限额`
  return `${minutes}分钟限额`
}
</script>
