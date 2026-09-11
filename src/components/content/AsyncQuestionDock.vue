<template>
  <div v-if="pendingQuestions.length" class="async-question-dock" :aria-label="t('问题')">
    <AsyncQuestionCard
      v-for="message in pendingQuestions"
      :key="keyFor(message)"
      :message="message"
      :thread-id="threadId"
      :answered="false"
      :answer="answer"
      @submitted="dismissSubmitted(message)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { t } from '../../composables/useUiLanguage'
import type { UiMessage } from '../../types/codex'
import { questionRefKey, type AsyncQuestionReply } from '../../userQuestions'
import AsyncQuestionCard from './AsyncQuestionCard.vue'

const props = defineProps<{
  messages: UiMessage[]
  threadId: string
  answer: (reply: AsyncQuestionReply) => Promise<void>
}>()
const submitted = ref(new Set<string>())
function keyFor(message: UiMessage): string {
  return questionRefKey({ itemId: message.id, turnId: message.turnId ?? '', questionOrdinal: message.questionOrdinal })
}
const pendingQuestions = computed(() => {
  const answered = new Set(props.messages.flatMap(message => message.questionReply ? [questionRefKey(message.questionReply)] : []))
  return props.messages.filter(message => message.questions?.length && !answered.has(keyFor(message)) && !submitted.value.has(keyFor(message)))
})
function dismissSubmitted(message: UiMessage): void {
  submitted.value = new Set([...submitted.value, keyFor(message)])
}
</script>

<style scoped>
.async-question-dock {
  width: 100%;
  max-width: min(var(--chat-column-max, 72rem), 100%);
  max-height: min(40dvh, 360px);
  margin-inline: auto;
  overflow-y: auto;
  flex-shrink: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.async-question-dock :deep(.async-question-card) {
  flex-shrink: 0;
}
</style>
