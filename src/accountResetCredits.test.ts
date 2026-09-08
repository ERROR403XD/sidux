import { expect, it } from 'vitest'
import { availableResetCredits, normalizeResetCredits } from './accountResetCredits'
it('keeps snapshot-only totals and sorts usable credits by expiry, omitting expired or redeemed rows', () => {
  const summary = normalizeResetCredits({ availableCount: 5, credits: [
    { id: 'later', status: 'available', expiresAt: 300 }, { id: 'never', status: 'available' },
    { id: 'next', status: 'available', expiresAt: 200 }, { id: 'expired', status: 'available', expiresAt: 50 },
    { id: 'used', status: 'redeemed', expiresAt: 150 },
  ] })
  expect(summary?.availableCount).toBe(5)
  expect(availableResetCredits(summary, 100_000).map(row => row.id)).toEqual(['next', 'later', 'never'])
  expect(normalizeResetCredits({ availableCount: 2 })?.credits).toBeNull()
})
