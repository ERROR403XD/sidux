<template>
  <button class="directory-section-toggle" type="button" :aria-expanded="open" @click="emit('toggle')">
    <span class="directory-section-label">{{ title }}<span class="directory-section-count">{{ count }}</span></span>
    <IconTablerChevronRight class="directory-section-chevron" :class="{ 'is-open': open }" />
  </button>
</template>
<script setup lang="ts">
import IconTablerChevronRight from '../icons/IconTablerChevronRight.vue'
defineProps<{ title: string; count: number; open: boolean }>()
const emit = defineEmits<{ toggle: [] }>()
</script>
