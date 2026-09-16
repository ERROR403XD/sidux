<template>
  <div ref="rootRef" class="api-proxy-model-field">
    <input
      class="app-input"
      type="text"
      autocomplete="off"
      maxlength="200"
      :value="modelValue"
      :disabled="disabled"
      :placeholder="placeholder"
      :aria-label="ariaLabel || placeholder"
      role="combobox"
      :aria-expanded="menuOpen"
      @input="onInput"
      @focus="onFocus"
      @keydown.escape="close()"
      @keydown.arrow-down.prevent="onFocus()"
    />
    <AppPopover :open="menuOpen" :anchor="rootRef" :width="320" panel-class="api-proxy-model-menu" @close="close()">
      <ul class="api-proxy-model-options" role="listbox" :aria-label="ariaLabel || placeholder">
        <li v-for="name in suggestions" :key="name" role="presentation">
          <button class="api-proxy-model-option" type="button" role="option" :aria-selected="name === modelValue" @click="choose(name)">{{ name }}</button>
        </li>
      </ul>
      <p v-if="emptyMessage" class="api-proxy-model-empty">{{ t(emptyMessage) }}</p>
    </AppPopover>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppPopover from '../common/AppPopover.vue'
import { t } from '../../composables/useUiLanguage'
import { apiProxyModelMenuState, type ApiProxyModelCatalogState } from '../../api/apiProxyModels'

const props = withDefaults(defineProps<{
  modelValue: string
  /** 候选模型所属账号；变化时关闭旧菜单，避免候选与账号不一致。 */
  accountId?: string | null
  models?: string[]
  state?: ApiProxyModelCatalogState
  disabled?: boolean
  placeholder?: string
  ariaLabel?: string
}>(), { accountId: null, models: () => [], state: 'idle' })
const emit = defineEmits<{
  'update:modelValue': [value: string]
  /** 输入框需要候选模型时通知调用方按账号读取目录，避免打开弹窗就批量请求。 */
  request: []
}>()
const rootRef = ref<HTMLElement | null>(null)
const open = ref(false)
const menu = computed(() => apiProxyModelMenuState(props.models, props.modelValue, props.state))
const suggestions = computed(() => menu.value.suggestions)
const emptyMessage = computed(() => menu.value.emptyMessage)
const menuOpen = computed(() => open.value && menu.value.visible)

function onFocus(): void {
  if (props.disabled) return
  emit('request')
  open.value = true
}

function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLInputElement).value)
  onFocus()
}

function choose(name: string): void {
  emit('update:modelValue', name)
  close()
}

function close(): void {
  open.value = false
}

watch(() => props.accountId, () => { close() })
watch(() => props.disabled, disabled => { if (disabled) close() })
</script>
