<template>
  <div ref="rootRef" class="app-select composer-dropdown">
    <button
      class="composer-dropdown-trigger"
      type="button"
      :title="selectedLabel || placeholder"
      :aria-label="ariaLabel || selectedLabel || placeholder || 'Select option'"
      aria-haspopup="listbox"
      :aria-expanded="isOpen"
      :disabled="disabled"
      @click="toggle"
      @keydown.arrow-down.prevent="open"
      @keydown.arrow-up.prevent="open"
    >
      <component :is="selectedPrefixIcon" v-if="selectedPrefixIcon" class="composer-dropdown-prefix-icon" />
      <span v-if="!iconOnly" class="composer-dropdown-value">{{ selectedLabel }}</span>
      <IconTablerChevronDown class="composer-dropdown-chevron" />
    </button>
    <AppPopover
      :open="isOpen"
      :anchor="rootRef"
      :width="menuWidth"
      :direction="openDirection"
      :align="menuAlign"
      panel-class="composer-dropdown-menu-wrap"
      @close="close"
    >
      <div class="composer-dropdown-menu" tabindex="-1" :data-popover-autofocus="enableSearch ? undefined : ''" @keydown="onKeydown">
        <div v-if="enableSearch" class="composer-dropdown-search-wrap">
          <input
            v-model="searchQuery"
            class="app-input composer-dropdown-search-input"
            data-popover-autofocus
            type="text"
            :placeholder="searchPlaceholder"
            :aria-label="searchPlaceholder || 'Search options'"
          />
        </div>
        <ul ref="listRef" class="composer-dropdown-options" role="listbox" :aria-label="selectedLabel || placeholder || 'Options'">
          <li v-for="(option, index) in filteredOptions" :key="option.value" role="presentation">
            <button
              class="composer-dropdown-option"
              :class="{ 'is-selected': option.value === modelValue, 'is-highlighted': index === highlighted }"
              type="button"
              role="option"
              :aria-selected="option.value === modelValue"
              @click="select(option.value)"
            >
              {{ option.label }}
            </button>
          </li>
          <li v-if="!filteredOptions.length" class="composer-dropdown-empty" role="presentation">
            {{ emptyLabel || 'No results' }}
          </li>
        </ul>
      </div>
    </AppPopover>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import IconTablerChevronDown from '../icons/IconTablerChevronDown.vue'
import AppPopover from './AppPopover.vue'
import type { AppSelectProps } from './selectTypes'

const props = withDefaults(defineProps<AppSelectProps>(), { openDirection: 'down', menuAlign: 'start' })
const emit = defineEmits<{
  'update:modelValue': [value: string]
  'open-change': [open: boolean]
}>()
const rootRef = ref<HTMLElement | null>(null)
const listRef = ref<HTMLElement | null>(null)
const isOpen = ref(false)
const searchQuery = ref('')
const highlighted = ref(-1)
const menuWidth = ref(224)
const selectedLabel = computed(() => props.options.find((option) => option.value === props.modelValue)?.label ?? props.placeholder ?? '')
const filteredOptions = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  return query
    ? props.options.filter((option) => option.label.toLowerCase().includes(query) || option.value.toLowerCase().includes(query))
    : props.options
})

function open(): void {
  if (!props.disabled) {
    menuWidth.value = Math.max(props.enableSearch ? 320 : 224, rootRef.value?.getBoundingClientRect().width || 0)
    isOpen.value = true
  }
}

function close(): void {
  isOpen.value = false
  searchQuery.value = ''
  highlighted.value = -1
}

function toggle(): void {
  if (isOpen.value) close()
  else open()
}

function select(value: string): void {
  emit('update:modelValue', value)
  close()
  rootRef.value?.querySelector('button')?.focus({ preventScroll: true })
}

function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing) return
  if (event.key === 'Escape' && searchQuery.value) {
    event.preventDefault()
    event.stopPropagation()
    searchQuery.value = ''
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const count = filteredOptions.value.length
    if (!count) return
    const delta = event.key === 'ArrowDown' ? 1 : -1
    highlighted.value = highlighted.value < 0
      ? (delta > 0 ? 0 : count - 1)
      : (highlighted.value + delta + count) % count
    void nextTick(() => listRef.value?.querySelectorAll('button')[highlighted.value]?.scrollIntoView({ block: 'nearest' }))
  } else if (event.key === 'Enter' && highlighted.value >= 0) {
    event.preventDefault()
    const option = filteredOptions.value[highlighted.value]
    if (option) select(option.value)
  }
}

watch(searchQuery, () => { highlighted.value = -1 })
watch(() => props.disabled, (disabled) => { if (disabled) close() })
watch(isOpen, (open) => emit('open-change', open))
defineExpose({ open, close })
</script>

<style scoped>
@reference "tailwindcss";

.composer-dropdown {
  @apply relative inline-flex min-w-0;
}

.composer-dropdown-trigger {
  @apply inline-flex min-h-7 min-w-0 items-center gap-1 border-0 bg-transparent px-0 py-0.5 text-sm leading-tight text-zinc-500 outline-none transition;
}

.composer-dropdown-prefix-icon {
  @apply h-3.5 w-3.5 shrink-0 text-amber-500;
}

.composer-dropdown-trigger:disabled {
  @apply cursor-not-allowed text-zinc-500;
}

.composer-dropdown-value {
  @apply whitespace-nowrap text-left truncate pb-px;
}

.composer-dropdown-chevron {
  @apply mt-px h-3.5 w-3.5 shrink-0 text-zinc-500;
}

.composer-dropdown-search-wrap {
  @apply px-1 pb-1;
}

.composer-dropdown-search-input {
  @apply w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-800 outline-none transition focus:border-zinc-400;
}

.composer-dropdown-options {
  @apply m-0 max-h-56 list-none overflow-y-auto p-0;
}

.composer-dropdown-option {
  @apply flex w-full items-center rounded-lg border-0 bg-transparent px-2 py-1.5 text-left text-sm text-zinc-700 transition hover:bg-zinc-100;
}

.composer-dropdown-option.is-selected {
  @apply bg-zinc-100;
}

.composer-dropdown-empty {
  @apply px-2 py-1.5 text-xs text-zinc-500;
}
</style>
