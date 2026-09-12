import { expect, it } from 'vitest'
import { nextLayoutViewportHeight } from './virtualKeyboardViewport'

it('tracks a desktop window shrinking even while the composer is focused', () => {
  expect(nextLayoutViewportHeight({ width: 1440, height: 1000 }, { width: 1100, height: 620, coarsePointer: false, editing: true })).toBe(620)
  expect(nextLayoutViewportHeight({ width: 375, height: 1000 }, { width: 375, height: 620, coarsePointer: false, editing: true })).toBe(620)
})
it('retains a touch keyboard baseline but resets it on rotation and outside text entry', () => {
  expect(nextLayoutViewportHeight({ width: 375, height: 812 }, { width: 375, height: 450, coarsePointer: true, editing: true })).toBe(812)
  expect(nextLayoutViewportHeight({ width: 375, height: 812 }, { width: 812, height: 375, coarsePointer: true, editing: true })).toBe(375)
  expect(nextLayoutViewportHeight({ width: 375, height: 812 }, { width: 375, height: 620, coarsePointer: true, editing: false })).toBe(620)
})
