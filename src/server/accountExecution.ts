/** Shared account selection and connection ownership. Never stores credentials. */
export type AccountExecutionKind = 'primary' | 'automation' | 'api' | 'activation'
export type AccountSelection = { storageId: string; followsPrimary: boolean }
export class AccountExecutionError extends Error {
  readonly statusCode = 409
  constructor(readonly code: string, message: string) { super(message) }
}
export function resolveAccountSelection(
  state: { activeStorageId: string | null; accounts: { storageId: string }[] },
  selection: { accountStorageId?: string | null; defaultStorageId?: string | null } = {},
): AccountSelection {
  const explicit = selection.accountStorageId || selection.defaultStorageId
  const storageId = explicit || state.activeStorageId
  if (!storageId || !state.accounts.some(account => account.storageId === storageId)) {
    throw new AccountExecutionError('account_not_found', explicit ? '绑定账号已移除，请重新选择账号。' : '请先登录并选择账号。')
  }
  return { storageId, followsPrimary: !explicit }
}
export type AccountExecutionLease = {
  readonly storageId: string
  readonly signal: AbortSignal
  assertCurrent(): void
  setBusy(busy: boolean): void
  release(): void
}
type Entry = {
  id: number; storageId: string; kind: AccountExecutionKind; ownerId: string
  busy: boolean; protected: boolean; controller: AbortController; disconnect: () => void
}
export class AccountExecutionRegistry {
  private nextId = 1
  private revision = 0
  private readonly removed = new Map<string, number>()
  private readonly reopened = new Set<string>()
  private readonly entries = new Map<number, Entry>()
  generation(): number { return this.revision }
  removedAfter(storageId: string, revision: number): boolean { return (this.removed.get(storageId) || 0) > revision }
  isRemoved(storageId: string): boolean { return this.removed.has(storageId) && !this.reopened.has(storageId) }
  reopen(storageId: string): void { this.reopened.add(storageId) }
  assertAvailable(storageId: string): void {
    if (this.isRemoved(storageId)) throw new AccountExecutionError('account_removed', '账号已移除，关联连接已关闭。')
  }
  register(input: { storageId: string; kind: AccountExecutionKind; ownerId: string; protected?: boolean; busy?: boolean; disconnect: () => void }): AccountExecutionLease {
    this.assertAvailable(input.storageId)
    const id = this.nextId++
    const entry: Entry = { ...input, id, protected: input.protected === true, busy: input.busy !== false, controller: new AbortController() }
    this.entries.set(id, entry)
    if (entry.busy && entry.kind !== 'activation') this.yieldActivations(entry.storageId)
    return {
      storageId: input.storageId,
      signal: entry.controller.signal,
      assertCurrent: () => {
        if (entry.controller.signal.aborted) throw new AccountExecutionError('account_disconnected', '执行连接已关闭，请重新发起请求。')
        this.assertAvailable(input.storageId)
      },
      setBusy: busy => {
        entry.busy = busy
        if (busy && entry.kind !== 'activation') this.yieldActivations(entry.storageId)
      },
      release: () => { this.entries.delete(id) },
    }
  }
  private yieldActivations(storageId: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.storageId !== storageId || entry.kind !== 'activation') continue
      this.entries.delete(id)
      entry.controller.abort()
      try { entry.disconnect() }
      catch { /* Optional activation cannot block normal work. */ }
    }
  }
  revoke(storageId: string): void {
    this.removed.set(storageId, ++this.revision)
    this.reopened.delete(storageId)
    for (const [id, entry] of this.entries) {
      if (entry.storageId !== storageId) continue
      this.entries.delete(id)
      entry.controller.abort()
      // Disconnect adapters only close their owned transport; no network wait.
      try { entry.disconnect() }
      catch { /* One failed transport cleanup must not preserve other connections. */ }
    }
  }
  busyAccounts(): string[] { return [...new Set([...this.entries.values()].filter(entry => entry.busy).map(entry => entry.storageId))] }
  snapshot(): { storageId: string; kind: AccountExecutionKind; ownerId: string; busy: boolean; protected: boolean }[] {
    return [...this.entries.values()].map(({ storageId, kind, ownerId, busy, protected: protection }) => ({ storageId, kind, ownerId, busy, protected: protection }))
  }
}
