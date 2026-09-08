import { expect, it } from 'vitest'
import { mergeQuotaUpdate, quotaRefreshInterval, quotaRetryDelay, boundedQuotaRead } from './quotaRefresh.js'
it.each([[0, 60000], [74.9, 60000], [75, 30000], [89.9, 30000], [90, 15000], [98.9, 15000], [99, 5000], [100, 5000]])('polls usage %s at %sms', (usedPercent, interval) => {
  expect(quotaRefreshInterval({ primary: { usedPercent: 0 }, secondary: { usedPercent } })).toBe(interval)
})
it('merges sparse windows and retains unavailable metadata without accepting other model buckets', () => {
  const old = { planType: 'plus', primary: { usedPercent: 10, windowMinutes: 300, resetsAt: 20 }, secondary: { usedPercent: 90, windowMinutes: 10080, resetsAt: 30 }, credits: { hasCredits: true, unlimited: false, balance: '2' } }
  const next = mergeQuotaUpdate(old, { rateLimits: { primary: { usedPercent: 80, resetsAt: null }, secondary: null, planType: null } })
  expect(next).toMatchObject({ ...old, primary: { ...old.primary, usedPercent: 80 } })
  expect(mergeQuotaUpdate(old, { rateLimits: { limitId: 'spark', primary: { usedPercent: 100 } } })).toEqual(old)
  expect(mergeQuotaUpdate(old, { rateLimits: { primary: { usedPercent: 0, windowDurationMins: 60 } } })?.primary).toMatchObject({ windowMinutes: 60, windowDurationMins: 60 })
})
it('honors Retry-After seconds and HTTP dates, then uses bounded exponential backoff', () => {
  expect(quotaRetryDelay(Object.assign(new Error('429'), { data: { headers: { 'Retry-After': '120' } } }), 1)).toBe(120000)
  const now = Date.parse('2026-09-08T00:00:00Z')
  expect(quotaRetryDelay({ headers: { 'retry-after': 'Tue, 08 Sep 2026 00:01:00 GMT' } }, 1, now)).toBe(60000)
  expect(quotaRetryDelay(new Error('429'), 1)).toBe(5000)
  expect(quotaRetryDelay(new Error('429'), 2)).toBe(10000)
  expect(quotaRetryDelay(new Error('429'), 20)).toBe(300000)
})
it('bounds a caller without cancelling its shared underlying read', async () => {
  let resolve!: (value: number) => void
  const underlying = new Promise<number>(done => { resolve = done })
  await expect(boundedQuotaRead(underlying, 1)).rejects.toThrow('超时')
  resolve(1)
  await expect(boundedQuotaRead(underlying)).resolves.toBe(1)
})
