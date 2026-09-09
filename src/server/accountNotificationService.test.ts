import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AccountNotificationService } from './accountNotificationService'
import { defaultNoticeRule, defaultNotificationSettings, renderNoticeBody, parseResetExpiryLeadTimes } from '../accountNotifications'
import type { AccountAuthCoordinator } from './accountAuthCoordinator'
import { AccountAuthStore, type StoredAccountEntry } from './accountAuthStore'
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

it('normalizes comma, Chinese comma and whitespace separators while preserving connected day-hour tokens', () => {
  expect(parseResetExpiryLeadTimes('7d，3d 12h').text).toBe('7d, 3d, 12h')
  expect(parseResetExpiryLeadTimes('1h, 3h, 1d12h, 3d, 7d')).toEqual({ text: '7d, 3d, 1d12h, 3h, 1h', hours: [168, 72, 36, 3, 1] })
  expect(parseResetExpiryLeadTimes('3d 12h').hours).toEqual([72, 12])
  expect(parseResetExpiryLeadTimes('3d12h').hours).toEqual([84])
  expect(() => parseResetExpiryLeadTimes('0h')).toThrow()
  expect(() => parseResetExpiryLeadTimes('1.5d')).toThrow()
})
it('sends each expiry threshold once across restart, catches up only one threshold, and cancels expired notices', async () => {
  const { service, send, coordinator } = await fixture()
  const now = Date.now()
  const expiresAt = now + 8 * 86400_000
  const account = { ...entry(100, 80), resetCredits: { availableCount: 1, credits: [{ id: 'credit-a', expiresAt: expiresAt / 1000, status: 'available', resetType: 'codex' }] } }
  await service.save({ settings: { ...defaultNotificationSettings, enabled: true, url: 'http://127.0.0.1/fixture', body: '{"message":"{{message}}","lead":"{{lead_time}}"}' }, accountId: 'account-a', rule: { ...defaultNoticeRule, resetExpiry: true, resetExpiryLeadTimes: '7d，3d 12h' } })
  expect((await service.snapshot()).accounts['account-a']?.resetExpiryLeadTimes).toBe('7d, 3d, 12h')
  await service.checkExpiries([account], now)
  expect((await service.snapshot()).pendingCount).toBe(0)
  await service.checkExpiries([account], now + 86400_000)
  await service.checkExpiries([account], now + 86400_000)
  expect((await service.snapshot()).pendingCount).toBe(1)
  await service.flush(now + 86400_000)
  expect(send).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body)).lead).toBe('7d')
  await service.close()
  const restarted = new AccountNotificationService(coordinator, send as typeof fetch, false)
  cleanup.push(() => restarted.close())
  await restarted.checkExpiries([account], now + 86400_000)
  expect((await restarted.snapshot()).pendingCount).toBe(0)
  await restarted.checkExpiries([account], expiresAt - 3600_000)
  expect((await restarted.snapshot()).pendingCount).toBe(1)
  await restarted.checkExpiries([account], expiresAt)
  expect((await restarted.snapshot()).pendingCount).toBe(0)
})

it('drops queued expiry reminders when a reset credit is consumed or its account rule is disabled', async () => {
  const { service, send } = await fixture()
  const now = Date.now()
  const account = { ...entry(100, 80), resetCredits: { availableCount: 1, credits: [{ id: 'credit-a', expiresAt: (now + 86400_000) / 1000, status: 'available', resetType: 'codex' }] } }
  await service.save({ accountId: 'account-a', rule: { ...defaultNoticeRule, resetExpiry: true } })
  await service.checkExpiries([account], now)
  expect((await service.snapshot()).pendingCount).toBe(1)
  await service.checkExpiries([{ ...account, resetCredits: { availableCount: 0, credits: [] } }], now)
  expect((await service.snapshot()).pendingCount).toBe(0)
  await service.checkExpiries([{ ...account, resetCredits: { ...account.resetCredits, credits: [{ ...account.resetCredits.credits[0]!, id: 'credit-b' }] } }], now)
  expect((await service.snapshot()).pendingCount).toBe(1)
  await service.save({ accountId: 'account-a', rule: { ...defaultNoticeRule, resetExpiry: false } })
  expect((await service.snapshot()).pendingCount).toBe(0)
  expect(send).not.toHaveBeenCalled()
})

function withCredits(count: number, timestamp = '2026-09-10T00:00:00Z'): StoredAccountEntry {
  return { ...entry(100, 80), quotaUpdatedAtIso: timestamp, resetCredits: { availableCount: count, credits: null } }
}
it('notifies only reset count increases, preserving the baseline and pending notice across restart', async () => {
  const { service, send, coordinator } = await fixture()
  await service.save({ accountId: 'account-a', rule: { ...defaultNoticeRule, resetIncrease: true } })
  await service.observe(withCredits(1))
  expect((await service.snapshot()).pendingCount).toBe(0)
  await service.observe(withCredits(3, '2026-09-10T01:00:00Z'))
  await service.observe(withCredits(3, '2026-09-10T01:00:00Z'))
  expect((await service.snapshot()).pendingCount).toBe(1)
  await service.flush(Date.parse('2026-09-10T15:00:00Z'))
  expect(send).not.toHaveBeenCalled()
  await service.close()
  const restarted = new AccountNotificationService(coordinator, send as typeof fetch, false)
  cleanup.push(() => restarted.close())
  await restarted.observe(withCredits(3, '2026-09-10T02:00:00Z'))
  await restarted.flush(Date.parse('2026-09-11T01:00:00Z'))
  expect(send).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(send.mock.calls[0]![1]!.body)).message).toContain('增加 2 次，当前可用 3 次')
  await restarted.observe(withCredits(2, '2026-09-10T03:00:00Z'))
  expect((await restarted.snapshot()).pendingCount).toBe(0)
  await restarted.observe(withCredits(3, '2026-09-10T04:00:00Z'))
  expect((await restarted.snapshot()).pendingCount).toBe(1)
})
it('ignores unknown, failed and stale reset snapshots instead of interpreting them as zero', async () => {
  const { service } = await fixture()
  await service.save({ accountId: 'account-a', rule: { ...defaultNoticeRule, resetIncrease: true } })
  await service.observe(withCredits(3, '2026-09-10T02:00:00Z'))
  await service.observe({ ...entry(100, 80), resetCredits: null })
  await service.observe({ ...withCredits(0, '2026-09-10T03:00:00Z'), quotaStatus: 'error' })
  await service.observe(withCredits(0, '2026-09-10T01:00:00Z'))
  await service.observe(withCredits(3, '2026-09-10T04:00:00Z'))
  expect((await service.snapshot()).pendingCount).toBe(0)
})
it('tracks reset counts without a quota window and renders count variables in nested POST fields', async () => {
  const { service, send } = await fixture()
  await service.save({ settings: { ...defaultNotificationSettings, enabled: true, url: 'http://127.0.0.1/fixture', body: '{"message":"{{message}}","counts":{"added":"{{increase}}","before":"{{previous}}","now":"{{remaining}}"}}' }, accountId: 'account-a', rule: { ...defaultNoticeRule, resetIncrease: true } })
  await service.observe({ ...withCredits(0), quotaSnapshot: null })
  await service.observe({ ...withCredits(2), quotaSnapshot: null })
  await service.flush()
  expect(send).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(send.mock.calls[0]![1]!.body)).counts).toEqual({ added: '2', before: '0', now: '2' })
})
it('drops pending reset increases on disable and does not report increases observed while disabled', async () => {
  const { service } = await fixture()
  await service.save({ accountId: 'account-a', rule: { ...defaultNoticeRule, resetIncrease: true } })
  await service.observe(withCredits(0))
  await service.observe(withCredits(1))
  expect((await service.snapshot()).pendingCount).toBe(1)
  await service.save({ accountId: 'account-a', rule: { ...defaultNoticeRule, resetIncrease: false } })
  expect((await service.snapshot()).pendingCount).toBe(0)
  await service.observe(withCredits(2))
  await service.save({ accountId: 'account-a', rule: { ...defaultNoticeRule, resetIncrease: true } })
  await service.observe(withCredits(2))
  expect((await service.snapshot()).pendingCount).toBe(0)
})
it('validates new rule fields and upgrades saved legacy rules with increase notices disabled', async () => {
  const { service } = await fixture()
  await expect(service.save({ accountId: 'account-a', rule: { ...defaultNoticeRule, resetIncrease: 'yes' } as any })).rejects.toThrow('增加提醒选项')
  await expect(service.save({ accountId: 'account-a', rule: { ...defaultNoticeRule, resetIncreaseMessage: 3 } as any })).rejects.toThrow('增加提醒内容')
  const { resetIncrease: _enabled, resetIncreaseMessage: _message, ...legacy } = defaultNoticeRule
  await service.save({ accountId: 'account-a', rule: legacy })
  expect((await service.snapshot()).accounts['account-a']?.resetIncrease).toBe(false)
})
it('separates count baselines by account and makes concurrent identical observations produce one event', async () => {
  const { service, coordinator } = await fixture()
  await coordinator.store.updateState((state: any) => ({ state: { ...state, accounts: [...state.accounts, { ...entry(100, 80), storageId: 'account-b' }] }, result: undefined }))
  for (const accountId of ['account-a', 'account-b']) await service.save({ accountId, rule: { ...defaultNoticeRule, resetIncrease: true } })
  await service.observe(withCredits(0))
  await service.observe({ ...withCredits(3), storageId: 'account-b' })
  await Promise.all([service.observe(withCredits(1)), service.observe(withCredits(1))])
  expect((await service.snapshot()).pendingCount).toBe(1)
})

it('delivers a reset increase through real loopback HTTP exactly once without touching reset APIs', async () => {
  const { createServer } = await import('node:http')
  const bodies: unknown[] = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += String(chunk)
    bodies.push(JSON.parse(body))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"received":true}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const { service, send } = await fixture()
    send.mockImplementation((url, options) => fetch(url, options))
    const address = server.address() as import('node:net').AddressInfo
    await service.save({ settings: { ...defaultNotificationSettings, enabled: true, url: `http://127.0.0.1:${address.port}/notice` }, accountId: 'account-a', rule: { ...defaultNoticeRule, resetIncrease: true } })
    await service.observe(withCredits(0))
    await service.observe(withCredits(1))
    await service.observe(withCredits(1))
    await service.flush()
    await service.flush()
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toEqual({ message: expect.stringContaining('增加 1 次，当前可用 1 次') })
    expect((await service.snapshot()).lastResult).toBe('通知已发送')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

// Uses real persisted account metadata and fake credentials, with the auth gate held busy.
it('saves and clears a local alias while logged out without touching credentials, epochs or revisions', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'account-alias-'))
  cleanup.push(() => rm(codexHome, { recursive: true, force: true }))
  const store = new AccountAuthStore(codexHome)
  const raw = JSON.stringify({ tokens: { account_id: 'alias-fixture', access_token: 'fixture', refresh_token: 'fixture' } })
  const { account } = await store.upsertCredential(raw, { activate: true, authStatus: 'reauth_required' })
  const before = await store.readState()
  const coordinator = { store, isAccountOperationInProgress: () => true, refreshAccount: vi.fn() } as unknown as AccountAuthCoordinator
  const send = vi.fn()
  const service = new AccountNotificationService(coordinator, send, false)
  cleanup.push(() => service.close())
  await service.save({ accountId: account.storageId, rule: defaultNoticeRule, alias: '  备用账号  ' })
  const after = await store.readState()
  expect(after).toEqual({ ...before, accounts: [{ ...before.accounts[0], alias: '备用账号' }] })
  expect(await readFile(store.activeAuthPath, 'utf8')).toBe(raw)
  expect(await readFile(store.credentialPath(account.storageId), 'utf8')).toBe(raw)
  expect((await new AccountAuthStore(codexHome).readState()).accounts[0]?.alias).toBe('备用账号')
  await expect(service.save({ accountId: account.storageId, rule: defaultNoticeRule, alias: 'x'.repeat(81), protectionPercent: 12 })).rejects.toThrow('80')
  expect(await store.readState()).toEqual(after)
  await service.save({ accountId: account.storageId, rule: defaultNoticeRule, alias: '   ' })
  expect(await store.readState()).toEqual(before)
  expect(coordinator.refreshAccount).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
})

it('keeps local aliases out of external notification text', async () => {
  const { service, send } = await fixture()
  await service.observe({ ...entry(100, 80), alias: 'local only' })
  await service.observe({ ...entry(200, 0), alias: 'local only' })
  await service.flush(Date.parse('2026-09-09T01:00:00Z'))
  expect(send).toHaveBeenCalledTimes(2)
  for (const call of send.mock.calls) {
    expect(String(call[1]?.body)).toContain('example@test')
    expect(String(call[1]?.body)).not.toContain('local only')
  }
})

it('flags only an actual reserve change for connection enforcement, not alias or notification edits', async () => {
  const { service } = await fixture()
  const rule = { ...defaultNoticeRule, resetIncrease: true }
  expect((await service.save({ accountId: 'account-a', rule, alias: 'local', protectionPercent: 1 })).protectionChanged).toBe(false)
  expect((await service.save({ accountId: 'account-a', rule, alias: 'renamed' })).protectionChanged).toBe(false)
  expect((await service.save({ accountId: 'account-a', rule, protectionPercent: 2 })).protectionChanged).toBe(true)
  expect((await service.save({ accountId: 'account-a', rule, protectionPercent: 2 })).protectionChanged).toBe(false)
  expect((await service.save({ accountId: 'account-a', rule, protectionPercent: 0 })).protectionChanged).toBe(true)
})
