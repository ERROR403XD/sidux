<template>
  <section class="thread-tasks-panel" :aria-label="t('任务导航')">
    <div class="thread-task-toolbar">
      <AppButton v-if="identity?.parentThreadId" @click="emit('returnTask', identity.parentThreadId)">{{ t('返回上级任务') }}</AppButton>
      <span v-if="identity?.parentThreadId" class="task-identity">{{ identity.nickname || identity.path || shortTaskId(identity.id) }}<small v-if="identity.role"> · {{ identity.role }}</small></span>
      <AppButton :aria-expanded="open" @click="toggle">{{ t(open ? '收起子任务' : '子任务') }}</AppButton>
      <AppButton @click="emit('searchTasks')">{{ t('搜索任务') }}</AppButton>
      <slot name="tools" />
    </div>
    <p v-if="identity?.canAcceptDirectInput === false" class="task-input-note">{{ t(identity?.parentThreadId ? '此子任务由上级控制，可返回上级继续沟通。' : '当前任务不接受直接输入。') }}</p>
    <div v-if="open" class="thread-tasks-body">
      <div class="task-result-heading"><small>{{ t('直属子任务') }}</small><AppButton :disabled="loading" @click="load(false)">{{ t('刷新') }}</AppButton></div>
      <p v-if="error" role="alert">{{ t(error) }}</p>
      <p v-if="loading" role="status">{{ t('读取中…') }}</p>
      <p v-else-if="!rows.length && !error">{{ t('暂无已保存的直属子任务。') }}</p>
      <ul class="task-result-list">
        <li v-for="row in rows" :key="row.id">
          <div class="task-result-heading"><a :href="`#/thread/${row.id}`" :title="row.id" @click.prevent="emit('openTask', row.id)">{{ row.nickname || row.title }}</a><small>{{ t(taskStatusLabel(row.status)) }}</small></div>
          <small v-if="row.role || row.path">{{ [row.role, row.path].filter(Boolean).join(' · ') }}</small>
          <p v-if="row.preview" class="task-preview">{{ row.preview }}</p>
        </li>
      </ul>
      <AppButton v-if="cursor && rows.length < 200" :disabled="loading" @click="load(true)">{{ t('加载更多子任务') }}</AppButton>
      <small v-else-if="cursor">{{ t('当前显示前 200 个子任务。') }}</small>
    </div>
  </section>
</template>

<script setup lang="ts">
import { t } from '../../composables/useUiLanguage'

import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppButton from '../common/AppButton.vue'
import { listTaskPage } from '../../api/tasks'
import { shortTaskId, subscribeTaskNotifications, taskStatusLabel, type TaskIdentity } from '../../subtasks'
const props = defineProps<{ threadId: string; identity: TaskIdentity | null }>()
const emit = defineEmits<{ openTask: [threadId: string]; returnTask: [threadId: string]; searchTasks: [] }>()
const open = ref(false)
const loading = ref(false)
const error = ref('')
const rows = ref<TaskIdentity[]>([])
const cursor = ref<string | null>(null)
let controller: AbortController | null = null
let timer: ReturnType<typeof setTimeout> | null = null
function cancel() {
  controller?.abort()
  controller = null
  loading.value = false
  if (timer) clearTimeout(timer)
  timer = null
}
async function load(more: boolean) {
  if (!open.value || !props.threadId) return
  controller?.abort()
  const request = new AbortController()
  controller = request
  const requestedCursor = more ? cursor.value : null
  loading.value = true
  error.value = ''
  try {
    const result = await listTaskPage({ parentId: props.threadId, cursor: requestedCursor, signal: request.signal })
    if (controller !== request || request.signal.aborted) return
    if (requestedCursor && result.nextCursor === requestedCursor) throw new Error('任务分页未前进，请刷新后重试。')
    rows.value = [...new Map([...(more ? rows.value : []), ...result.rows].map(row => [row.id, row])).values()].slice(0, 200)
    cursor.value = result.nextCursor
  } catch (cause) {
    if (!request.signal.aborted && controller === request) error.value = cause instanceof Error ? cause.message : '子任务读取失败。'
  } finally {
    if (controller === request) loading.value = false
  }
}
function refreshSoon() {
  if (!open.value) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void load(false)
  }, 200)
}
function toggle() {
  open.value = !open.value
  if (open.value) void load(false)
  else cancel()
}
const unsubscribe = subscribeTaskNotifications(({ method, params }) => {
  if (method === 'codexapp/reconnected') {
    refreshSoon()
    return
  }
  if (!open.value || !params || typeof params !== 'object') return
  const value = params as Record<string, any>
  const threadId = value.threadId || value.thread?.id
  if ((method === 'thread/started' && value.thread?.parentThreadId === props.threadId)
    || (['item/started', 'item/completed'].includes(method) && threadId === props.threadId && ['collabAgentToolCall', 'subAgentActivity'].includes(value.item?.type))
    || (['thread/status/changed', 'turn/completed'].includes(method) && rows.value.some(row => row.id === threadId))) refreshSoon()
})
onMounted(() => window.addEventListener('focus', refreshSoon))
watch(() => props.threadId, () => {
  cancel()
  open.value = false
  rows.value = []
  cursor.value = null
  error.value = ''
})
onBeforeUnmount(() => {
  cancel()
  unsubscribe()
  window.removeEventListener('focus', refreshSoon)
})
</script>
