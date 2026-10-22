import { invalidateThreadResumeCache } from '../api/threadReadGateway'
import { CODEX_CLI_MISSING_MESSAGE, isCodexCliMissingError } from '../api/codexErrors'

export type DesktopRefreshOptions = {
  includeSelectedThreadMessages?: boolean
  awaitAncillaryRefreshes?: boolean
  providerChanged?: boolean
  forceThreadRefresh?: boolean
  accountChanged?: boolean
  includeThreads?: boolean
}

type AncillaryOptions = { providerChanged?: boolean; includeProviderModels: boolean }
type AccountInvalidation = { invalidateForAccountChange: () => void }
type DesktopRefreshControllerOptions = {
  getSelectedThreadId: () => string
  getErrorThreadIds: () => string[]
  setPageError: (message: string) => void
  setCliMissingError: (message: string) => void
  metadata: AccountInvalidation & {
    invalidateQuotaCache: () => void
    refresh: (options: AncillaryOptions) => Promise<void>
    scheduleRefresh: (options: AncillaryOptions) => void
  }
  send: AccountInvalidation
  pending: AccountInvalidation
  synchronization: AccountInvalidation
  queue: AccountInvalidation & { loadPersistedStateIfNeeded: () => Promise<void> }
  completion: { resetAcknowledgements: () => void }
  mutation: AccountInvalidation
  model: AccountInvalidation & { invalidateCatalog: () => void }
  list: { resetForAccountChange: () => void; load: (options: { force: boolean }) => Promise<void> }
  history: { invalidateForAccountChange: (threadIds: string[]) => void; load: (threadId: string) => Promise<unknown> }
}

export function createDesktopRefreshController({
  getSelectedThreadId, getErrorThreadIds, setPageError, setCliMissingError,
  metadata, send, pending, synchronization, queue, completion, mutation, model, list, history,
}: DesktopRefreshControllerOptions) {
  let accountIdentityRevision = 0
  let threadReadLifecycleRevision = 0

  async function refreshAll(options: DesktopRefreshOptions = {}) {
    setPageError('')
    setCliMissingError('')
    if (options.accountChanged) {
      accountIdentityRevision++
      metadata.invalidateForAccountChange()
      send.invalidateForAccountChange()
      pending.invalidateForAccountChange()
      synchronization.invalidateForAccountChange()
      queue.invalidateForAccountChange()
      completion.resetAcknowledgements()
      mutation.invalidateForAccountChange()
      model.invalidateForAccountChange()
      list.resetForAccountChange()
      invalidateThreadResumeCache()
      model.invalidateCatalog()
      metadata.invalidateQuotaCache()
      history.invalidateForAccountChange([...getErrorThreadIds(), getSelectedThreadId()])
    }
    if (options.providerChanged) {
      model.invalidateCatalog()
      metadata.invalidateQuotaCache()
    }
    const includeSelectedThreadMessages = options.includeSelectedThreadMessages !== false
    const awaitAncillaryRefreshes = options.awaitAncillaryRefreshes === true
    const identityRevision = accountIdentityRevision
    const lifecycleRevision = threadReadLifecycleRevision
    const isCurrent = () => identityRevision === accountIdentityRevision && lifecycleRevision === threadReadLifecycleRevision

    try {
      await queue.loadPersistedStateIfNeeded()
      if (!isCurrent()) return
      if (options.includeThreads !== false) await list.load({ force: options.forceThreadRefresh === true })
      if (!isCurrent()) return
      if (includeSelectedThreadMessages) {
        try {
          await history.load(getSelectedThreadId())
        } catch (unknownError) {
          if (!isCurrent()) return
          setPageError(unknownError instanceof Error ? unknownError.message : 'Unknown application error')
        }
      }
      if (!isCurrent()) return
      if (awaitAncillaryRefreshes) {
        await metadata.refresh({
          providerChanged: options.providerChanged,
          includeProviderModels: options.providerChanged === true || awaitAncillaryRefreshes,
        })
      } else {
        metadata.scheduleRefresh({
          providerChanged: options.providerChanged,
          includeProviderModels: false,
        })
      }
    } catch (unknownError) {
      if (!isCurrent()) return
      setPageError(unknownError instanceof Error ? unknownError.message : 'Unknown application error')
      if (isCodexCliMissingError(unknownError)) {
        setCliMissingError(CODEX_CLI_MISSING_MESSAGE)
      } else {
        setCliMissingError('')
      }
    }
  }

  function invalidateReads(): void {
    threadReadLifecycleRevision++
  }

  return {
    getAccountRevision: () => accountIdentityRevision,
    invalidateReads,
    refreshAll,
  }
}
