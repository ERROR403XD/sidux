import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AccountNotificationService } from './accountNotificationService'
import { defaultNoticeRule, defaultNotificationSettings, renderNoticeBody } from '../accountNotifications'
import type { AccountAuthCoordinator } from './accountAuthCoordinator'
import type { StoredAccountEntry } from './accountAuthStore'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
function entry(reset: number, used: number): StoredAccountEntry {
  return { storageId: 'account-a', accountId: 'identity-a', email: 'example@test', quotaStatus: 'ready', quotaSnapshot: { primary: { windowMinutes: 300, resetsAt: reset, usedPercent: used }, secondary: { windowMinutes: 10080, resetsAt: reset, usedPercent: used } } } as StoredAccountEntry
}
async function fixture() {
  const codexHome = await mkdtemp(join(tmpdir(), 'account-notify-'))
  cleanup.push(() => rm(codexHome, { recursive: true, force: true }))
  let state = { accounts: [entry(100, 80)] }
  const coordinator = { store: { codexHome, readState: async () => state, updateState: async (fn: any) => { const next = fn(state); state = next.state; return next.result } }, isAccountOperationInProgress: () => false, refreshAccount: vi.fn() } as unknown as AccountAuthCoordinator
  const send = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => new Response('{}', { status: 200 }))
  const service = new AccountNotificationService(coordinator, send as typeof fetch, false)
  cleanup.push(() => service.close())
  await service.save({ settings: { ...defaultNotificationSettings, enabled: true, url: 'http://127.0.0.1/fixture', quietEnabled: true }, accountId: 'account-a', rule: { ...defaultNoticeRule, fiveHour: true, weekly: true }, protectionPercent: 1 })
  return { service, send, coordinator }
}
it('deduplicates quota recovery, persists quiet-hour deferral and delivers escaped JSON once', async () => {
  const { service, send, coordinator } = await fixture()
  await service.observe(entry(100, 80))
  expect((await service.snapshot()).pendingCount).toBe(0)
  await service.observe(entry(200, 0))
  await service.observe(entry(200, 0))
  expect((await service.snapshot()).pendingCount).toBe(2)
  await service.flush(Date.parse('2026-09-08T15:00:00Z')) // Shanghai 23:00
  expect(send).not.toHaveBeenCalled()
  await service.close()
  const restarted = new AccountNotificationService(coordinator, send as typeof fetch, false)
  cleanup.push(() => restarted.close())
  await restarted.flush(Date.parse('2026-09-09T01:00:00Z'))
  expect(send).toHaveBeenCalledTimes(2)
  expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body)).message).toContain('example@test')
  await restarted.flush(Date.parse('2026-09-09T01:00:00Z'))
  expect(send).toHaveBeenCalledTimes(2)
  expect((await coordinator.store.readState()).accounts[0]?.protectionPercent).toBe(1)
})
it('does not retry an ambiguous POST and disabling a rule removes its pending events', async () => {
  const { service, send } = await fixture()
  await service.observe(entry(100, 80))
  await service.observe(entry(200, 0))
  await service.save({ accountId: 'account-a', rule: { ...defaultNoticeRule, fiveHour: true } })
  expect((await service.snapshot()).pendingCount).toBe(1)
  send.mockRejectedValueOnce(new Error('transport uncertain'))
  await service.flush(Date.parse('2026-09-09T01:00:00Z'))
  await service.flush(Date.parse('2026-09-09T01:00:00Z'))
  expect(send).toHaveBeenCalledTimes(1)
  expect((await service.snapshot()).lastResult).toContain('未确认')
})
it('substitutes nested message strings without turning message content into body configuration', () => {
  const text = 'quote" and\nnewline {{other}}'
  expect(JSON.parse(renderNoticeBody('{"token":"literal","nested":{"text":"{{message}}"}}', { message: text }))).toEqual({ token: 'literal', nested: { text } })
})


it('uses a 45 percentage-point increase rather than full recovery or relative growth', async () => {
  const { service } = await fixture()
  await service.observe(entry(100, 80)) // remaining 20%
  await service.observe(entry(100, 70)) // remaining 30%: relative +50%, absolute +10
  expect((await service.snapshot()).pendingCount).toBe(0)
  await service.observe(entry(100, 25.1)) // +44.9 points
  expect((await service.snapshot()).pendingCount).toBe(0)
  await service.observe(entry(100, 80))
  await service.observe(entry(100, 35)) // +45 points, only 65% remaining
  expect((await service.snapshot()).pendingCount).toBe(2)
  await service.observe(entry(100, 35))
  await service.observe(entry(100, 0)) // +35, reaches 100% but is not a recovery event
  expect((await service.snapshot()).pendingCount).toBe(2)
})
it('suppresses actual reset usage for ten minutes without consulting credit count', async () => {
  const { service } = await fixture()
  await service.observe(entry(100, 80))
  await service.observe({ ...entry(100, 20), lastResetUsedAtIso: new Date().toISOString() })
  expect((await service.snapshot()).pendingCount).toBe(0)
  await service.observe(entry(100, 80))
  await service.observe({ ...entry(100, 35), lastResetUsedAtIso: new Date(Date.now() - 600_001).toISOString(), resetCredits: { availableCount: 0, credits: [] } })
  expect((await service.snapshot()).pendingCount).toBe(2)
})
it('normalizes legacy generic weekly wording in saved notification templates', async () => {
  const { service } = await fixture()
  await service.save({ accountId: 'account-a', rule: { ...defaultNoticeRule, weeklyMessage: '{{account}} 的周额度已恢复' } })
  expect((await service.snapshot()).accounts['account-a']?.weeklyMessage).toBe('{{account}} 的主额度已恢复')
})

it('includes the exact decimal 45-point boundary without rounding smaller increases up', async () => {
  const { service } = await fixture()
  await service.observe(entry(100, 90.1))
  await service.observe(entry(100, 45.101))
  expect((await service.snapshot()).pendingCount).toBe(0)
  await service.observe(entry(100, 90.1))
  await service.observe(entry(100, 45.1))
  expect((await service.snapshot()).pendingCount).toBe(2)
})
