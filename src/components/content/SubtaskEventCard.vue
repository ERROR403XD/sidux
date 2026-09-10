<template>
  <details class="subtask-event">
    <summary>
      <span>{{ t(taskActionLabel(event.action)) }}</span>
      <small v-if="event.status">{{ t('调用') }}{{ t(callStatus) }}</small>
      <span v-for="target in event.targets.slice(0, 3)" :key="target.id" class="subtask-event-preview">{{ target.path || shortTaskId(target.id) }} · {{ t(taskStatusLabel(target.status)) }}</span>
    </summary>
    <p v-if="event.prompt" class="subtask-text">{{ event.prompt }}</p>
    <ul class="task-result-list">
      <li v-for="target in event.targets" :key="target.id">
        <div class="task-result-heading">
          <a :href="`#/thread/${target.id}`" :title="target.id" @click.prevent="emit('openTask', target.id)">{{ target.path || target.id }}</a>
          <small>{{ t(taskStatusLabel(target.status)) }}</small>
        </div>
        <p v-if="target.summary" class="subtask-text">{{ target.summary }}</p>
      </li>
    </ul>
    <small v-if="event.targetCount > event.targets.length">{{ t('显示') }} {{ event.targets.length }} / {{ event.targetCount }} {{ t('个任务') }}</small>
  </details>
</template>

<script setup lang="ts">
import { t } from '../../composables/useUiLanguage'

import { computed } from 'vue'
import { shortTaskId, taskActionLabel, taskStatusLabel, type SubtaskEvent } from '../../subtasks'
const props = defineProps<{ event: SubtaskEvent }>()
const emit = defineEmits<{ openTask: [threadId: string] }>()
const callStatus = computed(() => ({ inProgress: '进行中', completed: '完成', failed: '失败', interrupted: '中断' }[props.event.status] || '状态未知'))
</script>
