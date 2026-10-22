import { describe, expect, it } from 'vitest'
import type { StoredAccountEntry } from '../accountAuthStore.js'
import type { ProxyKey } from './store.js'
import { accountQuotaHeaders } from './quotaHeaders.js'

const now = 1_800_000_000_000
const key = { accountStorageId: 'bound' } as ProxyKey
function account(overrides: Partial<StoredAccountEntry> = {}): StoredAccountEntry {
  return { storageId: 'bound', quotaStatus: 'ready', quotaUpdatedAtIso: new Date(now).toISOString(),
    quotaSnapshot: { primary: { usedPercent: 0, windowMinutes: 300, resetsAt: now / 1000 + 60 },
      secondary: { usedPercent: 100, windowMinutes: 10080, resetsAt: now / 1000 + 3600 } }, ...overrides } as StoredAccountEntry
}

describe('bound OpenAI account quota headers', () => {
  it('encodes zero and exhausted windows with Codex Unix-second reset headers', () => {
    expect(accountQuotaHeaders(key, account(), now)).toEqual({
      'x-codex-primary-used-percent': '0', 'x-codex-primary-window-minutes': '300', 'x-codex-primary-reset-at': '1800000060',
      'x-codex-secondary-used-percent': '100', 'x-codex-secondary-window-minutes': '10080', 'x-codex-secondary-reset-at': '1800003600',
    })
  })
  it('requires the exact key binding and excludes aggregate routes even with forced routing', () => {
    for (const policy of [undefined, {}, { accountStorageId: 'other' }, { ...key, aggregateRoute: { enabled: true, entries: [] }, forceRoute: { enabled: true, model: 'm' } }]) {
      expect(accountQuotaHeaders(policy as ProxyKey, account(), now)).toEqual({})
    }
    expect(accountQuotaHeaders(key, undefined, now)).toEqual({})
    expect(accountQuotaHeaders({ ...key, forceRoute: { enabled: true, model: 'm' } }, account(), now)).not.toEqual({})
  })
  it.each<Partial<StoredAccountEntry>>([
    { quotaStatus: 'error' }, { quotaStatus: 'loading' }, { quotaSnapshot: null }, { quotaUpdatedAtIso: null },
    { quotaUpdatedAtIso: 'invalid' }, { quotaUpdatedAtIso: new Date(now - 300_001).toISOString() },
    { quotaUpdatedAtIso: new Date(now + 1).toISOString() },
  ])('omits unavailable or unreliable snapshots: %j', overrides => {
    expect(accountQuotaHeaders(key, account(overrides), now)).toEqual({})
  })
  it('omits expired and malformed windows while preserving a valid partial window', () => {
    const row = account()
    row.quotaSnapshot!.primary!.resetsAt = now / 1000
    row.quotaSnapshot!.secondary = { usedPercent: 12.5, windowMinutes: null, resetsAt: null }
    expect(accountQuotaHeaders(key, row, now)).toEqual({ 'x-codex-secondary-used-percent': '12.5' })
    for (const value of [NaN, Infinity, -1, 101]) {
      row.quotaSnapshot!.secondary.usedPercent = value
      expect(accountQuotaHeaders(key, row, now)).toEqual({})
    }
  })
})
