<template>
  <AppSelect ref="select" v-bind="{ ...$attrs, ...props }" />
</template>

<script setup lang="ts">
import { ref } from 'vue'
import AppSelect from '../common/AppSelect.vue'
import type { AppSelectProps } from '../common/selectTypes'

// Compatibility boundary for existing composer props, events and imperative refs.
// New single-choice controls should import AppSelect directly.
defineOptions({ inheritAttrs: false })
const props = defineProps<AppSelectProps>()
const select = ref<InstanceType<typeof AppSelect> | null>(null)
defineExpose({
  open: () => select.value?.open(),
  close: () => select.value?.close(),
})
</script>
