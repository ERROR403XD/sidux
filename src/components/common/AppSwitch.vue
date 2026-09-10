<template>
  <button class="app-switch" type="button" role="switch" :aria-checked="!!modelValue" :disabled="disabled" @click="toggle">
    <span class="app-switch-label"><slot /></span>
    <span class="app-switch-track" :class="{ 'is-on': modelValue }" aria-hidden="true" />
  </button>
</template>

<script setup lang="ts">
const props = defineProps<{ modelValue?: boolean; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; change: [value: boolean] }>()
function toggle(): void {
  const value = !props.modelValue
  emit('update:modelValue', value)
  emit('change', value)
}
</script>
