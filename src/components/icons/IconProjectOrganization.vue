<script setup lang="ts">
defineProps<{ expanded?: boolean }>()
</script>

<template>
  <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true" :data-organization-state="expanded ? 'expanded' : 'collapsed'" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <template v-if="expanded">
      <rect x="9" y="2" width="6" height="5" rx="1" />
      <path d="M12 7v5M5 16v-4h14v4" />
      <rect x="2" y="16" width="6" height="5" rx="1" />
      <rect x="16" y="16" width="6" height="5" rx="1" />
    </template>
    <template v-else>
      <rect x="7" y="3" width="10" height="7" rx="1.5" />
      <path d="M12 10v4M8 17l4-3 4 3-4 3z" />
    </template>
  </svg>
</template>
