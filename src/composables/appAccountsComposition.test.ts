import { nextTick, ref } from 'vue'
import { createAppAccountsController } from './appAccountsController'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountLoginCompleteResult, AccountsListResult } from '../api/accountGateway'
import type { UiAccountEntry, UiRateLimitSnapshot } from '../types/codex'

const api = vi.hoisted(() => ({
  getAccounts: vi.fn(), refreshAccountQuota: vi.fn(), switchAccount: vi.fn(), removeAccount: vi.fn(), refreshAccountsFromAuth: vi.fn(),
}))
vi.mock('../api/accountGateway', async importOriginal => ({
  ...await importOriginal<typeof import('../api/accountGateway')>(), ...api,
}))
const notifications = vi.hoisted(() => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }))
vi.mock('../api/codexRpcClient', () => ({ subscribeRpcNotifications: notifications.subscribe }))
const flush = async () => { for (let index = 0; index < 16; index += 1) await Promise.resolve() }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function account(storageId: string, isActive = false): UiAccountEntry {
  return {
    storageId, accountId: storageId, isActive, email: null, planType: 'plus', authMode: 'chatgpt',
    authStatus: 'ready', unavailableReason: null, canSwitch: true, actionRequired: null,
    quotaSnapshot: null, quotaUpdatedAtIso: null, quotaStatus: 'idle', quotaError: null,
  } as UiAccountEntry
}
function snapshot(activeId = 'a', ids = ['a', 'b']): AccountsListResult {
  return { activeAccountId: activeId, activeStorageId: activeId, accounts: ids.map(id => account(id, id === activeId)) }
}

const controllers: ReturnType<typeof createAppAccountsController>[] = []
function setup() {
  const notify = vi.fn()
  const provider = ref('codex')
  const rateLimits = ref<UiRateLimitSnapshot[]>([])
  const workspace = {
    loadConnections: vi.fn().mockResolvedValue(undefined), invalidateModels: vi.fn(),
    stopPolling: vi.fn(), startPolling: vi.fn(), refresh: vi.fn().mockResolvedValue(undefined),
  }
  const controller = createAppAccountsController({
    t: text => text, notifyOperation: notify,
    getSelectedProvider: () => provider.value,
    getRateLimitSnapshots: () => rateLimits.value,
    workspace: {
      ...workspace,
      getSelectedThreadId: () => 'thread-a',
      restartPolling: () => { workspace.stopPolling(); workspace.startPolling() },
    },
  })
  controllers.push(controller)
  return { controller, workspace, notify, stop: controller.stop, provider, rateLimits }
}
beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset()
  api.getAccounts.mockResolvedValue(snapshot())
  api.refreshAccountQuota.mockResolvedValue(snapshot())
  api.switchAccount.mockResolvedValue({ account: account('b', true) })
  api.removeAccount.mockResolvedValue(snapshot('b', ['b']))
  api.refreshAccountsFromAuth.mockResolvedValue(snapshot())
  notifications.subscribe.mockReset().mockReturnValue(notifications.unsubscribe)
  notifications.unsubscribe.mockReset()
})

afterEach(() => {
  controllers.splice(0).forEach(controller => controller.stop())
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('App account actions and workspace composition', () => {
  it('switches with the expected identity and selected conversation, then refreshes the workspace', async () => {
    const { controller, workspace, notify } = setup()
    await controller.loadAccountsState()
    api.getAccounts.mockResolvedValue(snapshot('b'))
    await controller.onSwitchAccount('b')
    expect(api.switchAccount).toHaveBeenCalledWith('b', 'a', 'thread-a')
    expect(workspace.loadConnections).toHaveBeenCalledOnce()
    expect(workspace.invalidateModels).toHaveBeenCalledOnce()
    expect(workspace.stopPolling).toHaveBeenCalledOnce()
    expect(workspace.startPolling).toHaveBeenCalledOnce()
    expect(workspace.refresh).toHaveBeenCalledWith({ accountChanged: true, includeSelectedThreadMessages: true, awaitAncillaryRefreshes: true })
    expect(controller.activeAccount.value?.storageId).toBe('b')
    expect(controller.isSwitchingAccounts.value).toBe(false)
    expect(notify).toHaveBeenLastCalledWith('账号已切换', 'success')
  })

  it('does not let a pre-switch list restore the old active identity', async () => {
    const { controller } = setup()
    await controller.loadAccountsState()
    const old = deferred<AccountsListResult>()
    api.getAccounts.mockReturnValueOnce(old.promise).mockResolvedValue(snapshot('b'))
    const reading = controller.loadAccountsState()
    await controller.onSwitchAccount('b')
    old.resolve(snapshot('a'))
    await reading
    expect(controller.activeAccount.value?.storageId).toBe('b')
  })

  it('does not restart polling, read accounts or notify after a switch finishes after unmount', async () => {
    const { controller, workspace, notify, stop } = setup()
    await controller.loadAccountsState()
    const waiting = deferred<{ account: UiAccountEntry }>()
    api.switchAccount.mockReturnValueOnce(waiting.promise)
    const switching = controller.onSwitchAccount('b')
    stop()
    waiting.resolve({ account: account('b', true) })
    await switching
    expect(workspace.startPolling).not.toHaveBeenCalled()
    expect(workspace.loadConnections).not.toHaveBeenCalled()
    expect(workspace.refresh).not.toHaveBeenCalled()
    expect(api.getAccounts).toHaveBeenCalledOnce()
    expect(controller.activeAccount.value?.storageId).toBe('a')
    expect(notify).not.toHaveBeenCalled()
  })

  it('ends serial quota refresh at unmount without starting the next request', async () => {
    const { controller, notify, stop } = setup()
    await controller.loadAccountsState()
    const waiting = deferred<AccountsListResult>()
    api.refreshAccountQuota.mockReturnValueOnce(waiting.promise)
    const refreshing = controller.onRefreshAccounts()
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
    expect(api.refreshAccountQuota).toHaveBeenCalledOnce()
    stop()
    waiting.resolve(snapshot('b'))
    await refreshing
    expect(api.refreshAccountQuota).toHaveBeenCalledTimes(1)
    expect(controller.activeAccount.value?.storageId).toBe('a')
    expect(notify).not.toHaveBeenCalled()
  })

  it('keeps account reads from duplicating the same in-flight request', async () => {
    const { controller } = setup()
    const waiting = deferred<AccountsListResult>()
    api.getAccounts.mockReturnValueOnce(waiting.promise)
    const first = controller.loadAccountsState({ silent: true })
    const second = controller.loadAccountsState()
    waiting.resolve(snapshot())
    await Promise.all([first, second])
    expect(api.getAccounts).toHaveBeenCalledOnce()
  })

  it('requires confirmation and prevents a second identity mutation during removal', async () => {
    const { controller, workspace } = setup()
    await controller.loadAccountsState()
    await controller.onRemoveAccount('a')
    expect(api.removeAccount).not.toHaveBeenCalled()
    const waiting = deferred<AccountsListResult>()
    api.removeAccount.mockReturnValueOnce(waiting.promise)
    const removing = controller.onRemoveAccount('a')
    await controller.onSwitchAccount('b')
    expect(api.switchAccount).not.toHaveBeenCalled()
    waiting.resolve(snapshot('b', ['b']))
    await removing
    expect(workspace.refresh).toHaveBeenCalledWith({ accountChanged: true, includeSelectedThreadMessages: true })
  })

  it('retains newer quota fields when a list snapshot is older', async () => {
    const { controller } = setup()
    const newer = snapshot()
    newer.accounts[0]!.quotaUpdatedAtIso = '2026-10-12T10:00:00Z'
    newer.accounts[0]!.quotaError = 'new quota'
    api.getAccounts.mockResolvedValueOnce(newer)
    await controller.loadAccountsState()
    const older = snapshot()
    older.accounts[0]!.quotaUpdatedAtIso = '2026-10-12T09:00:00Z'
    api.getAccounts.mockResolvedValueOnce(older)
    await controller.loadAccountsState()
    expect(controller.accounts.value[0]?.quotaError).toBe('new quota')
  })

  it('re-admits a removed account after login and closes the modal', async () => {
    const { controller, workspace, notify } = setup()
    await controller.loadAccountsState()
    await controller.onRemoveAccount('a')
    await controller.onRemoveAccount('a')
    controller.onStartCodexLogin('reauth', 'a')
    const result = { ...snapshot(), account: account('a', true), outcome: 'reauthenticated', poolSize: 2 } as AccountLoginCompleteResult
    controller.onAccountLoginCompleted(result)
    expect(controller.activeAccount.value?.storageId).toBe('a')
    expect(controller.isCodexLoginModalOpen.value).toBe(false)
    expect(controller.loginTargetStorageId.value).toBe('')
    expect(workspace.startPolling).toHaveBeenCalledTimes(2)
    expect(notify).toHaveBeenLastCalledWith('Account sign-in refreshed.', 'success')
  })

  it('keeps a switch failure visible and resets its busy state', async () => {
    const { controller, workspace, notify } = setup()
    await controller.loadAccountsState()
    api.switchAccount.mockRejectedValueOnce(new Error('switch blocked'))
    await controller.onSwitchAccount('b')
    expect(controller.activeAccount.value?.storageId).toBe('a')
    expect(controller.isSwitchingAccounts.value).toBe(false)
    expect(workspace.startPolling).not.toHaveBeenCalled()
    expect(notify).toHaveBeenLastCalledWith('switch blocked')
  })

  it('ignores a failed account read and login completion after unmount', async () => {
    const { controller, workspace, notify, stop } = setup()
    await controller.loadAccountsState()
    const waiting = deferred<AccountsListResult>()
    api.getAccounts.mockReturnValueOnce(waiting.promise)
    const reading = controller.loadAccountsState()
    stop()
    waiting.reject(new Error('late account error'))
    await reading
    controller.onAccountLoginCompleted({ ...snapshot('b'), account: account('b', true), outcome: 'added', poolSize: 2 })
    expect(controller.accountActionError.value).toBe('')
    expect(controller.activeAccount.value?.storageId).toBe('a')
    expect(workspace.startPolling).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('does not apply a removal completed after unmount', async () => {
    const { controller, workspace, notify, stop } = setup()
    await controller.loadAccountsState()
    await controller.onRemoveAccount('a')
    const waiting = deferred<AccountsListResult>()
    api.removeAccount.mockReturnValueOnce(waiting.promise)
    const removing = controller.onRemoveAccount('a')
    stop()
    waiting.resolve(snapshot('b', ['b']))
    await removing
    expect(controller.accounts.value).toHaveLength(2)
    expect(workspace.startPolling).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(api.getAccounts).toHaveBeenCalledOnce()
  })
})

describe('account state, subscriptions and polling ownership', () => {
  it('owns both timers and one subscription, disposes them once and cannot restart after close', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {})
    vi.stubGlobal('document', { hidden: false })
    const { controller } = setup()
    controller.start()
    controller.start()
    expect(notifications.subscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
    const loading = snapshot()
    loading.accounts[0]!.quotaStatus = 'loading'
    api.getAccounts.mockResolvedValueOnce(loading)
    await controller.loadAccountsState()
    await nextTick()
    expect(vi.getTimerCount()).toBe(2)
    await controller.loadAccountsState()
    await nextTick()
    expect(vi.getTimerCount()).toBe(1)
    controller.stop()
    controller.stop()
    controller.start()
    expect(notifications.unsubscribe).toHaveBeenCalledOnce()
    expect(notifications.subscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shares a request between the loading and overview clocks and rejects its result after stop', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {})
    vi.stubGlobal('document', { hidden: false })
    const { controller } = setup()
    const loading = snapshot()
    loading.accounts[0]!.quotaStatus = 'loading'
    api.getAccounts.mockResolvedValueOnce(loading)
    await controller.loadAccountsState()
    await nextTick()
    controller.start()
    const waiting = deferred<AccountsListResult>()
    api.getAccounts.mockReset().mockReturnValue(waiting.promise)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(api.getAccounts).toHaveBeenCalledOnce()
    controller.stop()
    waiting.resolve(snapshot('b'))
    await flush()
    expect(controller.activeAccount.value?.storageId).toBe('a')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('normalizes quota notifications without changing account routing or adding accounts', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('document', { hidden: false })
    const { controller } = setup()
    await controller.loadAccountsState()
    controller.start()
    const listener = notifications.subscribe.mock.calls[0]![0]
    listener({ method: 'unrelated', params: { account: account('b', true) } })
    listener({ method: 'codexapp/accountQuota/updated', params: { account: null } })
    const updated = { ...account('b', true), quotaUpdatedAtIso: '2026-10-12T10:00:00Z', quotaStatus: 'ready', canSwitch: false, actionRequired: 'reauthenticate' }
    listener({ method: 'codexapp/accountQuota/updated', params: { account: updated } })
    listener({ method: 'codexapp/accountQuota/updated', params: { account: account('unknown', true) } })
    expect(controller.activeAccount.value?.storageId).toBe('a')
    expect(controller.accounts.value).toHaveLength(2)
    expect(controller.accounts.value[1]).toMatchObject({ quotaUpdatedAtIso: updated.quotaUpdatedAtIso, isActive: false, canSwitch: true, actionRequired: null })
    const before = controller.accounts.value
    controller.stop()
    listener({ method: 'codexapp/accountQuota/updated', params: { account: account('a') } })
    expect(controller.accounts.value).toBe(before)
  })

  it('imports external auth once only after the provider and quota prerequisites are satisfied', async () => {
    const { controller, provider, rateLimits, workspace } = setup()
    controller.setExternalAuthAvailable(true)
    expect(await controller.refreshExternalAuth()).toBe(false)
    provider.value = 'openrouter'
    rateLimits.value = [{ primary: null, secondary: null } as UiRateLimitSnapshot]
    await nextTick()
    expect(api.refreshAccountsFromAuth).not.toHaveBeenCalled()
    provider.value = 'codex'
    expect(await controller.refreshExternalAuth()).toBe(true)
    expect(await controller.refreshExternalAuth()).toBe(false)
    expect(api.refreshAccountsFromAuth).toHaveBeenCalledOnce()
    expect(workspace.refresh).toHaveBeenCalledExactlyOnceWith({ includeSelectedThreadMessages: false, providerChanged: true, awaitAncillaryRefreshes: true })
    expect(controller.accounts.value).toHaveLength(2)
  })

  it('refreshes provider metadata once when the quota watcher imports an external account', async () => {
    const { controller, rateLimits, workspace } = setup()
    controller.setExternalAuthAvailable(true)
    rateLimits.value = [{ primary: null, secondary: null } as UiRateLimitSnapshot]
    await nextTick()
    await flush()
    expect(api.refreshAccountsFromAuth).toHaveBeenCalledOnce()
    expect(workspace.refresh).toHaveBeenCalledExactlyOnceWith({ includeSelectedThreadMessages: false, providerChanged: true, awaitAncillaryRefreshes: true })
  })

  it('rejects late external auth import after disposal without a workspace refresh', async () => {
    const { controller, rateLimits, workspace } = setup()
    const waiting = deferred<AccountsListResult>()
    api.refreshAccountsFromAuth.mockReturnValueOnce(waiting.promise)
    controller.setExternalAuthAvailable(true)
    rateLimits.value = [{ primary: null, secondary: null } as UiRateLimitSnapshot]
    await nextTick()
    expect(api.refreshAccountsFromAuth).toHaveBeenCalledOnce()
    controller.stop()
    waiting.resolve(snapshot())
    await flush()
    expect(controller.accounts.value).toEqual([])
    expect(workspace.refresh).not.toHaveBeenCalled()
  })

  it('rejects a list started while switch connection preparation is pending', async () => {
    const { controller, workspace } = setup()
    await controller.loadAccountsState()
    const preparation = deferred<void>()
    workspace.loadConnections.mockReturnValueOnce(preparation.promise)
    const switching = controller.onSwitchAccount('b')
    await flush()
    const old = deferred<AccountsListResult>()
    api.getAccounts.mockReturnValueOnce(old.promise).mockResolvedValue(snapshot('b'))
    const reading = controller.loadAccountsState()
    preparation.resolve()
    await switching
    old.resolve(snapshot())
    await reading
    expect(controller.activeAccount.value?.storageId).toBe('b')
  })

  it('keeps a quota operation from reverting identity after a switch', async () => {
    const { controller } = setup()
    await controller.loadAccountsState()
    const waiting = deferred<AccountsListResult>()
    api.refreshAccountQuota.mockReturnValueOnce(waiting.promise)
    const refreshing = controller.onRefreshAccountQuota('a')
    api.getAccounts.mockResolvedValue(snapshot('b'))
    await controller.onSwitchAccount('b')
    waiting.resolve(snapshot())
    await refreshing
    expect(controller.activeAccount.value?.storageId).toBe('b')
  })

  it('keeps per-caller silent error handling while sharing one failed read', async () => {
    const { controller, notify } = setup()
    const waiting = deferred<AccountsListResult>()
    api.getAccounts.mockReturnValueOnce(waiting.promise)
    const silent = controller.loadAccountsState({ silent: true })
    const visible = controller.loadAccountsState()
    waiting.reject(new Error('account read failed'))
    await Promise.all([silent, visible])
    expect(api.getAccounts).toHaveBeenCalledOnce()
    expect(controller.accountActionError.value).toBe('account read failed')
    expect(notify).not.toHaveBeenCalled()
    await controller.loadAccountsState()
    expect(api.getAccounts).toHaveBeenCalledTimes(2)
  })

  it('closes and resumes login through commands while guarding other account actions', async () => {
    const { controller } = setup()
    await controller.loadAccountsState()
    controller.onStartCodexLogin('reauth', 'b')
    expect(controller.isAccountActionDisabled(account('a'))).toBe(true)
    await controller.onSwitchAccount('b')
    await controller.onRemoveAccount('a')
    expect(api.switchAccount).not.toHaveBeenCalled()
    expect(api.removeAccount).not.toHaveBeenCalled()
    controller.closeAccountLogin()
    expect(controller.isStartingCodexLogin.value).toBe(false)
    controller.resumeAccountLogin('reauth', 'b')
    expect(controller.loginTargetAccount.value?.storageId).toBe('b')
    expect(controller.isCodexLoginModalOpen.value).toBe(true)
  })
})
