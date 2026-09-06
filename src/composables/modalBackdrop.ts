import type { ObjectDirective } from 'vue'

type Sample = { pointerId: number; button: number; isPrimary: boolean; clientX: number; clientY: number }

// A click synthesized on a common ancestor is not necessarily a backdrop click.
export function createBackdropGesture() {
  let start: Sample | null = null
  return {
    isTracking() { return start !== null },
    cancel() { start = null },
    down(event: Sample, onBackdrop: boolean) {
      if (start || !event.isPrimary || event.button !== 0 || !onBackdrop) {
        start = null
        return
      }
      start = { ...event }
    },
    move(event: Sample) {
      if (start && (event.pointerId !== start.pointerId || Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) > 5)) start = null
    },
    up(event: Sample, onBackdrop: boolean) {
      const valid = start !== null && event.pointerId === start.pointerId && event.button === 0 && event.isPrimary && onBackdrop && Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) <= 5
      start = null
      return valid
    },
  }
}

type Modal = { el: HTMLElement; close: () => void; gesture: ReturnType<typeof createBackdropGesture>; clickReady: boolean }
const stack: Modal[] = []
const sample = (e: PointerEvent): Sample => ({ pointerId: e.pointerId, button: e.button, isPrimary: e.isPrimary, clientX: e.clientX, clientY: e.clientY })
function pointer(event: PointerEvent) {
  const modal = stack.at(-1)
  if (!modal) return
  if (event.type === 'pointerdown') {
    modal.clickReady = false
    modal.gesture.down(sample(event), event.target === modal.el)
  } else if (event.type === 'pointermove') modal.gesture.move(sample(event))
  else if (event.type === 'pointerup') {
    // Hit-test only a viable gesture's release (touch may implicitly capture
    // pointer events). Hover/move events must never force a layout read.
    const onBackdrop = modal.gesture.isTracking() && document.elementFromPoint(event.clientX, event.clientY) === modal.el
    modal.clickReady = modal.gesture.up(sample(event), onBackdrop)
  }
  else { modal.gesture.cancel(); modal.clickReady = false }
}
function click(event: MouseEvent) {
  const modal = stack.at(-1)
  if (!modal) return
  const ready = modal.clickReady
  modal.clickReady = false
  if (event.target !== modal.el) return
  event.stopImmediatePropagation()
  if (ready && event.button === 0) modal.close()
}
function keydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.isComposing) return
  if (event.target instanceof Element && event.target.closest('[data-app-popover]')) return
  const modal = stack.at(-1)
  if (!modal) return
  event.preventDefault()
  event.stopImmediatePropagation()
  modal.gesture.cancel()
  modal.close()
}
function cancel() { for (const modal of stack) { modal.gesture.cancel(); modal.clickReady = false } }
function listen(add: boolean) {
  const method = add ? 'addEventListener' : 'removeEventListener'
  for (const name of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const) document[method](name, pointer as EventListener, true)
  document[method]('click', click as EventListener, true)
  window[method]('keydown', keydown as EventListener, true)
  window[method]('blur', cancel)
}

export const vModalBackdrop: ObjectDirective<HTMLElement, () => void> = {
  mounted(el, binding) {
    cancel()
    if (!stack.length) listen(true)
    stack.push({ el, close: binding.value, gesture: createBackdropGesture(), clickReady: false })
  },
  updated(el, binding) { const modal = stack.find(item => item.el === el); if (modal) modal.close = binding.value },
  beforeUnmount(el) {
    const index = stack.findIndex(item => item.el === el)
    if (index >= 0) stack.splice(index, 1)
    cancel()
    if (!stack.length) listen(false)
  },
}
