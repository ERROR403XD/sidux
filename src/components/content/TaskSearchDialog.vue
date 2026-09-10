<template>
  <AppDialog :open="open" :title="t('搜索任务')" panel-class="task-search-dialog" @close="emit('close')">
    <div class="task-search-controls">
      <input v-model="query" class="app-input" :aria-label="t('搜索任务')" maxlength="200" :placeholder="t(mode === 'title' ? '搜索标题' : '搜索正文')" />
      <AppSelect :model-value="mode" :options="[{ value: 'title', label: t('标题') }, { value: 'body', label: t('正文') }]" @update:model-value="setMode" />
    </div>
    <p class="task-search-scope">{{ t(query.trim() ? (mode === 'body' ? '搜索已索引正文' : '按任务标题搜索') : '最近的非归档任务') }} {{ t('· 每页 20 条') }}</p>
    <p v-if="error" role="alert">{{ t(error) }} <AppButton :disabled="loading || inserting" @click="load(false)">{{ t('重试') }}</AppButton></p>
    <p v-if="loading" role="status">{{ t('搜索中…') }}</p>
    <p v-else-if="!rows.length && !error">{{ t('未找到匹配任务。') }}</p>
    <ul class="task-result-list">
      <li v-for="row in rows" :key="row.id">
        <div class="task-result-heading"><strong>{{ row.title }}</strong><small>{{ t(taskStatusLabel(row.status)) }}</small></div>
        <small v-if="row.nickname || row.role">{{ [row.nickname, row.role].filter(Boolean).join(' · ') }}</small>
        <p class="task-preview">{{ row.snippet || row.preview }}</p>
        <div class="task-row-actions">
          <AppButton :disabled="loading || inserting" @click="emit('openTask', row.id)">{{ t('打开任务') }}</AppButton>
          <AppButton :disabled="!allowInsert || loading || inserting" @click="insert(row.id)">{{ t(insertingId === row.id ? '读取摘录…' : '插入任务摘录') }}</AppButton>
        </div>
      </li>
    </ul>
    <AppButton v-if="cursor && rows.length < 200" :disabled="loading || inserting" @click="load(true)">{{ t('加载更多任务') }}</AppButton>
    <small v-else-if="cursor">{{ t('当前显示前 200 条；请缩小搜索范围。') }}</small>
    <p class="task-search-scope">{{ t('摘录只包含最近 10 回合的用户与最终回复，最多 6,000 字符；插入后可在草稿中编辑。') }}</p>
  </AppDialog>
</template>

<script setup lang="ts">
import { t } from '../../composables/useUiLanguage'

import { onBeforeUnmount, ref, watch } from 'vue'
import AppDialog from '../common/AppDialog.vue'
import AppButton from '../common/AppButton.vue'
import AppSelect from '../common/AppSelect.vue'
import { getTaskExcerpt, listTaskPage, type TaskPage } from '../../api/tasks'
import { taskExcerptDraft } from '../../taskExcerpt'
import { taskStatusLabel } from '../../subtasks'
const props = defineProps<{ open: boolean; allowInsert: boolean }>()
const emit = defineEmits<{ close: []; openTask: [threadId: string]; insert: [text: string] }>()
const query = ref('')
const mode = ref<'title' | 'body'>('title')
const rows = ref<TaskPage['rows']>([])
const cursor = ref<string | null>(null)
const loading = ref(false)
const inserting = ref(false)
const insertingId = ref('')
const error = ref('')
let controller: AbortController | null = null
let excerptController: AbortController | null = null
let timer: ReturnType<typeof setTimeout> | null = null
function cancel() {
  controller?.abort()
  excerptController?.abort()
  controller = null
  excerptController = null
  loading.value = false
  inserting.value = false
  insertingId.value = ''
  if (timer) clearTimeout(timer)
  timer = null
}
function setMode(value: string) {
  if (value === 'title' || value === 'body') mode.value = value
}
async function load(more: boolean) {
  if (!props.open) return
  controller?.abort()
  const request = new AbortController()
  controller = request
  loading.value = true
  error.value = ''
  const requestedCursor = more ? cursor.value : null
  try {
    const result = await listTaskPage({ query: query.value, mode: mode.value, cursor: requestedCursor, signal: request.signal })
    if (controller !== request || request.signal.aborted) return
    if (requestedCursor && result.nextCursor === requestedCursor) throw new Error('任务分页未前进，请重新搜索。')
    rows.value = [...new Map([...(more ? rows.value : []), ...result.rows].map(row => [row.id, row])).values()].slice(0, 200)
    cursor.value = result.nextCursor
  } catch (cause) {
    if (!request.signal.aborted && controller === request) error.value = cause instanceof Error ? cause.message : '搜索失败。'
  } finally {
    if (controller === request) loading.value = false
  }
}
async function insert(threadId: string) {
  if (!props.allowInsert || inserting.value) return
  const request = new AbortController()
  excerptController = request
  inserting.value = true
  insertingId.value = threadId
  error.value = ''
  try {
    const excerpt = await getTaskExcerpt(threadId, request.signal)
    if (request.signal.aborted || excerptController !== request || !props.open || !props.allowInsert) return
    if (!excerpt.text) throw new Error('该任务尚无可引用的用户或最终回复。')
    emit('insert', taskExcerptDraft(excerpt))
  } catch (cause) {
    if (!request.signal.aborted) error.value = cause instanceof Error ? cause.message : '读取摘录失败。'
  } finally {
    if (excerptController === request) {
      inserting.value = false
      insertingId.value = ''
    }
  }
}
watch([() => props.open, query, mode], ([open]) => {
  cancel()
  rows.value = []
  cursor.value = null
  error.value = ''
  if (open) {
    timer = setTimeout(() => {
      timer = null
      void load(false)
    }, 250)
  }
})
onBeforeUnmount(cancel)
</script>
