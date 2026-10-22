import { describe, expect, it } from 'vitest'
import type { StoredAccountEntry } from '../accountAuthStore.js'
import type { ProxyKey } from './store.js'
import { cachedAccountUsage, percentAccountUsage } from './usageResponse.js'

const now = Date.parse('2026-10-15T04:00:00Z')
const key = { accountStorageId: 'a' } as ProxyKey
function account(): StoredAccountEntry {
  return { storageId: 'a', quotaStatus: 'ready', quotaUpdatedAtIso: new Date(now).toISOString(), quotaSnapshot: {
    primary: { usedPercent: 12.5, windowMinutes: 300, resetsAt: now / 1000 + 3600 },
    secondary: { usedPercent: 75, windowMinutes: 10080, resetsAt: now / 1000 + 604800 },
  } } as StoredAccountEntry
}
describe('cached Sub2API-shaped account quota', () => {
  it('exposes actual cached periods as normalized percentages, without inventing USD or total remaining', () => {
    expect(cachedAccountUsage(key, account(), now)).toEqual({ unit: 'percent', updated_at: '2026-10-15T04:00:00.000Z', stale: false,
      rate_limits: [
        { window: '5h', limit: 100, used: 12.5, remaining: 87.5, reset_at: '2026-10-15T05:00:00.000Z' },
        { window: '7d', limit: 100, used: 75, remaining: 25, reset_at: '2026-10-22T04:00:00.000Z' },
      ] })
  })
  it('supports an actual 1d window and an unstarted window, with no synthesized 5h or 7d', () => {
    const row = account()
    row.quotaSnapshot!.primary = { usedPercent: 0, windowMinutes: 1440, resetsAt: null }
    row.quotaSnapshot!.secondary = null
    expect(cachedAccountUsage(key, row, now).rate_limits).toEqual([{ window: '1d', limit: 100, used: 0, remaining: 100 }])
  })
  it('returns cached successful data while refresh is loading or failing, and labels its age', () => {
    const row = account()
    row.quotaStatus = 'error'
    row.quotaUpdatedAtIso = new Date(now - 600_000).toISOString()
    const result = cachedAccountUsage(key, row, now)
    expect(result.stale).toBe(true)
    expect(result.rate_limits).toHaveLength(2)
    expect(result.updated_at).toBe('2026-10-15T03:50:00.000Z')
    row.quotaStatus = 'loading'
    expect(cachedAccountUsage(key, row, now).rate_limits).toHaveLength(2)
  })
  it('omits invalid, expired, unknown and incomplete active windows', () => {
    for (const window of [
      { usedPercent: 1, windowMinutes: 60, resetsAt: now / 1000 + 60 },
      { usedPercent: 1, windowMinutes: 300, resetsAt: now / 1000 },
      { usedPercent: 1, windowMinutes: 300, resetsAt: null },
      { usedPercent: -1, windowMinutes: 300, resetsAt: now / 1000 + 60 },
      { usedPercent: NaN, windowMinutes: 300, resetsAt: now / 1000 + 60 },
      { usedPercent: 101, windowMinutes: 300, resetsAt: now / 1000 + 60 },
      { usedPercent: 1, windowMinutes: 300, resetsAt: Number.MAX_SAFE_INTEGER },
      { usedPercent: 1, windowMinutes: 300, resetsAt: 1_000_000_000_000 },
    ]) {
      const row = account()
      row.quotaSnapshot!.primary = window
      row.quotaSnapshot!.secondary = null
      expect(cachedAccountUsage(key, row, now).rate_limits).toEqual([])
    }
  })
  it('requires a matching explicit binding and a valid successful snapshot timestamp', () => {
    for (const policy of [undefined, {}, { accountStorageId: 'b' }, { ...key, aggregateRoute: { enabled: true, entries: [] } }]) {
      expect(cachedAccountUsage(policy as ProxyKey, account(), now)).toEqual({ rate_limits: [], unit: 'percent' })
    }
    for (const timestamp of [null, 'invalid', new Date(now + 1).toISOString()]) {
      const row = account()
      row.quotaUpdatedAtIso = timestamp
      expect(cachedAccountUsage(key, row, now).rate_limits).toEqual([])
    }
  })
  it('returns an exhausted window and deduplicates repeated period definitions', () => {
    const row = account()
    row.quotaSnapshot!.primary!.usedPercent = 100
    row.quotaSnapshot!.secondary!.windowMinutes = 300
    const result = cachedAccountUsage(key, row, now)
    expect(result.rate_limits).toHaveLength(1)
    expect(result.rate_limits[0]).toMatchObject({ window: '5h', limit: 100, used: 100, remaining: 0 })
    expect(result).not.toHaveProperty('remaining')
  })
  it('exposes stable percent fields without inventing a missing daily window or moving reset times', () => {
    const usage = cachedAccountUsage(key, account(), now)
    expect(percentAccountUsage(usage)).toEqual({ ...usage, periods: {
      five_hour: { used_percent: 12.5, remaining_percent: 87.5, reset_at: '2026-10-15T05:00:00.000Z' },
      weekly: { used_percent: 75, remaining_percent: 25, reset_at: '2026-10-22T04:00:00.000Z' },
    } })
    expect(percentAccountUsage({ rate_limits: [], unit: 'percent' }).periods).toEqual({})
  })
  it('keeps unstarted periods free of invented reset times in the percent response', () => {
    expect(percentAccountUsage({ rate_limits: [{ window: '1d', limit: 100, used: 0, remaining: 100 }], unit: 'percent' }).periods)
      .toEqual({ daily: { used_percent: 0, remaining_percent: 100 } })
  })
})
