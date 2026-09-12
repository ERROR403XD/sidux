<template>
  <div v-if="messages.length" class="queued-messages">
    <div class="queued-messages-inner">
      <div
        v-for="msg in messages"
        :key="msg.id"
        class="queued-row"
        :data-delivery-id="msg.id"
        :data-delivery-status="msg.delivery?.status"
        :class="{ 'is-dragging': draggedMessageId === msg.id, 'is-drop-target': dropTargetMessageId === msg.id && draggedMessageId !== msg.id }"
        :draggable="!isQuestion(msg) && msg.delivery?.status === 'queued'"
        @dragstart="onDragStart($event, msg)"
        @dragover.prevent="onDragOver(msg)"
        @dragleave="onDragLeave(msg.id)"
        @drop.prevent="onDrop(msg)"
        @dragend="resetDragState"
      >
        <div class="queued-row-content">
          <span class="queued-row-text" :title="getMessagePreview(msg)">{{ getMessagePreview(msg) }}</span>
          <span class="queued-row-status">{{ t(msg.delivery ? deliveryStatusLabel(msg.delivery.status) : '等待加载发送状态') }}</span>
          <span v-if="msg.delivery?.error" class="queued-row-error">{{ t(msg.delivery.error) }}</span>
        </div>
        <div v-if="isQuestion(msg)" class="queued-row-actions">
          <AppButton v-if="msg.delivery?.status === 'unknown'" @click="emit('reconcile', msg.id)">{{ t('核对回答') }}</AppButton>
          <AppButton v-if="msg.delivery?.status === 'failed'" @click="emit('resume', msg.id)">{{ t('重试回答') }}</AppButton>
        </div>
        <div v-else class="queued-row-actions">
          <AppButton v-if="['queued', 'failed', 'editing'].includes(msg.delivery?.status ?? '')" @click="emit('edit', msg.id)">{{ t(msg.delivery?.status === 'editing' ? '继续编辑' : '编辑') }}</AppButton>
          <AppButton v-if="msg.delivery?.status === 'queued'" :title="t('发送引导消息，不中断当前任务')" @click="emit('steer', msg.id)">{{ t('引导') }}</AppButton>
          <AppButton v-if="msg.delivery?.status === 'unknown'" @click="emit('reconcile', msg.id)">{{ t('核对结果') }}</AppButton>
          <AppButton v-if="msg.delivery?.status === 'failed'" @click="emit('resume', msg.id)">{{ t('重新排队') }}</AppButton>
          <AppButton v-if="msg.delivery?.status === 'editing'" @click="emit('resume', msg.id)">{{ t('取消编辑') }}</AppButton>
          <AppButton v-if="msg.delivery?.status === 'unknown'" variant="danger" @click="abandonId = msg.id">{{ t('停止跟踪') }}</AppButton>
          <AppButton v-else-if="msg.delivery && msg.delivery.status !== 'sending'" variant="danger" @click="emit('delete', msg.id)">{{ t('删除') }}</AppButton>
        </div>
      </div>
    </div>
    <AppDialog :open="Boolean(abandonId)" :title="t('停止跟踪这条消息？')" size="compact" @close="abandonId = ''">
      <p>{{ t('消息可能已经送达。停止跟踪不会中止已执行的任务；后续消息将可以继续发送。') }}</p>
      <template #footer>
        <AppButton @click="abandonId = ''">{{ t('保留记录') }}</AppButton>
        <AppButton variant="danger" @click="confirmAbandon">{{ t('停止跟踪') }}</AppButton>
      </template>
    </AppDialog>
  </div>
</template>

<script setup lang="ts">
import { t } from '../../composables/useUiLanguage'

import { ref, watch } from 'vue'
import { readQuestionReply } from '../../userQuestions'
import { deliveryStatusLabel } from '../../delivery'
import type { StoredQueuedMessage } from '../../threadQueue'
import AppButton from '../common/AppButton.vue'
import AppDialog from '../common/AppDialog.vue'

const props = defineProps<{ messages: StoredQueuedMessage[] }>()
const emit = defineEmits<{
  edit: [messageId: string]
  steer: [messageId: string]
  delete: [messageId: string]
  reconcile: [messageId: string]
  resume: [messageId: string]
  abandon: [messageId: string]
  reorder: [payload: { draggedId: string; targetId: string }]
}>()
const draggedMessageId = ref('')
const dropTargetMessageId = ref('')
const abandonId = ref('')
watch(() => props.messages, messages => {
  if (abandonId.value && !messages.some(row => row.id === abandonId.value)) abandonId.value = ''
})

function confirmAbandon(): void {
  const id = abandonId.value
  abandonId.value = ''
  if (id) emit('abandon', id)
}

function onDragStart(event: DragEvent, message: StoredQueuedMessage): void {
  if (isQuestion(message) || message.delivery?.status !== 'queued') {
    event.preventDefault()
    return
  }
  draggedMessageId.value = message.id
  dropTargetMessageId.value = ''
  event.dataTransfer?.setData('text/plain', message.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onDragOver(message: StoredQueuedMessage): void {
  if (message.delivery?.status !== 'queued' || !draggedMessageId.value || draggedMessageId.value === message.id) return
  dropTargetMessageId.value = message.id
}

function onDragLeave(id: string): void {
  if (dropTargetMessageId.value === id) dropTargetMessageId.value = ''
}

function onDrop(message: StoredQueuedMessage): void {
  const draggedId = draggedMessageId.value
  resetDragState()
  if (message.delivery?.status !== 'queued' || !draggedId || draggedId === message.id) return
  emit('reorder', { draggedId, targetId: message.id })
}

function resetDragState(): void {
  draggedMessageId.value = ''
  dropTargetMessageId.value = ''
}

function isQuestion(message: StoredQueuedMessage): boolean { return Boolean(readQuestionReply(message.text).questionReply) }

function getMessagePreview(message: StoredQueuedMessage): string {
  if (isQuestion(message)) return t('问题回答')
  return message.text.trim() || [
    message.imageUrls.length ? t(`${message.imageUrls.length} 张图片`) : '',
    message.fileAttachments.length ? t(`${message.fileAttachments.length} 个文件`) : '',
    message.skills.length ? t(`${message.skills.length} 个技能`) : '',
  ].filter(Boolean).join(' · ') || t('空消息')
}
</script>

<style scoped>
.queued-messages { width: 100%; max-width: min(var(--chat-column-max, 45rem), 100%); margin: 0 auto; }
.queued-messages-inner { display: flex; flex-direction: column; max-height: 30dvh; overflow-y: auto; border: 1px solid var(--ui-border); border-bottom: 0; border-radius: 16px 16px 0 0; padding: 6px 12px; background: var(--ui-surface); }
.queued-row { display: flex; align-items: center; gap: 12px; min-width: 0; padding: 8px 0; color: var(--ui-text); }
.queued-row + .queued-row { border-top: 1px solid var(--ui-border); }
.queued-row[draggable="true"] { cursor: grab; }
.queued-row.is-dragging { opacity: .5; }
.queued-row.is-drop-target { background: var(--ui-hover); }
.queued-row-content { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
.queued-row-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.queued-row-status { font-size: 11px; opacity: .75; }
.queued-row-error { font-size: 12px; color: var(--ui-danger); overflow-wrap: anywhere; }
.queued-row-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; flex-shrink: 0; }
.queued-row-actions :deep(.app-button) { padding: 3px 7px; font-size: 12px; }
@media (max-width: 600px) {
  .queued-row { align-items: stretch; flex-direction: column; gap: 6px; }
  .queued-row-actions { justify-content: flex-start; }
}
</style>
