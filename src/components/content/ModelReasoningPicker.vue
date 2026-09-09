<template>
  <button ref="anchor" class="model-reasoning-trigger" type="button" :disabled="disabled" :title="`${modelLabel} · ${effortLabel}`" aria-label="模型与推理强度" :aria-expanded="visible" @click="toggle">
    <span>{{ shortModelLabel }}</span><small>{{ shortEffortLabel }}</small><span aria-hidden="true" class="model-reasoning-chevron">⌄</span>
  </button>
  <AppPopover :open="visible" :anchor="anchor" :width="320" direction="up" align="end" panel-class="model-reasoning-popover" @close="close">
    <header class="model-reasoning-heading"><strong>模型</strong><span>{{ shortModelLabel }}</span></header>
    <input v-model="search" class="model-reasoning-search" placeholder="搜索模型" aria-label="搜索模型" />
    <div class="model-reasoning-models" role="group" aria-label="可用模型">
      <button v-for="model in filteredModels" :key="model.value" type="button" :aria-pressed="model.value === selectedModel" @click="selectModel(model.value)"><span>{{ model.label }}</span><span v-if="model.value === selectedModel">✓</span></button>
      <p v-if="!filteredModels.length" class="model-reasoning-empty">暂无可选模型</p>
    </div>
    <div class="model-reasoning-effort">
      <header class="model-reasoning-heading"><strong>推理强度</strong><button type="button" class="model-reasoning-reset" aria-label="恢复模型默认推理强度" @click="$emit('effort', '')">默认</button></header>
      <div class="model-reasoning-levels" role="group" aria-label="推理强度"><button v-for="level in levels" :key="level.value" type="button" :aria-pressed="effectiveEffort === level.value" @click="$emit('effort', level.value)">{{ level.label }}</button></div>
      <p v-if="!levels.length" class="model-reasoning-empty">此模型使用默认推理设置</p>
    </div>
  </AppPopover>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue'
import AppPopover from '../common/AppPopover.vue'
const props = defineProps<{
  selectedModel: string
  selectedEffort: string
  defaultEffort?: string
  models: { value: string; label: string }[]
  efforts: { value: string; label: string }[]
  disabled?: boolean
}>()
const emit = defineEmits<{ model: [value: string]; effort: [value: string]; 'open-change': [value: boolean] }>()
const anchor = ref<HTMLElement | null>(null)
const visible = ref(false)
const search = ref('')
const modelLabel = computed(() => props.models.find(model => model.value === props.selectedModel)?.label || props.selectedModel || '选择模型')
const levels = computed(() => props.efforts.filter(effort => effort.value))
const effectiveEffort = computed(() => props.selectedEffort || props.defaultEffort || '')
const effortLabel = computed(() => levels.value.find(level => level.value === effectiveEffort.value)?.label || '模型默认')
const shortModelLabel = computed(() => {
  const label = modelLabel.value
  const family = label.match(/\b(astra|sol|terra|luna)\b/i)?.[1]
  return family ? family[0].toUpperCase() + family.slice(1).toLowerCase() : label.replace(/^gpt-/i, 'GPT ')
})
const shortEffortLabel = computed(() => ({ minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大', ultra: '超高' } as Record<string, string>)[effectiveEffort.value] || (effectiveEffort.value ? effortLabel.value : '默认'))
const filteredModels = computed(() => props.models.filter(model => model.label.toLowerCase().includes(search.value.toLowerCase())))
function open(): void {
  if (props.disabled) return
  visible.value = true
  search.value = ''
  emit('open-change', true)
}
function close(): void {
  visible.value = false
  emit('open-change', false)
}
function toggle(): void {
  if (visible.value) close()
  else open()
}
function selectModel(value: string): void {
  emit('model', value)
}
defineExpose({ open, close })
</script>
