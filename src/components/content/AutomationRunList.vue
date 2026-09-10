<template>
    <ol class="automation-history-list">
      <li v-for="run in runs" :key="run.runId" :data-run-status="run.status">
        <div class="automation-history-line"><strong>{{ t(statusLabels[run.status]) }}</strong><span>{{ t(triggerLabels[run.trigger]) }} {{ t('· 第') }} {{ run.attempt }} {{ t('次') }}</span></div>
        <div class="automation-history-line"><time :datetime="new Date(run.scheduledAt).toISOString()" :title="formatLocalDateTime(run.scheduledAt, { second: '2-digit' })">{{ formatLocalDateTime(run.scheduledAt) }}</time><span>{{ t(duration(run)) }}</span></div>
        <p v-if="run.target !== target" class="automation-history-muted">{{ run.target }}</p>
        <p v-if="run.error" class="automation-history-error">{{ t(run.error) }}</p>
        <div class="automation-history-links">
          <a v-if="run.threadId" :href="`#/thread/${encodeURIComponent(run.threadId)}`">{{ t('打开会话') }}</a>
          <button v-if="['failed', 'interrupted', 'missed'].includes(run.status)" type="button" :disabled="disabled" @click="emit('retry', run)">{{ t('检查结果后重试') }}</button>
          <small v-if="run.model">{{ run.model }}<template v-if="run.reasoningEffort"> · {{ run.reasoningEffort }}</template><template v-if="run.serviceTier"> · {{ run.serviceTier }}</template></small>
        </div>
      </li>
    </ol>
</template>
<script setup lang="ts">
import { t } from '../../composables/useUiLanguage'

import { formatLocalDateTime } from '../../dateTime'
import type { AutomationRun } from '../../server/automationStore'
defineProps<{ runs: AutomationRun[]; target: string; disabled: boolean }>()
const emit = defineEmits<{ retry: [run: AutomationRun] }>()
const statusLabels = { queued: '排队中', starting: '启动 / 核对中', running: '运行中', waiting_input: '等待处理', completed: '完成', failed: '失败', interrupted: '中断，需检查', missed: '漏跑', skipped: '已合并', cancelled: '已取消' }
const triggerLabels = { manual: '手动', schedule: '定时', retry: '重试' }

function duration(run: AutomationRun) { return run.startedAt ? `${Math.max(0, Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000))} 秒` : '—' }
</script>
