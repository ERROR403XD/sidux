<template>
  <div v-if="pending.length || error" class="delivery-outbox">
    <p v-if="error" class="delivery-outbox-error" role="alert">{{ t(error) }}</p>
    <div v-for="row in pending" :key="row.id" class="delivery-outbox-row" :data-outbox-id="row.id">
      <div class="delivery-outbox-content">
        <span>{{ t('提交结果待确认') }}</span>
        <span class="delivery-outbox-preview">{{ readQuestionReply(row.body.message.text).questionReply ? t('问题回答') : row.body.message.text || t('含附件的消息') }}</span>
      </div>
      <div class="delivery-outbox-actions">
        <AppButton :busy="busyId === row.id" :disabled="Boolean(busyId)" @click="reconcile(row)">{{ t('核对提交') }}</AppButton>
        <AppButton :disabled="Boolean(busyId)" @click="forgetId = row.id">{{ t('停止跟踪') }}</AppButton>
      </div>
    </div>
    <AppDialog :open="Boolean(forgetId)" :title="t('停止跟踪这次提交？')" size="compact" @close="forgetId = ''">
      <p>{{ t('提交可能已送达，停止跟踪不会取消队列消息或中止任务。') }}</p>
      <template #footer>
        <AppButton @click="forgetId = ''">{{ t('保留记录') }}</AppButton>
        <AppButton variant="danger" @click="confirmForget">{{ t('停止跟踪') }}</AppButton>
      </template>
    </AppDialog>
  </div>
</template>

<script setup lang="ts">
import { t } from '../../composables/useUiLanguage'

import { readQuestionReply } from '../../userQuestions'
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { DELIVERY_OUTBOX_EVENT, forgetWebDelivery, readPendingWebDeliveries, submitRememberedDelivery, type PendingWebDelivery } from '../../api/deliveryOutbox'
import type { StoredQueuedMessage } from '../../threadQueue'
import AppButton from '../common/AppButton.vue'
import AppDialog from '../common/AppDialog.vue'

const props = defineProps<{ threadId: string; queue: StoredQueuedMessage[] }>()
const emit = defineEmits<{ settled: [submission: PendingWebDelivery] }>()
const pending = ref<PendingWebDelivery[]>([])
const error = ref('')
const busyId = ref('')
const forgetId = ref('')

function refresh(): void {
  try {
    const rows = readPendingWebDeliveries(props.threadId)
    pending.value = rows.filter(row => !props.queue.some(message => message.id === row.id))
    for (const row of rows) {
      // A visible server record also confirms durable receipt after a lost HTTP response.
      if (props.queue.some(message => message.id === row.id)) {
        forgetWebDelivery(row.id, false)
        emit('settled', row)
      }
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法读取待确认提交'
  }
}

async function reconcile(row: PendingWebDelivery): Promise<void> {
  if (busyId.value) return
  busyId.value = row.id
  error.value = ''
  try {
    const result = await submitRememberedDelivery(row)
    if (result.data.status !== 'cancelled') emit('settled', row)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '尚未确认提交结果，请稍后核对'
  } finally {
    busyId.value = ''
    refresh()
  }
}

function confirmForget(): void {
  const id = forgetId.value
  forgetId.value = ''
  if (id) forgetWebDelivery(id)
  refresh()
}

watch(() => [props.threadId, props.queue], refresh, { immediate: true })
onMounted(() => {
  window.addEventListener(DELIVERY_OUTBOX_EVENT, refresh)
  window.addEventListener('storage', refresh)
})
onBeforeUnmount(() => {
  window.removeEventListener(DELIVERY_OUTBOX_EVENT, refresh)
  window.removeEventListener('storage', refresh)
})
</script>
