import { describe, expect, it } from 'vitest'
import { formatCompactTokenCount } from './formatCounts'

describe('formatCompactTokenCount', () => {
  it('uses one shared presentation across token contexts', () => {
    expect(formatCompactTokenCount(Number.POSITIVE_INFINITY)).toBe('0')
    expect(formatCompactTokenCount(Number.NaN)).toBe('0')
    expect(formatCompactTokenCount(-1)).toBe('0')
    expect(formatCompactTokenCount(999)).toBe('999')
    expect(formatCompactTokenCount(1000)).toBe('1K')
    expect(formatCompactTokenCount(999.9)).toBe('999')
    expect(formatCompactTokenCount(999499)).toBe('999K')
    expect(formatCompactTokenCount(999500)).toBe('1M')
    expect(formatCompactTokenCount(10_000_000)).toBe('10M')
  })
})
