<template>
  <div v-if="message && !dismissed" class="dismissible-notice" role="alert">
    <span>{{ t(message) }}</span>
    <button type="button" class="dismissible-notice-close" :aria-label="t('关闭提示')" @click="dismissed = true">×</button>
  </div>
</template>
<script setup lang="ts">
import { ref, watch } from 'vue'
import { t } from '../../composables/useUiLanguage'
const props = defineProps<{ message: string }>()
const dismissed = ref(false)
watch(() => props.message, () => { dismissed.value = false }, { flush: 'sync' })
</script>
