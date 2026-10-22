import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getAccounts, removeAccount, refreshAccountsFromAuth, refreshAccountQuota, switchAccount } from '../api/accountGateway'
import type { AccountLoginCompleteResult } from '../api/accountGateway'
import type { UiAccountEntry, UiRateLimitSnapshot } from '../types/codex'
import type { DesktopRefreshOptions } from './desktopRefreshController'
import { subscribeAccountQuotaUpdates } from './useAccountQuotaUpdates'

export type AccountWorkspacePort = {
  getSelectedThreadId: () => string
  loadConnections: () => Promise<void>
  invalidateModels: () => void
  restartPolling: () => void
  refresh: (options: DesktopRefreshOptions) => Promise<void>
}
export type AppAccountsControllerOptions = {
  workspace: AccountWorkspacePort
  getSelectedProvider: () => string
  getRateLimitSnapshots: () => readonly UiRateLimitSnapshot[]
  t: (text: string) => string
  notifyOperation: (message: string, kind?: 'success' | 'error') => void
}

export function createAppAccountsController({ workspace, getSelectedProvider, getRateLimitSnapshots, t, notifyOperation }: AppAccountsControllerOptions) {
  let unsubscribeQuota: (() => void) | null = null
  let accountOverviewPollTimer: ReturnType<typeof setInterval> | null = null

  const accounts = ref<UiAccountEntry[]>([])
  const activeAccount = computed(() => accounts.value.find(account => account.isActive))
  const directoryAccountRevision = ref(0)
  let hasAccountSnapshot = false
  const isRefreshingAccounts = ref(false)
  const isSwitchingAccounts = ref(false)
  const isCodexLoginModalOpen = ref(false)
  const isStartingCodexLogin = computed(() => isCodexLoginModalOpen.value)
  const loginIntent = ref<'add' | 'reauth'>('add')
  const loginTargetStorageId = ref('')
  const refreshingAccountId = ref('')
  const removingAccountId = ref('')
  const confirmingRemoveAccountId = ref('')
  const hoveredAccountId = ref('')
  const accountActionError = ref('')
  let accountStatePollTimer: ReturnType<typeof setInterval> | null = null
  let isAccountStatePollInFlight = false
  let externalCodexAuthAvailable = false
  let externalAuthImportAttempted = false
  const activeAccountStorageId = computed(() => accounts.value.find((account) => account.isActive)?.storageId ?? null)
  const loginTargetAccount = computed(() => accounts.value.find((account) => account.storageId === loginTargetStorageId.value) ?? null)
  const removedAccountIds = new Set<string>()
  let accountStateRevision = 0
  let accountActionsStopped = false
  let accountReadFlight: Promise<Awaited<ReturnType<typeof getAccounts>>> | null = null

  const stopIdentityWatch = watch(accounts, (next, previous) => {
    if (!hasAccountSnapshot) {
      hasAccountSnapshot = true
      return
    }
    const nextId = next.find(account => account.isActive)?.storageId || ''
    const previousId = previous.find(account => account.isActive)?.storageId || ''
    if (nextId !== previousId) directoryAccountRevision.value += 1
  })

  const stopQuotaWatch = watch(accounts, () => {
    if (typeof window === 'undefined') return
    const shouldPoll = accounts.value.some((account) => account.quotaStatus === 'loading')
    if (!shouldPoll) {
      if (accountStatePollTimer !== null) {
        clearInterval(accountStatePollTimer)
        accountStatePollTimer = null
      }
      return
    }
    if (accountStatePollTimer !== null) return
    accountStatePollTimer = setInterval(() => {
      if (isAccountStatePollInFlight) return
      isAccountStatePollInFlight = true
      void loadAccountsState({ silent: true }).finally(() => {
        isAccountStatePollInFlight = false
      })
    }, 1500)
  }, { deep: true })

  const stopImportWatch = watch(getRateLimitSnapshots, () => {
    void refreshExternalAuth()
  }, { deep: true })

  async function refreshExternalAuth(): Promise<boolean> {
    const isCurrent = captureAccountAction()
    const imported = await maybeImportExternalCodexAuthAccount()
    if (!imported || !isCurrent()) return false
    await workspace.refresh({
      includeSelectedThreadMessages: false,
      providerChanged: true,
      awaitAncillaryRefreshes: true,
    })
    return isCurrent()
  }

  async function maybeImportExternalCodexAuthAccount(): Promise<boolean> {
    const isCurrent = captureAccountAction()
    if (!isCurrent()) return false
    if (!externalCodexAuthAvailable) return false
    if (externalAuthImportAttempted) return false
    if (getSelectedProvider() !== 'codex') return false
    if (accounts.value.length > 0) return false
    if (getRateLimitSnapshots().length === 0) return false
    externalAuthImportAttempted = true
    const previousAccountsJson = JSON.stringify(accounts.value.map((account) => account.accountId).sort())
    try {
      const result = await refreshAccountsFromAuth()
      if (!isCurrent()) return false
      applyAccountsSnapshot(result.accounts)
    } catch {
      if (!isCurrent()) return false
      await loadAccountsState({ silent: true })
    }
    if (!isCurrent()) return false
    const nextAccountsJson = JSON.stringify(accounts.value.map((account) => account.accountId).sort())
    return previousAccountsJson !== nextAccountsJson
  }

  function isAccountActionDisabled(_account: UiAccountEntry): boolean {
    return accountActionsStopped || isSwitchingAccounts.value || isStartingCodexLogin.value || Boolean(removingAccountId.value)
  }

  function formatAccountStatus(account: UiAccountEntry): string {
    if (account.authStatus === 'reauth_required') return t('Sign-in required')
    if (account.authStatus === 'payment_required') return t('Payment required')
    if (account.authStatus === 'refreshing') return t('Refreshing…')
    if (account.authStatus === 'switching') return t('Switching…')
    if (account.authStatus === 'stale') return t('Verification stale')
    if (account.authStatus === 'transient_error') return t('Temporary error')
    if (account.authStatus === 'materialization_dirty') return t('Recovery required')
    return t('Ready')
  }

  function captureAccountAction(): () => boolean {
    // Identity mutations isolate all reads admitted before their commit.
    const revision = accountStateRevision
    return () => !accountActionsStopped && revision === accountStateRevision
  }

  function invalidateAccountReads(): void {
    accountStateRevision += 1
    accountReadFlight = null
  }

  function stopAccountActions(): void {
    if (accountActionsStopped) return
    stopIdentityWatch()
    stopQuotaWatch()
    stopImportWatch()
    unsubscribeQuota?.()
    unsubscribeQuota = null
    if (accountOverviewPollTimer !== null) clearInterval(accountOverviewPollTimer)
    accountOverviewPollTimer = null
    if (accountStatePollTimer !== null) clearInterval(accountStatePollTimer)
    accountStatePollTimer = null
    accountActionsStopped = true
    invalidateAccountReads()
    isRefreshingAccounts.value = false
    isSwitchingAccounts.value = false
    refreshingAccountId.value = ''
    removingAccountId.value = ''
    isCodexLoginModalOpen.value = false
  }

  function readAccountsSnapshot(): Promise<Awaited<ReturnType<typeof getAccounts>>> {
    if (!accountReadFlight) {
      const flight = getAccounts().finally(() => {
        if (accountReadFlight === flight) accountReadFlight = null
      })
      accountReadFlight = flight
    }
    return accountReadFlight
  }

  function applyAccountsSnapshot(next: UiAccountEntry[]): void {
    const current = new Map(accounts.value.map(account => [account.storageId, account]))
    accounts.value = next.filter(account => !removedAccountIds.has(account.storageId)).map(account => {
      const previous = current.get(account.storageId)
      if (!previous || !Number.isFinite(Date.parse(previous.quotaUpdatedAtIso || '')) || Date.parse(previous.quotaUpdatedAtIso || '') <= Date.parse(account.quotaUpdatedAtIso || '')) return account
      return { ...account, quotaSnapshot: previous.quotaSnapshot, quotaUpdatedAtIso: previous.quotaUpdatedAtIso, quotaStatus: previous.quotaStatus, quotaError: previous.quotaError, resetCredits: previous.resetCredits, planType: previous.planType }
    })
  }

  async function loadAccountsState(options: { silent?: boolean } = {}): Promise<void> {
    const isCurrent = captureAccountAction()
    if (!isCurrent()) return
    try {
      const result = await readAccountsSnapshot()
      if (!isCurrent()) return
      applyAccountsSnapshot(result.accounts)
      if (!result.accounts.some((account) => account.storageId === hoveredAccountId.value)) {
        hoveredAccountId.value = ''
      }
      if (!result.accounts.some((account) => account.storageId === confirmingRemoveAccountId.value)) {
        confirmingRemoveAccountId.value = ''
      }
    } catch (error) {
      if (!isCurrent()) return
      if (options.silent === true) return
      accountActionError.value = error instanceof Error ? error.message : t('Failed to load accounts')
    }
  }

  async function onRefreshAccounts(): Promise<void> {
    const isCurrent = captureAccountAction()
    if (!isCurrent()) return
    if (isRefreshingAccounts.value || isSwitchingAccounts.value || isStartingCodexLogin.value) return
    accountActionError.value = ''

    hoveredAccountId.value = ''
    confirmingRemoveAccountId.value = ''
    isRefreshingAccounts.value = true
    try {
      const result = await readAccountsSnapshot()
      if (!isCurrent()) return
      applyAccountsSnapshot(result.accounts)
      for (const account of result.accounts) {
        const refreshed = await refreshAccountQuota(account.storageId)
        if (!isCurrent()) return
        applyAccountsSnapshot(refreshed.accounts)
      }

    } catch (error) {
      if (!isCurrent()) return
      notifyOperation(error instanceof Error ? error.message : t('Failed to refresh accounts'))
    } finally {
      isRefreshingAccounts.value = false
    }
  }

  async function onRefreshAccountQuota(storageId: string): Promise<void> {
    const isCurrent = captureAccountAction()
    if (!isCurrent()) return
    if (isRefreshingAccounts.value || isSwitchingAccounts.value || isStartingCodexLogin.value || refreshingAccountId.value) return
    accountActionError.value = ''

    refreshingAccountId.value = storageId
    try {
      const result = await refreshAccountQuota(storageId)
      if (!isCurrent()) return
      applyAccountsSnapshot(result.accounts)
    } catch (error) {
      if (!isCurrent()) return
      notifyOperation(error instanceof Error ? error.message : t('Failed to refresh account quota'))
    } finally {
      refreshingAccountId.value = ''
    }
  }

  async function onSwitchAccount(storageId: string): Promise<void> {
    if (accountActionsStopped || isSwitchingAccounts.value || isStartingCodexLogin.value || removingAccountId.value) return
    invalidateAccountReads()
    let isCurrent = captureAccountAction()
    accountActionError.value = ''

    hoveredAccountId.value = ''
    confirmingRemoveAccountId.value = ''
    isSwitchingAccounts.value = true
    try {
      const switched = await switchAccount(storageId, activeAccountStorageId.value, workspace.getSelectedThreadId() || undefined)
      if (!isCurrent()) return
      await workspace.loadConnections()
      if (!isCurrent()) return
      invalidateAccountReads()
      isCurrent = captureAccountAction()
      workspace.invalidateModels()
      const nextActiveAccount = switched.account
      accounts.value = accounts.value.map((account) => (
        account.storageId === storageId
          ? nextActiveAccount
          : { ...account, isActive: false }
      ))
      workspace.restartPolling()
      await workspace.refresh({
        accountChanged: true,
        includeSelectedThreadMessages: true,
        awaitAncillaryRefreshes: true,
      })
      if (!isCurrent()) return
      await loadAccountsState({ silent: true })
      if (!isCurrent()) return
      notifyOperation('账号已切换', 'success')
    } catch (error) {
      if (!isCurrent()) return
      notifyOperation(error instanceof Error ? error.message : t('Failed to switch account'))
    } finally {
      isSwitchingAccounts.value = false
    }
  }

  function onStartCodexLogin(intent: 'add' | 'reauth', targetStorageId = ''): void {
    if (accountActionsStopped || isSwitchingAccounts.value || removingAccountId.value) return
    accountActionError.value = ''

    loginIntent.value = intent
    loginTargetStorageId.value = targetStorageId
    isCodexLoginModalOpen.value = true
  }

  function resumeAccountLogin(intent: 'add' | 'reauth', targetStorageId: string): void {
    if (accountActionsStopped) return
    loginIntent.value = intent
    loginTargetStorageId.value = targetStorageId
    isCodexLoginModalOpen.value = true
  }

  function onAccountLoginCompleted(result: AccountLoginCompleteResult): void {
    if (accountActionsStopped) return
    invalidateAccountReads()
    removedAccountIds.delete(result.account.storageId)
    applyAccountsSnapshot(result.accounts)
    isCodexLoginModalOpen.value = false
    loginTargetStorageId.value = ''
    workspace.restartPolling()
    notifyOperation(result.outcome === 'added' ? t('Account added.') : t('Account sign-in refreshed.'), 'success')
  }

  async function onRemoveAccount(storageId: string): Promise<void> {
    if (accountActionsStopped || removingAccountId.value || isSwitchingAccounts.value || isStartingCodexLogin.value) return
    const targetAccount = accounts.value.find((account) => account.storageId === storageId) ?? null
    if (!targetAccount) return
    if (confirmingRemoveAccountId.value !== storageId) {
      confirmingRemoveAccountId.value = storageId
      return
    }
    const removedWasActive = targetAccount.isActive
    invalidateAccountReads()
    const isCurrent = captureAccountAction()
    accountActionError.value = ''
    confirmingRemoveAccountId.value = ''
    removingAccountId.value = storageId
    try {
      const result = await removeAccount(storageId)
      if (!isCurrent()) return
      invalidateAccountReads()
      removedAccountIds.add(storageId)
      notifyOperation('账号已移除', 'success')
      applyAccountsSnapshot(result.accounts)
      workspace.restartPolling()
      if (removedWasActive) {
        void workspace.refresh({
          accountChanged: true,
          includeSelectedThreadMessages: true,
        })
      }
      void loadAccountsState({ silent: true })
    } catch (error) {
      if (!isCurrent()) return
      notifyOperation(error instanceof Error ? error.message : t('Failed to remove account'))
    } finally {
      removingAccountId.value = ''
    }
  }

  function start(): void {
    if (accountActionsStopped || accountOverviewPollTimer !== null) return
    unsubscribeQuota = subscribeAccountQuotaUpdates(updated => {
      if (accountActionsStopped) return
      accounts.value = accounts.value.map(account => account.storageId === updated.storageId
        ? { ...updated, isActive: account.isActive, canSwitch: account.canSwitch, actionRequired: account.actionRequired }
        : account)
    })
    accountOverviewPollTimer = setInterval(() => {
      if (document.hidden || isAccountStatePollInFlight || isRefreshingAccounts.value) return
      isAccountStatePollInFlight = true
      void loadAccountsState({ silent: true }).finally(() => { isAccountStatePollInFlight = false })
    }, 60_000)
  }

  function setExternalAuthAvailable(available: boolean): void {
    if (accountActionsStopped) return
    externalCodexAuthAvailable = available
    if (!available) externalAuthImportAttempted = false
  }

  function closeAccountLogin(): void {
    isCodexLoginModalOpen.value = false
  }

  return {
    accounts: computed(() => accounts.value), activeAccount, directoryAccountRevision: computed(() => directoryAccountRevision.value),
    isAccountPanelBusy: computed(() => isSwitchingAccounts.value || isStartingCodexLogin.value || Boolean(removingAccountId.value)),
    isRefreshingAccounts: computed(() => isRefreshingAccounts.value), isSwitchingAccounts: computed(() => isSwitchingAccounts.value),
    isStartingCodexLogin, isCodexLoginModalOpen: computed(() => isCodexLoginModalOpen.value),
    loginIntent: computed(() => loginIntent.value), loginTargetStorageId: computed(() => loginTargetStorageId.value), loginTargetAccount,
    confirmingRemoveAccountId: computed(() => confirmingRemoveAccountId.value), accountActionError: computed(() => accountActionError.value),
    loadAccountsState, onRefreshAccounts, onRefreshAccountQuota, onSwitchAccount, onStartCodexLogin,
    resumeAccountLogin, onAccountLoginCompleted, onRemoveAccount, isAccountActionDisabled, formatAccountStatus,
    refreshExternalAuth, setExternalAuthAvailable, closeAccountLogin, start, stop: stopAccountActions,
  }
}

export function useAppAccountsController(options: AppAccountsControllerOptions) {
  const controller = createAppAccountsController(options)
  onMounted(controller.start)
  onBeforeUnmount(controller.stop)
  return controller
}
