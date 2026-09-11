import { describe, expect, it, vi } from 'vitest'
import type { AccountAuthCoordinator } from './accountAuthCoordinator'
import { AccountExecutionRegistry } from './accountExecution'
import { checkActivationAccount } from './accountActivationAdmission'

function fixture() {
  const account = { storageId: 'a', credentialRevision: 1, authStatus: 'ready', quotaStatus: 'ready', quotaUpdatedAtIso: '', quotaSnapshot: {
    primary: { windowMinutes: 10080, usedPercent: 50 }, secondary: { windowMinutes: 300, usedPercent: 0 },
  } }
  const executions = new AccountExecutionRegistry()
  const refreshAccount = vi.fn(async () => { account.quotaUpdatedAtIso = new Date().toISOString(); return account })
  const coordinator = { executions, blocksApiAccount: () => false, isAccountRefreshInProgress: () => false,
    refreshAccount, store: { readState: async () => ({ accounts: [account] }) },
  } as unknown as AccountAuthCoordinator
  return { account, executions, refreshAccount, coordinator }
}

describe('scheduled activation quota admission', () => {
  it('requires a fresh explicit 5h window with 100% remaining and reads quota only once', async () => {
    const f = fixture()
    expect((await checkActivationAccount(f.coordinator, 'a', true)).allowed).toBe(true)
    expect((await checkActivationAccount(f.coordinator, 'a', false)).allowed).toBe(true)
    expect(f.refreshAccount).toHaveBeenCalledOnce()
  })
  it.each([1, 0.01, 100, NaN])('skips nonzero or invalid usage %s', async used => {
    const f = fixture()
    f.account.quotaSnapshot.secondary.usedPercent = used
    expect((await checkActivationAccount(f.coordinator, 'a', true)).allowed).toBe(false)
  })
  it('does not infer 5h from primary order or a missing duration', async () => {
    const f = fixture()
    f.account.quotaSnapshot.secondary.windowMinutes = 0
    expect((await checkActivationAccount(f.coordinator, 'a', true)).reason).toContain('无 5 小时')
  })
  it.each(['primary', 'automation', 'api'] as const)('skips busy %s before any quota request', async kind => {
    const f = fixture()
    f.executions.register({ storageId: 'a', kind, ownerId: 'test', disconnect() {} })
    expect((await checkActivationAccount(f.coordinator, 'a', true)).allowed).toBe(false)
    expect(f.refreshAccount).not.toHaveBeenCalled()
  })
  it('allows idle connections and its own activation lease, but catches activity during preparation', async () => {
    const f = fixture()
    const lease = f.executions.register({ storageId: 'a', kind: 'primary', busy: false, ownerId: 'test', disconnect() {} })
    f.executions.register({ storageId: 'a', kind: 'activation', ownerId: 'scheduled-activation', disconnect() {} })
    expect((await checkActivationAccount(f.coordinator, 'a', true)).allowed).toBe(true)
    lease.setBusy(true)
    expect((await checkActivationAccount(f.coordinator, 'a', false)).allowed).toBe(false)
  })
  it('rejects stale cached quota, refresh errors, and quota changes before send', async () => {
    const f = fixture()
    f.refreshAccount.mockImplementationOnce(async () => f.account)
    expect((await checkActivationAccount(f.coordinator, 'a', true)).allowed).toBe(false)
    f.refreshAccount.mockRejectedValueOnce(new Error('upstream details must not leak'))
    expect((await checkActivationAccount(f.coordinator, 'a', true)).reason).toBe('额度读取失败，本次跳过')
    await checkActivationAccount(f.coordinator, 'a', true)
    f.account.quotaSnapshot.secondary.usedPercent = 2
    expect((await checkActivationAccount(f.coordinator, 'a', false)).allowed).toBe(false)
  })
})
