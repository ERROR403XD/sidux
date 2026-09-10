<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="app-dialog-backdrop"
      ref="backdrop"
      data-app-dialog
      v-modal-backdrop="close"
      @keydown="onKeydown"
    >
      <section
        ref="panel"
        class="app-dialog"
        :class="[panelClass, { 'app-dialog-compact': size === 'compact' }]"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        :aria-busy="busy || undefined"
        tabindex="-1"
      >
        <header class="app-dialog-header">
          <h2>{{ title }}</h2>
          <AppButton :disabled="busy" :aria-label="t('关闭窗口')" @click="close">×</AppButton>
        </header>
        <div ref="body" class="app-dialog-body"><slot /></div>
        <footer v-if="$slots.footer" class="app-dialog-footer"><slot name="footer" /></footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { t } from '../../composables/useUiLanguage'

import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { vModalBackdrop } from '../../composables/modalBackdrop'
import AppButton from './AppButton.vue'
import { setPopoverAnchor, removePopoverAnchor, nestedOverlayLayer } from '../../composables/overlayEvents'

const props = withDefaults(defineProps<{
  open: boolean
  title: string
  size?: 'default' | 'compact'
  busy?: boolean
  panelClass?: string
}>(), { size: 'default' })
const emit = defineEmits<{ close: [] }>()
const panel = ref<HTMLElement | null>(null)
const backdrop = ref<HTMLElement | null>(null)
const body = ref<HTMLElement | null>(null)
let previous: HTMLElement | null = null

function close(): void {
  if (!props.busy) emit('close')
}

function restoreFocus(): void {
  if (backdrop.value) removePopoverAnchor(backdrop.value)
  if (previous?.isConnected) previous.focus({ preventScroll: true })
  previous = null
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Tab') return
  const candidates = panel.value?.querySelectorAll<HTMLElement>(
    'button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
  ) ?? []
  const items = [...candidates].filter((element) => element.getClientRects().length > 0)
  const first = items[0]
  const last = items.at(-1)
  if (!first) {
    event.preventDefault()
    panel.value?.focus()
  } else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(() => props.open, async (open) => {
  if (!open) {
    restoreFocus()
    return
  }
  previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
  await nextTick()
  if (props.open) {
    if (backdrop.value && previous) setPopoverAnchor(backdrop.value, previous)
    if (backdrop.value) backdrop.value.style.zIndex = String(nestedOverlayLayer(previous, Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-layer-dialog')) || 16000))
    const target = panel.value?.querySelector<HTMLElement>('[data-autofocus]') ?? panel.value
    target?.focus({ preventScroll: true })
  }
}, { immediate: true })

onBeforeUnmount(restoreFocus)
defineExpose({
  scrollToTop(): void {
    if (body.value) body.value.scrollTop = 0
  },
})
</script>
