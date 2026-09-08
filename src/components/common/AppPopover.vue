<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="panel"
      class="app-popover"
      :class="panelClass"
      :style="position"
      data-app-popover
      tabindex="-1"
      @keydown="onKeydown"
    >
      <slot />
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch, type CSSProperties } from 'vue'
import { isOverlayEventInside, setPopoverAnchor, removePopoverAnchor, nestedOverlayLayer } from '../../composables/overlayEvents'
import { positionPopover } from './popoverPosition'

const props = withDefaults(defineProps<{
  open: boolean
  anchor: HTMLElement | null
  width?: number
  direction?: 'up' | 'down'
  align?: 'start' | 'end'
  panelClass?: string
}>(), {
  width: 224,
  direction: 'down',
  align: 'start',
})
const emit = defineEmits<{ close: [] }>()
const panel = ref<HTMLElement | null>(null)
const position = ref<CSSProperties>({ visibility: 'hidden' })
let frame = 0
let observer: ResizeObserver | undefined
let cleanup: (() => void) | undefined

function updatePosition(): void {
  frame = 0
  if (!props.open || !props.anchor || !panel.value) return
  setPopoverAnchor(panel.value, props.anchor)
  position.value = positionPopover({
    anchor: props.anchor.getBoundingClientRect(),
    height: panel.value.offsetHeight,
    width: props.width,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    direction: props.direction,
    align: props.align,
  })
  position.value.zIndex = nestedOverlayLayer(props.anchor, Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-layer-popover')) || 16010)
}

function schedulePosition(): void {
  if (!frame) frame = window.requestAnimationFrame(updatePosition)
}

function onOutsidePointer(event: PointerEvent): void {
  const target = event.target
  if (!(target instanceof Node)) return
  if (isOverlayEventInside(event, panel.value) || isOverlayEventInside(event, props.anchor)) return
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing || !['Escape', 'Tab'].includes(event.key)) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
  }
  emit('close')
  props.anchor?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })
}

function detach(): void {
  if (panel.value) removePopoverAnchor(panel.value)
  cleanup?.()
  cleanup = undefined
  observer?.disconnect()
  observer = undefined
  window.cancelAnimationFrame(frame)
  frame = 0
}

watch(() => props.open, async (open, _previous, onCleanup) => {
  let cancelled = false
  onCleanup(() => {
    cancelled = true
    detach()
  })
  detach()
  if (!open) return
  position.value = { visibility: 'hidden' }
  await nextTick()
  if (cancelled || !props.open || !panel.value) return
  updatePosition()
  // The initial hidden measurement must be painted before a field can receive focus.
  await nextTick()
  if (cancelled || !props.open || !panel.value) return
  panel.value.querySelector<HTMLElement>('[data-popover-autofocus]')?.focus({ preventScroll: true })
  if (!panel.value.contains(document.activeElement)) panel.value.focus({ preventScroll: true })
  window.addEventListener('pointerdown', onOutsidePointer)
  window.addEventListener('resize', schedulePosition)
  window.addEventListener('scroll', schedulePosition, true)
  observer = new ResizeObserver(schedulePosition)
  observer.observe(panel.value)
  if (props.anchor) observer.observe(props.anchor)
  cleanup = () => {
    window.removeEventListener('pointerdown', onOutsidePointer)
    window.removeEventListener('resize', schedulePosition)
    window.removeEventListener('scroll', schedulePosition, true)
  }
}, { immediate: true })

watch(() => [props.width, props.direction, props.align, props.anchor], () => {
  if (props.open) schedulePosition()
})
onBeforeUnmount(detach)
</script>
