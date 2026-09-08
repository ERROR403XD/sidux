import { describe, expect, it } from 'vitest'
import { quotaColor, quotaRemaining } from './quotaPresentation'

describe('quota presentation', () => {
  it('changes color at each used-quota boundary, including exhaustion', () => {
    expect([0, 19, 20, 39, 40, 59, 60, 79, 80, 100].map(quotaColor)).toEqual([
      '#3b82f6', '#3b82f6', '#22c55e', '#22c55e', '#eab308', '#eab308', '#f97316', '#f97316', '#ef4444', '#ef4444',
    ])
    expect([-1, 0, 20, 50, 100, 101].map(quotaRemaining)).toEqual([100, 100, 80, 50, 0, 0])
  })
})
