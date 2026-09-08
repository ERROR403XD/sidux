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
    expect(() => assertQuotaAvailable(weekly, 1, false)).toThrow('周限额')
  })
})
