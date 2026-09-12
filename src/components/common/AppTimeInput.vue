<template>
  <input class="app-input app-time-input" type="time" :value="modelValue" step="60" :aria-invalid="invalid || undefined" @input="clearError" @change="commit" @paste="pasteTime" />
</template>
<script setup lang="ts">
import { ref } from 'vue'
import { t } from '../../composables/useUiLanguage'
import { normalizeTimeInput, isValidTimeInput } from './timeInput'
defineProps<{ modelValue: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string]; change: [value: string] }>()
const invalid = ref(false)
function clearError(event: Event): void {
  invalid.value = false
  const input = event.target as HTMLInputElement
  input.setCustomValidity('')
}
function commit(event: Event): void {
  const input = event.target as HTMLInputElement
  const value = normalizeTimeInput(input.value)
  invalid.value = !isValidTimeInput(value)
  input.setCustomValidity(invalid.value ? t('时间格式应为 HH:mm') : '')
  emit('update:modelValue', value)
  emit('change', value)
}
function pasteTime(event: ClipboardEvent): void {
  const text = event.clipboardData?.getData('text/plain')
  if (!text) return
  event.preventDefault()
  const input = event.target as HTMLInputElement
  const value = normalizeTimeInput(text)
  if (!isValidTimeInput(value)) {
    invalid.value = true
    input.setCustomValidity(t('时间格式应为 HH:mm'))
    input.reportValidity()
    return
  }
  input.value = value
  input.setCustomValidity('')
  invalid.value = false
  emit('update:modelValue', value)
  emit('change', value)
}
</script>
