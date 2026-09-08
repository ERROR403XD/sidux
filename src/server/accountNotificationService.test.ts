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
