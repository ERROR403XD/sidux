<template>
  <Teleport to="body">
    <div v-if="open" class="app-dialog-backdrop" v-modal-backdrop="close" @keydown="onKeydown">
      <section ref="panel" class="app-dialog" :class="panelClass" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1">
        <header class="app-dialog-header"><h2>{{ title }}</h2><button type="button" aria-label="关闭窗口" @click="close">×</button></header>
        <div ref="body" class="app-dialog-body"><slot /></div>
        <footer v-if="$slots.footer" class="app-dialog-footer"><slot name="footer" /></footer>
      </section>
    </div>
  </Teleport>
</template>
<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
const props = defineProps<{ open: boolean; title: string; panelClass?: string }>()
const emit = defineEmits<{ close: [] }>()
const panel = ref<HTMLElement | null>(null)
const body = ref<HTMLElement | null>(null)
defineExpose({ scrollToTop: () => { if (body.value) body.value.scrollTop = 0 } })
let previous: HTMLElement | null = null
const focusable = () => [...(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),[tabindex="0"]') ?? [])].filter(el => el.getClientRects().length)
function close() { emit('close') }
function restore() { if (previous?.isConnected) previous.focus({ preventScroll: true }); previous = null }
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); close() }
  if (event.key !== 'Tab') return
  const items = focusable(), first = items[0], last = items.at(-1)
  if (!first) { event.preventDefault(); panel.value?.focus(); return }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
watch(() => props.open, async open => {
  if (!open) { restore(); return }
  previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
  await nextTick()
  if (props.open) (panel.value?.querySelector<HTMLElement>('[data-autofocus]') ?? panel.value)?.focus({ preventScroll: true })
}, { immediate: true })
onBeforeUnmount(restore)
</script>
