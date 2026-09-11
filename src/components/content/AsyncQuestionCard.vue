<template>
  <section class="async-question-card" :data-question-item="message.id" :aria-label="t('问题')">
    <div class="async-question-heading">
      <strong>{{ t(answered || submitted ? '已回答' : '问题') }}</strong>
      <AppButton v-if="!answered && !submitted && collapsed" @click="collapsed = false">{{ t('回答') }}</AppButton>
    </div>
    <template v-if="!answered && !submitted && !collapsed">
      <div v-for="(question, index) in message.questions" :key="index" class="async-question-field">
        <label :for="`${inputId}-${index}`">{{ question.title }}</label>
        <AppSelect
          v-if="question.options.length"
          v-model="selected[index]"
          :options="question.options.map(option => ({ value: option, label: option }))"
          :disabled="busy"
        />
        <input :id="`${inputId}-${index}`" v-model="freeText[index]" class="app-input" :placeholder="t(question.options.length ? '自填答案' : '填写答案')" :disabled="busy" />
      </div>
      <p v-if="error" class="async-question-error" role="alert">{{ t(error) }}</p>
      <div class="async-question-actions">
        <AppButton :disabled="busy" @click="collapsed = true">{{ t('暂不回答') }}</AppButton>
        <AppButton :busy="busy" @click="submit">{{ t('发送回答') }}</AppButton>
      </div>
    </template>
    <p v-else class="async-question-summary">{{ message.questions?.map(question => question.title).join(' · ') }}</p>
  </section>
</template>

<script setup lang="ts">
import { t } from '../../composables/useUiLanguage'

import { ref, useId } from 'vue'
import type { UiMessage } from '../../types/codex'
import type { AsyncQuestionReply } from '../../userQuestions'
import AppButton from '../common/AppButton.vue'
import AppSelect from '../common/AppSelect.vue'

const props = defineProps<{
  message: UiMessage
  threadId: string
  answered: boolean
  answer: (reply: AsyncQuestionReply) => Promise<void>
}>()
const emit = defineEmits<{ submitted: [] }>()
const inputId = useId()
const selected = ref(props.message.questions?.map(question => question.options[0] ?? '') ?? [])
const freeText = ref<string[]>([])
const busy = ref(false)
const error = ref('')
const submitted = ref(false)
const collapsed = ref(false)

async function submit(): Promise<void> {
  if (busy.value || submitted.value || props.answered) return
  const answers = props.message.questions?.map((_, index) => freeText.value[index]?.trim() || selected.value[index] || '') ?? []
  if (!answers.length || answers.some(answer => !answer.trim())) {
    error.value = '请回答每个问题后再发送。'
    return
  }
  busy.value = true
  error.value = ''
  try {
    await props.answer({ threadId: props.threadId, itemId: props.message.id, turnId: props.message.turnId ?? '', questionOrdinal: props.message.questionOrdinal, answers })
    submitted.value = true
    emit('submitted')
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '回答发送失败，请重试。'
  } finally {
    busy.value = false
  }
}
</script>
