<template>
  <details class="subtask-event">
    <summary>
      <span>{{ taskActionLabel(event.action) }}</span>
      <small v-if="event.status">调用{{ callStatus }}</small>
      <span v-for="target in event.targets.slice(0, 3)" :key="target.id" class="subtask-event-preview">{{ target.path || shortTaskId(target.id) }} · {{ taskStatusLabel(target.status) }}</span>
    </summary>
    <p v-if="event.prompt" class="subtask-text">{{ event.prompt }}</p>
    <ul class="task-result-list">
      <li v-for="target in event.targets" :key="target.id">
        <div class="task-result-heading">
          <a :href="`#/thread/${target.id}`" :title="target.id" @click.prevent="emit('openTask', target.id)">{{ target.path || target.id }}</a>
          <small>{{ taskStatusLabel(target.status) }}</small>
        </div>
        <p v-if="target.summary" class="subtask-text">{{ target.summary }}</p>
      </li>
    </ul>
    <small v-if="event.targetCount > event.targets.length">显示 {{ event.targets.length }} / {{ event.targetCount }} 个任务</small>
  </details>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { shortTaskId, taskActionLabel, taskStatusLabel, type SubtaskEvent } from '../../subtasks'
const props = defineProps<{ event: SubtaskEvent }>()
const emit = defineEmits<{ openTask: [threadId: string] }>()
const callStatus = computed(() => ({ inProgress: '进行中', completed: '完成', failed: '失败', interrupted: '中断' }[props.event.status] || '状态未知'))
</script>
