<template>
  <button
    class="app-button"
    :class="{ 'is-danger': variant === 'danger' }"
    :type="type"
    :disabled="disabled || busy"
    :aria-busy="busy || undefined"
  >
    <slot />
  </button>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  variant?: 'default' | 'danger'
  type?: 'button' | 'submit' | 'reset'
  disabled?: boolean
  busy?: boolean
}>(), {
  variant: 'default',
  type: 'button',
})
</script>
