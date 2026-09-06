import { describe, expect, it, vi } from 'vitest'
import { createBackdropGesture, vModalBackdrop } from './modalBackdrop'

const primary = { pointerId: 1, button: 0, isPrimary: true, clientX: 10, clientY: 10 }
describe('modal backdrop gestures', () => {
  it('accepts only a complete background click', () => {
    const g = createBackdropGesture()
    expect(g.up(primary, true)).toBe(false)
    g.down(primary, true)
    expect(g.up(primary, true)).toBe(true)
    expect(g.up(primary, true)).toBe(false)
  })
  it('rejects text selection, reverse drags and returning drags', () => {
    const g = createBackdropGesture()
    g.down(primary, false)
    expect(g.up(primary, true)).toBe(false)
    g.down(primary, true)
    expect(g.up(primary, false)).toBe(false)
    g.down(primary, true)
    g.move({ ...primary, clientX: 30 })
    expect(g.up(primary, true)).toBe(false)
  })
  it('rejects right clicks, cancellation and additional pointers', () => {
    const g = createBackdropGesture()
    g.down({ ...primary, button: 2 }, true)
    expect(g.up(primary, true)).toBe(false)
    g.down(primary, true); g.cancel()
    expect(g.up(primary, true)).toBe(false)
    g.down(primary, true)
    g.down({ ...primary, pointerId: 2, isPrimary: false }, true)
    expect(g.up(primary, true)).toBe(false)
  })
})

it('handles only the top modal, clears residual gestures and releases listeners', () => {
  const handlers = new Map<string, (event: unknown) => void>()
  const target = (prefix: string) => ({
    addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(prefix + name, handler),
    removeEventListener: (name: string) => handlers.delete(prefix + name),
  })
  const outer = {} as HTMLElement
  const inner = {} as HTMLElement
  let hit = outer
  class PopoverTarget { closest(selector: string) { return selector === '[data-app-popover]' ? this : null } }
  vi.stubGlobal('Element', PopoverTarget)
  vi.stubGlobal('document', { ...target('d:'), elementFromPoint: () => hit })
  vi.stubGlobal('window', target('w:'))
  const directive = vModalBackdrop as {
    mounted: (el: HTMLElement, binding: { value: () => void }) => void
    beforeUnmount: (el: HTMLElement) => void
  }
  const outerClose = vi.fn()
  const innerClose = vi.fn()
  let busy = true
  const fire = (name: string, event = {}) => handlers.get(name)?.({ ...primary, target: hit, type: name.slice(2), stopImmediatePropagation() {}, preventDefault() {}, ...event })
  try {
    directive.mounted(outer, { value: outerClose })
    fire('d:pointerdown')
    directive.mounted(inner, { value: () => { if (!busy) innerClose() } })
    hit = inner
    fire('d:pointerup'); fire('d:click')
    expect(innerClose).not.toHaveBeenCalled()
    fire('w:keydown', { key: 'Escape' })
    expect(innerClose).not.toHaveBeenCalled()
    busy = false
    fire('w:keydown', { key: 'Escape', target: new PopoverTarget() })
    expect(innerClose).not.toHaveBeenCalled()
    fire('w:keydown', { key: 'Escape' })
    expect(innerClose).toHaveBeenCalledTimes(1)
    expect(outerClose).not.toHaveBeenCalled()
    directive.beforeUnmount(inner)
    hit = outer
    fire('d:pointerup'); fire('d:click')
    expect(outerClose).not.toHaveBeenCalled()
    fire('d:pointerdown'); fire('d:pointerup'); fire('d:click')
    expect(outerClose).toHaveBeenCalledTimes(1)
  } finally {
    directive.beforeUnmount(inner)
    directive.beforeUnmount(outer)
    expect(handlers.size).toBe(0)
    vi.unstubAllGlobals()
  }
})
