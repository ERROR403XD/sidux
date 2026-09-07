<template>
  <div class="conversation-defaults">
    <h3>会话</h3>
    <div class="sidebar-settings-row sidebar-settings-row--select"><span>默认模型</span><AppSelect :model-value="value.model" :options="modelOptions" enable-search @update:model-value="selectModel" /></div>
    <div class="sidebar-settings-row sidebar-settings-row--select"><span>默认思考强度</span><AppSelect :model-value="value.effort" :options="effortOptions(model, value.effort)" @update:model-value="save({ effort: $event })" /></div>
    <button class="sidebar-settings-row" type="button" role="switch" :aria-checked="!!value.tier" :disabled="!fastTier && !value.tier" @click="save({ tier: value.tier ? '' : fastTier })"><span>默认 Fast</span><span class="sidebar-settings-toggle" :class="{ 'is-on': !!value.tier }" /></button>
    <button class="sidebar-settings-row" type="button" role="switch" :aria-checked="remember" @click="emit('save', value, !remember)"><span>记住每个会话上次设置</span><span class="sidebar-settings-toggle" :class="{ 'is-on': remember }" /></button>
    <p v-if="problem || error" class="sidebar-timezone-error" role="alert">{{ error || problem }}</p>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import AppSelect from '../common/AppSelect.vue'
import { effortOptions, modelSettingsProblem, type ModelCapability } from '../../modelCapabilities'
import type { ConversationChoice } from '../../webConversationPreferences'
const props = defineProps<{ value: ConversationChoice; remember: boolean; models: ModelCapability[]; provider: string; error: string }>()
const emit = defineEmits<{ save: [value: ConversationChoice, remember: boolean] }>()
const model = computed(() => props.models.find(row => row.id === props.value.model))
const modelOptions = computed(() => {
  const options = props.models.map(row => ({ value: row.id, label: row.displayName }))
  if (props.value.model && !options.some(row => row.value === props.value.model)) options.push({ value: props.value.model, label: `${props.value.model}（暂不可用）` })
  return options
})
const fastTier = computed(() => model.value?.serviceTiers?.find(row => ['priority', 'fast'].includes(row.value))?.value || '')
const problem = computed(() => !model.value ? '模型目录暂不可用，请稍后重试。' : modelSettingsProblem(model.value, props.value.effort, props.value.tier))
function save(patch: Partial<ConversationChoice>): void { emit('save', { ...props.value, ...patch }, props.remember) }
function selectModel(id: string): void { save({ model: id, provider: props.provider, effort: '', tier: '' }) }
</script>
