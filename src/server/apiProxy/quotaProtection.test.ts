import { describe, expect, it } from 'vitest'
import { assertQuotaAvailable } from './quotaProtection'
import type { StoredAccountEntry } from '../accountAuthStore'
const account = (weekly: number, five = 10) => ({ quotaStatus: 'ready', quotaSnapshot: { primary: { windowMinutes: 300, usedPercent: 100 - five }, secondary: { windowMinutes: 10080, usedPercent: 100 - weekly } } }) as StoredAccountEntry

describe('account-owned quota reserve', () => {
  it('blocks equality at either threshold and allows all privileged keys to share reserve', () => {
    expect(() => assertQuotaAvailable(account(1), 1, false)).toThrow('已保留')
    expect(() => assertQuotaAvailable(account(10, 2), 1, false)).toThrow('已保留')
    expect(() => assertQuotaAvailable(account(1.1, 2.1), 1, false)).not.toThrow()
    expect(() => assertQuotaAvailable(account(0, 0), 1, true)).not.toThrow()
    expect(() => assertQuotaAvailable(account(0, 0), 0, false)).not.toThrow()
  })
  it('blocks unknown quota and supports accounts without a 5-hour window', () => {
    expect(() => assertQuotaAvailable({ quotaStatus: 'error' } as StoredAccountEntry, 1, false)).toThrow('不可确认')
    const weekly = account(2); weekly.quotaSnapshot!.primary = null
    expect(() => assertQuotaAvailable(weekly, 1, false)).not.toThrow()
    weekly.quotaSnapshot!.secondary = null
    expect(() => assertQuotaAvailable(weekly, 1, false)).toThrow('长期限额')
  })
})

it('reserves the thirty-day quota for free accounts', () => {
  const account = { quotaStatus: 'ready', quotaSnapshot: { primary: { usedPercent: 95, windowMinutes: 43200 }, secondary: null } } as any
  expect(() => assertQuotaAvailable(account, 5, false)).toThrow('已保留')
  expect(() => assertQuotaAvailable(account, 4, false)).not.toThrow()
  expect(() => assertQuotaAvailable(account, 5, true)).not.toThrow()
})

// Plan names and primary/secondary position never imply a five-hour window.
it.each(['free', 'pro'])('only applies the main reserve to %s without a 300-minute window', planType => {
  for (const windowMinutes of [10080, 43200]) {
    for (const side of ['primary', 'secondary'] as const) {
      const candidate = account(15)
      candidate.planType = planType
      candidate.quotaSnapshot!.primary = null
      candidate.quotaSnapshot!.secondary = null
      candidate.quotaSnapshot![side] = { usedPercent: 85, windowMinutes, resetsAt: null }
      // 15% is above the 10% main reserve but below the 20% five-hour reserve.
      expect(() => assertQuotaAvailable(candidate, 10, false)).not.toThrow()
      candidate.quotaSnapshot![side]!.usedPercent = 90
      expect(() => assertQuotaAvailable(candidate, 10, false)).toThrow('已保留')
      expect(() => assertQuotaAvailable(candidate, 10, true)).not.toThrow()
    }
  }
})

it('recognizes a real 5-hour window in either position and ignores other short windows', () => {
  const candidate = account(50, 19)
  const snapshot = candidate.quotaSnapshot!
  ;[snapshot.primary, snapshot.secondary] = [snapshot.secondary, snapshot.primary]
  expect(() => assertQuotaAvailable(candidate, 10, false)).toThrow('已保留')
  snapshot.secondary!.windowMinutes = 1440
  expect(() => assertQuotaAvailable(candidate, 10, false)).not.toThrow()
})

it.each([0.1, 0.2, 0.4, 1.2])('includes decimal equality at a %s percent reserve without rounding nearby quota', percent => {
  expect(() => assertQuotaAvailable(account(percent, 100), percent, false)).toThrow('已保留')
  expect(() => assertQuotaAvailable(account(100, percent * 2), percent, false)).toThrow('已保留')
  expect(() => assertQuotaAvailable(account(percent + 0.001, percent * 2 + 0.001), percent, false)).not.toThrow()
})
