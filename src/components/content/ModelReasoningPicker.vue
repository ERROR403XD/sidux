<template>
  <button ref="anchor" class="model-reasoning-trigger" type="button" :disabled="disabled" :title="`${modelLabel} · ${t(effortLabel)}`" :aria-label="t('模型与推理强度')" :aria-expanded="visible" @click="toggle">
    <span>{{ shortModelLabel }}</span><small>{{ t(shortEffortLabel) }}</small>
  </button>
  <AppPopover :open="visible" :anchor="anchor" :width="320" direction="up" align="end" panel-class="model-reasoning-popover" @close="close">
    <header class="model-reasoning-heading"><strong>{{ t('模型') }}</strong><span>{{ shortModelLabel }}</span></header>
    <input v-model="search" class="app-input model-reasoning-search" data-popover-autofocus :placeholder="t('搜索模型')" :aria-label="t('搜索模型')" />
    <div class="model-reasoning-models" role="group" :aria-label="t('可用模型')">
      <button v-for="model in filteredModels" :key="model.value" type="button" :aria-pressed="model.value === selectedModel" @click="selectModel(model.value)"><span>{{ model.label }}</span><span v-if="model.value === selectedModel">✓</span></button>
      <p v-if="!filteredModels.length" class="model-reasoning-empty">{{ t('暂无可选模型') }}</p>
    </div>
    <div class="model-reasoning-effort">
      <header class="model-reasoning-heading">
        <strong>{{ t('推理强度') }}</strong>
        <output class="model-reasoning-current" aria-live="polite">{{ t(effortLabel) }}</output>
      </header>
      <div v-if="levels.length" class="model-reasoning-slider" :style="{ '--effort-progress': `${progress}%` }">
        <div class="model-reasoning-slider-track" aria-hidden="true">
          <span class="model-reasoning-slider-fill" />
          <span v-for="(level, index) in levels" :key="level.value" class="model-reasoning-slider-dot" :class="{ 'is-filled': index <= selectedIndex }" :style="{ left: `${levels.length > 1 ? index / (levels.length - 1) * 100 : 0}%` }" />
        </div>
        <input
          class="model-reasoning-range"
          type="range"
          :aria-label="t('推理强度')"
          :aria-valuetext="t(effortLabel)"
          :min="0"
          :max="Math.max(1, levels.length - 1)"
          :step="1"
          :value="selectedIndex"
          :disabled="disabled || levels.length === 1"
          @input="selectEffort"
        />
      </div>
      <p v-if="!levels.length" class="model-reasoning-empty">{{ t('此模型使用默认推理设置') }}</p>
    </div>
  </AppPopover>
</template>
<script setup lang="ts">
import { t } from '../../composables/useUiLanguage'

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
const modelLabel = computed(() => props.models.find(model => model.value === props.selectedModel)?.label || props.selectedModel || t('选择模型'))
const levels = computed(() => {
  const supported = props.efforts.filter(effort => effort.value)
  if (supported.length && !supported.some(level => level.value === props.defaultEffort)) {
    return [{ value: '', label: '模型默认' }, ...supported]
  }
  return supported
})
const effectiveEffort = computed(() => props.selectedEffort || props.defaultEffort || '')
const selectedIndex = computed(() => Math.max(0, levels.value.findIndex(level => level.value === effectiveEffort.value)))
const effortNames: Record<string, string> = { none: '无', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大', ultra: '超高' }
const effortLabel = computed(() => {
  const level = levels.value[selectedIndex.value]
  return level ? effortNames[level.value] || level.label : '模型默认'
})
const progress = computed(() => levels.value.length > 1 ? selectedIndex.value / (levels.value.length - 1) * 100 : 0)
function selectEffort(event: Event): void {
  const index = Number((event.target as HTMLInputElement).value)
  const level = levels.value[index]
  if (level && !props.disabled) emit('effort', level.value)
}
const shortModelLabel = computed(() => {
  const label = modelLabel.value
  const family = label.match(/\b(astra|sol|terra|luna)\b/i)?.[1]
  return family ? family[0].toUpperCase() + family.slice(1).toLowerCase() : label.replace(/^gpt-/i, 'GPT ')
})
const shortEffortLabel = computed(() => effortNames[effectiveEffort.value] || (effectiveEffort.value ? effortLabel.value : '默认'))
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
