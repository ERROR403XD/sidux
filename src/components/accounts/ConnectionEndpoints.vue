<template>
  <div class="custom-connection-endpoints" role="list" :aria-label="t('支持端点')">
    <span
      v-for="endpoint in endpointOptions"
      :key="endpoint.value"
      class="custom-connection-endpoint"
      :class="{ 'is-supported': endpoints.includes(endpoint.value) }"
      role="listitem"
      :aria-label="`${endpoint.label}: ${t(endpoints.includes(endpoint.value) ? '支持' : '不支持')}`"
      :title="showTooltips ? `${endpoint.value}: ${t(endpoints.includes(endpoint.value) ? '支持' : '不支持')}` : undefined"
    >{{ endpoint.label }}</span>
  </div>
</template>

<script setup lang="ts">
import { t } from '../../composables/useUiLanguage'
import type { CustomEndpoint } from '../../customConnections'

withDefaults(defineProps<{ endpoints: CustomEndpoint[]; showTooltips?: boolean }>(), { showTooltips: true })
const endpointOptions: { value: CustomEndpoint; label: string }[] = [
  { value: '/v1/models', label: 'models' },
  { value: '/v1/responses', label: 'responses' },
  { value: '/v1/chat/completions', label: 'chat' },
]
</script>
