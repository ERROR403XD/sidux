<template>
  <div class="custom-connection-endpoints" role="list" :aria-label="t('支持端点')">
    <span
      v-for="endpoint in endpointOptions"
      :key="endpoint.value"
      class="custom-connection-endpoint"
      :class="{ 'is-supported': isNative(endpoint.value), 'is-bridged': isBridged(endpoint.value), 'is-manual': isManual(endpoint.value) }"
      role="listitem"
      :aria-label="`${endpoint.label}: ${t(ariaState(endpoint.value))}`"
      :title="showTooltips ? `${endpoint.value}: ${t(ariaState(endpoint.value))}` : undefined"
    >{{ endpoint.label }}</span>
  </div>
</template>

<script setup lang="ts">
import { t } from '../../composables/useUiLanguage'
import type { CustomEndpoint } from '../../customConnections'

// Endpoint lists arrive from saved connections (CustomEndpoint[]) and from
// gateway status JSON (string[]) — the component accepts both shapes. Props
// stay untyped as CustomEndpoint[] on the caller side; the component only reads
// membership, so string[] covers both shapes and keeps showTooltips for the
// compact API-key rows.

const props = withDefaults(defineProps<{ endpoints: string[]; bridged?: string[]; manual?: string[]; showTooltips?: boolean }>(), { showTooltips: true })
const endpointOptions: { value: CustomEndpoint; label: string }[] = [
  { value: '/v1/models', label: 'models' },
  { value: '/v1/responses', label: 'responses' },
  { value: '/v1/chat/completions', label: 'chat' },
]
function isNative(endpoint: CustomEndpoint): boolean {
  return props.endpoints.includes(endpoint) && !(props.bridged ?? []).includes(endpoint) && !(props.manual ?? []).includes(endpoint)
}
function isBridged(endpoint: CustomEndpoint): boolean {
  return (props.bridged ?? []).includes(endpoint)
}
function isManual(endpoint: CustomEndpoint): boolean {
  return (props.manual ?? []).includes(endpoint) && !isNative(endpoint) && !isBridged(endpoint)
}
function ariaState(endpoint: CustomEndpoint): string {
  return isBridged(endpoint) ? '经协议转换' : isManual(endpoint) ? '手动维护' : isNative(endpoint) ? '支持' : '不支持'
}
</script>
