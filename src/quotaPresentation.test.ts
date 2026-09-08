import { afterEach, describe, expect, it } from 'vitest'
import { quotaColor, quotaRemaining, quotaResetTime } from './quotaPresentation'

import { setDisplayTimeZone } from './dateTime'

afterEach(() => setDisplayTimeZone('system'))

describe('quota presentation', () => {
  it('changes color at each used-quota boundary, including exhaustion', () => {
    expect([0, 19, 20, 39, 40, 59, 60, 79, 80, 100].map(quotaColor)).toEqual([
      '#3b82f6', '#3b82f6', '#22c55e', '#22c55e', '#eab308', '#eab308', '#f97316', '#f97316', '#ef4444', '#ef4444',
    ])
    expect([-1, 0, 20, 50, 100, 101].map(quotaRemaining)).toEqual([100, 100, 80, 50, 0, 0])
  })
})

it('shows weekday for weekly limits and calendar-relative days for 5-hour limits', () => {
  setDisplayTimeZone('Asia/Shanghai')
  const now = Date.parse('2026-09-08T15:00:00Z')
  expect(quotaResetTime(Date.parse('2026-09-08T15:30:00Z') / 1000, 300, now)).toBe('今天 23:30')
  expect(quotaResetTime(Date.parse('2026-09-08T17:00:00Z') / 1000, 300, now)).toBe('明天 01:00')
  expect(quotaResetTime(Date.parse('2026-09-13T17:00:00Z') / 1000, 10080, now)).toBe('周一 01:00')
  setDisplayTimeZone('UTC')
  expect(quotaResetTime(Date.parse('2026-09-08T17:00:00Z') / 1000, 300, now)).toBe('今天 17:00')
})

it('uses calendar tomorrow across a daylight-saving transition', () => {
  setDisplayTimeZone('America/New_York')
  expect(quotaResetTime(Date.parse('2026-03-09T04:30:00Z') / 1000, 300, Date.parse('2026-03-08T05:30:00Z'))).toBe('明天 00:30')
})
