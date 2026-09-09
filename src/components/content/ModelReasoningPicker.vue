<template>
  <button ref="anchor" class="model-reasoning-trigger" type="button" :disabled="disabled" aria-label="模型与推理强度" :aria-expanded="visible" @click="toggle">
    <span>{{ effortLabel }}</span><small>{{ modelLabel }}</small>
  </button>
  <AppPopover :open="visible" :anchor="anchor" :width="252" direction="up" align="end" panel-class="model-reasoning-popover" @close="close">
    <template v-if="!showModels">
      <div class="model-reasoning-heading">
        <button type="button" class="model-reasoning-summary" @click="showModels = true"><strong>{{ effortLabel }} ›</strong><small>{{ modelLabel }}</small></button>
        <button type="button" class="model-reasoning-reset" aria-label="恢复模型默认推理强度" @click="$emit('effort', '')">↺</button>
      </div>
      <input v-if="levels.length > 1" class="model-reasoning-range" type="range" min="0" :max="levels.length - 1" :value="levelIndex" :aria-valuetext="effortLabel" aria-label="推理强度" @input="chooseLevel" />
      <div class="model-reasoning-levels"><button v-for="level in levels" :key="level.value" type="button" :aria-pressed="effectiveEffort === level.value" @click="$emit('effort', level.value)">{{ level.label }}</button></div>
      <p v-if="!levels.length" class="model-reasoning-empty">模型尚未公布可选强度</p>
    </template>
    <template v-else>
      <button class="model-reasoning-back" type="button" @click="showModels = false">‹ 模型与推理强度</button>
      <input v-model="search" class="model-reasoning-search" placeholder="搜索模型" aria-label="搜索模型" />
      <div class="model-reasoning-models">
        <button v-for="model in filteredModels" :key="model.value" type="button" :aria-pressed="model.value === selectedModel" @click="selectModel(model.value)"><span>{{ model.label }}</span><span v-if="model.value === selectedModel">✓</span></button>
        <p v-if="!filteredModels.length" class="model-reasoning-empty">暂无可选模型</p>
      </div>
    </template>
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
const showModels = ref(false)
const search = ref('')
const modelLabel = computed(() => props.models.find(model => model.value === props.selectedModel)?.label || props.selectedModel || '选择模型')
const levels = computed(() => props.efforts.filter(effort => effort.value))
const effectiveEffort = computed(() => props.selectedEffort || props.defaultEffort || '')
const effortLabel = computed(() => levels.value.find(level => level.value === effectiveEffort.value)?.label || '模型默认')
const levelIndex = computed(() => Math.max(0, levels.value.findIndex(level => level.value === effectiveEffort.value)))
const filteredModels = computed(() => props.models.filter(model => model.label.toLowerCase().includes(search.value.toLowerCase())))
function open(): void {
  if (props.disabled) return
  visible.value = true
  showModels.value = true
  search.value = ''
  emit('open-change', true)
}
function close(): void {
  visible.value = false
  emit('open-change', false)
}
function toggle(): void {
  if (visible.value) close()
  else {
    open()
    showModels.value = false
  }
}
function selectModel(value: string): void {
  emit('model', value)
  showModels.value = false
}
function chooseLevel(event: Event): void {
  const level = levels.value[Number((event.target as HTMLInputElement).value)]
  if (level) emit('effort', level.value)
}
defineExpose({ open, close })
</script>
