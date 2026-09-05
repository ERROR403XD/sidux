import { describe, expect, it } from 'vitest'
import { createBackdropGesture } from './modalBackdrop'

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
