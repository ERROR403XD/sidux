<template>
  <div class="conversation-defaults settings-form-subgrid">
    <div class="sidebar-settings-row sidebar-settings-row--select settings-field-roomy"><span>{{ t('默认模型') }}</span><AppSelect :model-value="value.model" :options="modelOptions" enable-search :search-placeholder="t('搜索模型')" @update:model-value="selectModel" /></div>
    <div class="sidebar-settings-row sidebar-settings-row--select settings-field-short"><span>{{ t('默认思考强度') }}</span><AppSelect :model-value="value.effort" :options="effortOptions(model, value.effort).map(option => ({ ...option, label: model?.providerId === 'custom' ? option.label : t(option.label) }))" :disabled="reasoningUnavailable(model)" @update:model-value="save({ effort: $event })" /></div>
    <AppSwitch class="settings-switch-row" :model-value="!!fastTier && !!value.tier" :disabled="model?.providerId === 'custom' ? !fastTier : !fastTier && !value.tier" @change="save({ tier: $event ? fastTier : '' })">{{ t('默认 Fast') }}</AppSwitch>
    <AppSwitch class="settings-switch-row" :model-value="remember" @change="emit('save', value, $event)">{{ t('记住每个会话上次设置') }}</AppSwitch>
    <p v-if="problem || error" :class="error ? 'sidebar-timezone-error' : 'conversation-defaults-note'" role="status">{{ t(error || problem) }}</p>
  </div>
</template>
<script setup lang="ts">
import { t } from '../../composables/useUiLanguage'

import { computed } from 'vue'
import AppSelect from '../common/AppSelect.vue'
import AppSwitch from '../common/AppSwitch.vue'
import { reasoningUnavailable, effortOptions, type ModelCapability } from '../../modelCapabilities'
import { effectiveConversationChoice, type ConversationChoice } from '../../webConversationPreferences'
const props = defineProps<{ value: ConversationChoice; remember: boolean; models: ModelCapability[]; provider: string; error: string }>()
const emit = defineEmits<{ save: [value: ConversationChoice, remember: boolean] }>()
const model = computed(() => props.models.find(row => row.id === props.value.model))
const modelOptions = computed(() => {
  const options = props.models.map(row => ({ value: row.id, label: row.displayName }))
  if (props.value.model && !options.some(row => row.value === props.value.model)) options.push({ value: props.value.model, label: t(`${props.value.model}（暂不可用）`) })
  return options
})
const fastTier = computed(() => model.value?.serviceTiers?.find(row => ['priority', 'fast'].includes(row.value))?.value || '')
const problem = computed(() => {
  const effective = effectiveConversationChoice(props.value, props.models)
  return effective.model !== props.value.model || effective.effort !== props.value.effort || effective.tier !== props.value.tier
    ? `当前账号使用：${effective.model} · ${effective.effort || '默认强度'}；已保存偏好不变。` : ''
})
function save(patch: Partial<ConversationChoice>): void { emit('save', { ...props.value, ...patch }, props.remember) }
function selectModel(id: string): void { save({ model: id, provider: props.provider, effort: '', tier: '' }) }
</script>
