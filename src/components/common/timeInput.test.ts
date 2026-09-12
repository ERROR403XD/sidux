import { describe, expect, it } from 'vitest'
import { normalizeTimeInput, isValidTimeInput } from './timeInput'
describe('single-field time input', () => {
  it.each([['08:30','08:30'],['08：30','08:30'],['８：５','08:05'],[' 8 : 5 ','08:05'],['23:59','23:59']])('normalizes %s to %s', (input, expected) => {
    expect(normalizeTimeInput(input)).toBe(expected)
    expect(isValidTimeInput(expected)).toBe(true)
  })
  it.each(['24:00','12:60','08:300','abc','','0830','8::30'])('does not silently clamp invalid time %s', input => {
    expect(isValidTimeInput(normalizeTimeInput(input))).toBe(false)
  })
})
