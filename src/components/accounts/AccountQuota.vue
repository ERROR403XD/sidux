<template>
  <div class="account-quota-grid" :class="{ 'is-compact': compact }">
    <div v-for="(window, index) in windows" :key="index" class="account-quota-window">
      <div><span>{{ duration(window.windowDurationMins) }}</span><strong>剩余 {{ Math.round(100 - window.usedPercent) }}%</strong></div>
      <progress :value="Math.max(0, 100 - window.usedPercent)" max="100" :aria-label="`${duration(window.windowDurationMins)} 剩余额度`" />
      <small v-if="!compact && window.resetsAt">{{ formatLocalDateTime(window.resetsAt * 1000, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }} 重置</small>
    </div>
    <small v-if="!windows.length">暂无窗口用量</small>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import type { UiRateLimitSnapshot, UiRateLimitWindow } from '../../types/codex'
import { formatLocalDateTime } from '../../dateTime'
const props = defineProps<{ snapshot: UiRateLimitSnapshot; compact?: boolean }>()
const windows = computed(() => [props.snapshot.primary, props.snapshot.secondary].filter((value): value is UiRateLimitWindow => value !== null))
function duration(minutes: number | null): string {
  if (!minutes) return '额度窗口'
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`
  if (minutes % 60 === 0) return `${minutes / 60} 小时`
  return `${minutes} 分钟`
}
</script>
