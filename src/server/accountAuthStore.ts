import { normalizeResetCredits, type ResetCredits } from '../accountResetCredits.js'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const ACCOUNT_STATE_SCHEMA_VERSION = 2

export type AccountAuthStatus =
  | 'ready'
  | 'refreshing'
  | 'switching'
  | 'reauth_required'
  | 'payment_required'
  | 'stale'
  | 'transient_error'
  | 'materialization_dirty'

export type AccountQuotaStatus = 'idle' | 'loading' | 'ready' | 'error'
export type AccountUnavailableReason = 'payment_required' | 'reauth_required'

export type StoredRateLimitWindow = {
  usedPercent: number
  windowMinutes: number | null
  resetsAt: number | null
}

export type StoredCreditsSnapshot = {
  hasCredits: boolean
  unlimited: boolean
  balance: string | null
}

export type StoredRateLimitSnapshot = {
  limitId: string | null
  limitName: string | null
  primary: StoredRateLimitWindow | null
  secondary: StoredRateLimitWindow | null
  credits: StoredCreditsSnapshot | null
  planType: string | null
}

export type StoredAccountEntry = {
  alias?: string
  accountId: string
  storageId: string
  userId: string | null
  authMode: string | null
  email: string | null
  planType: string | null
  credentialRevision: number
  authStatus: AccountAuthStatus
  lastRefreshedAtIso: string
  lastVerifiedAtIso: string | null
  lastActivatedAtIso: string | null
  protectionPercent?: number
  resetCredits?: ResetCredits | null
  lastResetUsedAtIso?: string | null
  quotaSnapshot: StoredRateLimitSnapshot | null
  quotaUpdatedAtIso: string | null
  quotaStatus: AccountQuotaStatus
  quotaError: string | null
  unavailableReason: AccountUnavailableReason | null
}

export type StoredAccountsState = {
  schemaVersion: number
  operationEpoch: number
  activeAccountId: string | null
  activeStorageId: string | null
  accounts: StoredAccountEntry[]
}

export type CodexAuthFile = {
  auth_mode?: string
  last_refresh?: number
  tokens?: {
    access_token?: string
    refresh_token?: string
    id_token?: string
    account_id?: string
  }
  [key: string]: unknown
}

export type AccountIdentity = {
  accountId: string
  storageId: string
  userId: string | null
  email: string | null
  planType: string | null
  authMode: string | null
}

export type ParsedAccountCredential = {
  raw: string
  auth: CodexAuthFile
  identity: AccountIdentity
}

export class AccountStoreError extends Error {
  constructor(
    public readonly code:
      | 'invalid_auth_json'
      | 'missing_account_id'
      | 'missing_access_token'
      | 'missing_refresh_token'
      | 'account_identity_mismatch'
      | 'account_not_found'
      | 'credential_revision_conflict'
      | 'storage_id_conflict',
    message: string,
  ) {
    super(message)
    this.name = 'AccountStoreError'
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const encoded = token.split('.')[1]
  if (!encoded) return null
  try {
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/')
    const padded = `${normalized}${'='.repeat((4 - normalized.length % 4) % 4)}`
    return asRecord(JSON.parse(Buffer.from(padded, 'base64').toString('utf8')))
  } catch {
    return null
  }
}

function extractTokenMetadata(accessToken: string): Pick<AccountIdentity, 'userId' | 'email' | 'planType'> {
  const payload = decodeJwtPayload(accessToken)
  const profile = asRecord(payload?.['https://api.openai.com/profile'])
  const auth = asRecord(payload?.['https://api.openai.com/auth'])
  return {
    userId: readString(auth?.user_id ?? auth?.userId),
    email: readString(profile?.email),
    planType: readString(auth?.chatgpt_plan_type ?? auth?.chatgptPlanType),
  }
}

export function accountStorageId(accountId: string, userId: string | null): string {
  return createHash('sha256').update(userId ? `${accountId}\u0000${userId}` : accountId).digest('hex')
}

export function parseAccountCredential(raw: string, options: { requireRefreshToken?: boolean } = {}): ParsedAccountCredential {
  let auth: CodexAuthFile
  try {
    const parsed = JSON.parse(raw) as unknown
    const record = asRecord(parsed)
    if (!record) throw new Error('not_object')
    auth = record as CodexAuthFile
  } catch {
    throw new AccountStoreError('invalid_auth_json', 'The account credential file is not valid JSON.')
  }

  const accountId = readString(auth.tokens?.account_id)
  if (!accountId) throw new AccountStoreError('missing_account_id', 'The account credential is missing its account identity.')
  const accessToken = readString(auth.tokens?.access_token)
  if (!accessToken) throw new AccountStoreError('missing_access_token', 'The account credential is missing an access token.')
  if (options.requireRefreshToken && !readString(auth.tokens?.refresh_token)) {
    throw new AccountStoreError('missing_refresh_token', 'The account credential must be renewed from the account panel.')
  }

  const metadata = extractTokenMetadata(accessToken)
  return {
    raw,
    auth,
    identity: {
      accountId,
      storageId: accountStorageId(accountId, metadata.userId),
      userId: metadata.userId,
      email: metadata.email,
      planType: metadata.planType,
      authMode: readString(auth.auth_mode),
    },
  }
}

function normalizeRateLimitWindow(value: unknown): StoredRateLimitWindow | null {
  const record = asRecord(value)
  const usedPercent = readNumber(record?.usedPercent ?? record?.used_percent)
  if (usedPercent === null) return null
  return {
    usedPercent,
    windowMinutes: readNumber(record?.windowMinutes ?? record?.windowDurationMins ?? record?.window_minutes),
    resetsAt: readNumber(record?.resetsAt ?? record?.resets_at),
  }
}

function normalizeRateLimitSnapshot(value: unknown): StoredRateLimitSnapshot | null {
  const record = asRecord(value)
  if (!record) return null
  const creditsRecord = asRecord(record.credits)
  const hasCredits = readBoolean(creditsRecord?.hasCredits ?? creditsRecord?.has_credits)
  const unlimited = readBoolean(creditsRecord?.unlimited)
  const credits = hasCredits === null || unlimited === null ? null : {
    hasCredits,
    unlimited,
    balance: readString(creditsRecord?.balance),
  }
  const primary = normalizeRateLimitWindow(record.primary)
  const secondary = normalizeRateLimitWindow(record.secondary)
  if (!primary && !secondary && !credits) return null
  return {
    limitId: readString(record.limitId ?? record.limit_id),
    limitName: readString(record.limitName ?? record.limit_name),
    primary,
    secondary,
    credits,
    planType: readString(record.planType ?? record.plan_type),
  }
}

export function normalizeRateLimitPayload(value: unknown): StoredRateLimitSnapshot | null {
  const record = asRecord(value)
  if (!record) return null
  const byLimitId = asRecord(record.rateLimitsByLimitId ?? record.rate_limits_by_limit_id)
  return normalizeRateLimitSnapshot(byLimitId?.codex)
    ?? normalizeRateLimitSnapshot(record.rateLimits ?? record.rate_limits)
    ?? normalizeRateLimitSnapshot(record)
}

function normalizeAuthStatus(value: unknown, unavailableReason: AccountUnavailableReason | null): AccountAuthStatus {
  const status = readString(value)
  const allowed: AccountAuthStatus[] = [
    'ready', 'refreshing', 'switching', 'reauth_required', 'payment_required', 'stale', 'transient_error', 'materialization_dirty',
  ]
  if (status && allowed.includes(status as AccountAuthStatus)) return status as AccountAuthStatus
  if (unavailableReason === 'payment_required') return 'payment_required'
  if (unavailableReason === 'reauth_required') return 'reauth_required'
  return 'ready'
}

function normalizeEntry(value: unknown): StoredAccountEntry | null {
  const record = asRecord(value)
  const accountId = readString(record?.accountId)
  const storageId = readString(record?.storageId)
  if (!accountId || !storageId) return null
  const quotaStatusRaw = readString(record?.quotaStatus)
  const quotaStatus: AccountQuotaStatus = quotaStatusRaw === 'loading' || quotaStatusRaw === 'ready' || quotaStatusRaw === 'error'
    ? quotaStatusRaw
    : 'idle'
  const unavailableRaw = readString(record?.unavailableReason)
  const unavailableReason: AccountUnavailableReason | null = unavailableRaw === 'payment_required' || unavailableRaw === 'reauth_required'
    ? unavailableRaw
    : null
  return {
    accountId,
    storageId,
    alias: readString(record?.alias) ?? '',
    userId: readString(record?.userId),
    authMode: readString(record?.authMode),
    email: readString(record?.email),
    planType: readString(record?.planType),
    credentialRevision: Math.max(0, Math.trunc(readNumber(record?.credentialRevision) ?? 0)),
    authStatus: normalizeAuthStatus(record?.authStatus, unavailableReason),
    lastRefreshedAtIso: readString(record?.lastRefreshedAtIso) ?? new Date(0).toISOString(),
    lastVerifiedAtIso: readString(record?.lastVerifiedAtIso),
    lastActivatedAtIso: readString(record?.lastActivatedAtIso),
    quotaSnapshot: normalizeRateLimitSnapshot(record?.quotaSnapshot),
    resetCredits: normalizeResetCredits(record?.resetCredits),
    lastResetUsedAtIso: typeof record?.lastResetUsedAtIso === 'string' ? record.lastResetUsedAtIso : null,
    protectionPercent: Math.max(0, Math.min(100, readNumber(record?.protectionPercent) ?? 0)),
    quotaUpdatedAtIso: readString(record?.quotaUpdatedAtIso),
    quotaStatus,
    quotaError: readString(record?.quotaError),
    unavailableReason,
  }
}

function emptyState(): StoredAccountsState {
  return {
    schemaVersion: ACCOUNT_STATE_SCHEMA_VERSION,
    operationEpoch: 0,
    activeAccountId: null,
    activeStorageId: null,
    accounts: [],
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export class AccountAuthStore {
  readonly codexHome: string
  readonly accountsRoot: string
  readonly statePath: string
  readonly activeAuthPath: string
  private mutationChain: Promise<unknown> = Promise.resolve()

  constructor(codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')) {
    this.codexHome = codexHome
    this.accountsRoot = join(codexHome, 'accounts')
    this.statePath = join(codexHome, 'accounts.json')
    this.activeAuthPath = join(codexHome, 'auth.json')
  }

  credentialPath(storageId: string): string {
    return join(this.accountsRoot, storageId, 'auth.json')
  }

  pendingHome(loginSessionId: string): string {
    return join(this.accountsRoot, '.pending', loginSessionId)
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.codexHome, { recursive: true, mode: 0o700 })
    await mkdir(this.accountsRoot, { recursive: true, mode: 0o700 })
    await chmod(this.accountsRoot, 0o700)
  }

  async atomicWrite(path: string, raw: string, mode = 0o600): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await chmod(dirname(path), 0o700)
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
    try {
      await writeFile(temporary, raw, { encoding: 'utf8', mode })
      await chmod(temporary, mode)
      await rename(temporary, path)
      await chmod(path, mode)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  async readCredential(storageId: string, options: { requireRefreshToken?: boolean } = {}): Promise<ParsedAccountCredential> {
    let raw: string
    try {
      raw = await readFile(this.credentialPath(storageId), 'utf8')
    } catch {
      throw new AccountStoreError('account_not_found', 'The account credential profile is missing.')
    }
    const parsed = parseAccountCredential(raw, options)
    if (parsed.identity.storageId !== storageId) {
      throw new AccountStoreError('storage_id_conflict', 'The account credential identity does not match its storage profile.')
    }
    return parsed
  }

  async readActiveCredential(): Promise<ParsedAccountCredential | null> {
    try {
      return parseAccountCredential(await readFile(this.activeAuthPath, 'utf8'))
    } catch (error) {
      if (error instanceof AccountStoreError) throw error
      return null
    }
  }

  async writeCredential(storageId: string, raw: string): Promise<ParsedAccountCredential> {
    const parsed = parseAccountCredential(raw)
    if (parsed.identity.storageId !== storageId) {
      throw new AccountStoreError('storage_id_conflict', 'Refusing to write a credential into another account profile.')
    }
    await this.ensureRoot()
    await this.atomicWrite(this.credentialPath(storageId), raw)
    return parsed
  }

  async materializeActive(storageId: string): Promise<ParsedAccountCredential> {
    return this.updateState(async state => {
      if (!state.accounts.some(account => account.storageId === storageId)) throw new AccountStoreError('account_not_found', '账号已移除。')
      const parsed = await this.readCredential(storageId)
      await this.atomicWrite(this.activeAuthPath, parsed.raw)
      return { state, result: parsed }
    })
  }

  async restoreActive(raw: string | null): Promise<void> {
    if (raw === null) {
      await rm(this.activeAuthPath, { force: true })
      return
    }
    parseAccountCredential(raw)
    await this.atomicWrite(this.activeAuthPath, raw)
  }

  async createPendingHome(): Promise<{ loginSessionId: string; home: string }> {
    await this.ensureRoot()
    const loginSessionId = randomUUID()
    const home = this.pendingHome(loginSessionId)
    await mkdir(join(this.accountsRoot, '.pending'), { recursive: true, mode: 0o700 })
    await chmod(join(this.accountsRoot, '.pending'), 0o700)
    await mkdir(home, { recursive: false, mode: 0o700 })
    await chmod(home, 0o700)
    return { loginSessionId, home }
  }

  async removePendingHome(loginSessionId: string): Promise<void> {
    if (!/^[a-f0-9-]{36}$/i.test(loginSessionId)) return
    await rm(this.pendingHome(loginSessionId), { recursive: true, force: true })
  }

  async readState(): Promise<StoredAccountsState> {
    let parsed: Record<string, unknown> | null = null
    try {
      parsed = asRecord(JSON.parse(await readFile(this.statePath, 'utf8')))
    } catch {
      parsed = null
    }
    let accounts = (Array.isArray(parsed?.accounts) ? parsed.accounts : [])
      .map(normalizeEntry)
      .filter((entry): entry is StoredAccountEntry => entry !== null)
    let discoveredCredentials = false
    const accountsByStorageId = new Map(accounts.map((entry) => [entry.storageId, entry]))
    for (const currentStorageId of await this.listCredentialStorageIds()) {
      try {
        const credentialPath = this.credentialPath(currentStorageId)
        const credential = parseAccountCredential(await readFile(credentialPath, 'utf8'))
        const nextStorageId = credential.identity.storageId
        if (nextStorageId !== currentStorageId) {
          const targetPath = join(this.accountsRoot, nextStorageId)
          if (!await pathExists(targetPath)) {
            await rename(join(this.accountsRoot, currentStorageId), targetPath)
          } else {
            const target = parseAccountCredential(await readFile(this.credentialPath(nextStorageId), 'utf8'))
            if (target.identity.accountId !== credential.identity.accountId || target.identity.userId !== credential.identity.userId) {
              continue
            }
            await rm(join(this.accountsRoot, currentStorageId), { recursive: true, force: true })
          }
        }
        const existing = accountsByStorageId.get(nextStorageId)
          ?? accounts.find((entry) => entry.accountId === credential.identity.accountId && entry.userId === credential.identity.userId)
        const modifiedAt = (await stat(this.credentialPath(nextStorageId))).mtime.toISOString()
        accountsByStorageId.delete(currentStorageId)
        accountsByStorageId.set(nextStorageId, {
          accountId: credential.identity.accountId,
          storageId: nextStorageId,
          userId: credential.identity.userId,
          authMode: credential.identity.authMode,
          email: credential.identity.email ?? existing?.email ?? null,
          alias: existing?.alias ?? '',
          planType: existing?.planType ?? credential.identity.planType ?? null,
          credentialRevision: Math.max(1, existing?.credentialRevision ?? 0),
          authStatus: existing?.authStatus ?? 'ready',
          lastRefreshedAtIso: existing?.lastRefreshedAtIso ?? modifiedAt,
          lastVerifiedAtIso: existing?.lastVerifiedAtIso ?? null,
          lastActivatedAtIso: existing?.lastActivatedAtIso ?? null,
          quotaSnapshot: existing?.quotaSnapshot ?? null,
          resetCredits: existing?.resetCredits ?? null,
          lastResetUsedAtIso: existing?.lastResetUsedAtIso ?? null,
          protectionPercent: existing?.protectionPercent ?? 0,
          quotaUpdatedAtIso: existing?.quotaUpdatedAtIso ?? null,
          quotaStatus: existing?.quotaStatus ?? 'idle',
          quotaError: existing?.quotaError ?? null,
          unavailableReason: existing?.unavailableReason ?? null,
        })
        if (!existing || nextStorageId !== currentStorageId) discoveredCredentials = true
      } catch {
        // Keep corrupt profiles out of the public account pool without deleting them.
      }
    }
    accounts = Array.from(accountsByStorageId.values())
    try {
      const activeCredential = await this.readActiveCredential()
      if (activeCredential && !accounts.some((entry) => entry.storageId === activeCredential.identity.storageId)) {
        await this.writeCredential(activeCredential.identity.storageId, activeCredential.raw)
        const now = new Date().toISOString()
        accounts.push({
          accountId: activeCredential.identity.accountId,
          storageId: activeCredential.identity.storageId,
          userId: activeCredential.identity.userId,
          authMode: activeCredential.identity.authMode,
          email: activeCredential.identity.email,
          alias: '',
          planType: activeCredential.identity.planType,
          credentialRevision: 1,
          authStatus: 'ready',
          lastRefreshedAtIso: now,
          lastVerifiedAtIso: null,
          lastActivatedAtIso: now,
          quotaSnapshot: null,
          quotaUpdatedAtIso: null,
          quotaStatus: 'idle',
          quotaError: null,
          unavailableReason: null,
        })
        discoveredCredentials = true
      }
    } catch {
      // Invalid active auth remains untouched and is reported only when an operation needs it.
    }
    const rawActiveStorageId = readString(parsed?.activeStorageId)
    let activeStorageId = rawActiveStorageId && accounts.some((entry) => entry.storageId === rawActiveStorageId)
      ? rawActiveStorageId
      : null

    if (!activeStorageId) {
      try {
        const active = await this.readActiveCredential()
        if (active && accounts.some((entry) => entry.storageId === active.identity.storageId)) {
          activeStorageId = active.identity.storageId
        }
      } catch {
        activeStorageId = null
      }
    }
    const active = activeStorageId ? accounts.find((entry) => entry.storageId === activeStorageId) ?? null : null
    const state: StoredAccountsState = {
      schemaVersion: ACCOUNT_STATE_SCHEMA_VERSION,
      operationEpoch: Math.max(0, Math.trunc(readNumber(parsed?.operationEpoch) ?? 0)),
      activeAccountId: active?.accountId ?? null,
      activeStorageId: active?.storageId ?? null,
      accounts,
    }
    const needsMigration = discoveredCredentials || (parsed !== null && (
      readNumber(parsed.schemaVersion) !== ACCOUNT_STATE_SCHEMA_VERSION
      || accounts.some((entry) => entry.credentialRevision === 0)
      || readString(parsed.activeAccountId) !== state.activeAccountId
      || rawActiveStorageId !== state.activeStorageId
    ))
    if (needsMigration) {
      state.accounts = accounts.map((entry) => ({
        ...entry,
        credentialRevision: Math.max(1, entry.credentialRevision),
      }))
      await this.writeState(state)
    }
    return state
  }

  async writeState(state: StoredAccountsState): Promise<void> {
    await this.ensureRoot()
    const active = state.activeStorageId
      ? state.accounts.find((entry) => entry.storageId === state.activeStorageId) ?? null
      : null
    const normalized: StoredAccountsState = {
      schemaVersion: ACCOUNT_STATE_SCHEMA_VERSION,
      operationEpoch: Math.max(0, Math.trunc(state.operationEpoch)),
      activeAccountId: active?.accountId ?? null,
      activeStorageId: active?.storageId ?? null,
      accounts: state.accounts,
    }
    await this.atomicWrite(this.statePath, `${JSON.stringify(normalized, null, 2)}\n`)
  }

  async updateState<T>(update: (state: StoredAccountsState) => Promise<{ state: StoredAccountsState; result: T }> | { state: StoredAccountsState; result: T }): Promise<T> {
    const run = this.mutationChain.then(async () => {
      const current = await this.readState()
      const next = await update(current)
      await this.writeState(next.state)
      return next.result
    })
    this.mutationChain = run.catch(() => undefined)
    return run
  }

  async upsertCredential(raw: string, options: {
    expectedStorageId?: string | null
    expectedRevision?: number | null
    activate?: boolean
    materializeIfActive?: boolean
    authStatus?: AccountAuthStatus
  } = {}): Promise<{ account: StoredAccountEntry; outcome: 'added' | 'reauthenticated'; state: StoredAccountsState }> {
    const parsed = parseAccountCredential(raw)
    if (options.expectedStorageId && parsed.identity.storageId !== options.expectedStorageId) {
      throw new AccountStoreError('account_identity_mismatch', 'The signed-in account does not match the selected account.')
    }
    return await this.updateState(async (state) => {
      const existing = state.accounts.find((entry) => entry.storageId === parsed.identity.storageId) ?? null
      if (options.expectedRevision !== null && options.expectedRevision !== undefined && existing?.credentialRevision !== options.expectedRevision) {
        throw new AccountStoreError('credential_revision_conflict', 'The account credential changed while this operation was running.')
      }
      await this.writeCredential(parsed.identity.storageId, parsed.raw)
      const now = new Date().toISOString()
      const account: StoredAccountEntry = {
        accountId: parsed.identity.accountId,
        storageId: parsed.identity.storageId,
        userId: parsed.identity.userId,
        authMode: parsed.identity.authMode,
        email: parsed.identity.email ?? existing?.email ?? null,
        alias: existing?.alias ?? '',
        planType: parsed.identity.planType ?? existing?.planType ?? null,
        credentialRevision: (existing?.credentialRevision ?? 0) + 1,
        authStatus: options.authStatus ?? 'ready',
        lastRefreshedAtIso: now,
        lastVerifiedAtIso: existing?.lastVerifiedAtIso ?? null,
        lastActivatedAtIso: existing?.lastActivatedAtIso ?? null,
        quotaSnapshot: existing?.quotaSnapshot ?? null,
        resetCredits: existing?.resetCredits ?? null,
        lastResetUsedAtIso: existing?.lastResetUsedAtIso ?? null,
        protectionPercent: existing?.protectionPercent ?? 0,
        quotaUpdatedAtIso: existing?.quotaUpdatedAtIso ?? null,
        quotaStatus: existing?.quotaStatus ?? 'idle',
        quotaError: null,
        unavailableReason: null,
      }
      const accounts = [account, ...state.accounts.filter((entry) => entry.storageId !== account.storageId)]
      const activeStorageId = options.activate ? account.storageId : state.activeStorageId
      const nextState: StoredAccountsState = {
        ...state,
        activeStorageId,
        activeAccountId: activeStorageId === account.storageId
          ? account.accountId
          : state.activeAccountId,
        accounts,
      }
      if (options.activate || (options.materializeIfActive && state.activeStorageId === account.storageId)) {
        await this.atomicWrite(this.activeAuthPath, parsed.raw)
      }
      return {
        state: nextState,
        result: { account, outcome: existing ? 'reauthenticated' as const : 'added' as const, state: nextState },
      }
    })
  }

  async removeCredential(storageId: string): Promise<void> {
    await rm(join(this.accountsRoot, storageId), { recursive: true, force: true })
  }

  async deleteAccount(storageId: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(storageId)) throw new AccountStoreError('storage_id_conflict', '账号标识无效。')
    await this.updateState(async state => {
      const active = await this.readActiveCredential()
      if (state.activeStorageId === storageId || active?.identity.storageId === storageId) await this.restoreActive(null)
      await this.removeCredential(storageId)
      return { state: { ...state, operationEpoch: state.operationEpoch + 1,
        activeStorageId: state.activeStorageId === storageId ? null : state.activeStorageId,
        activeAccountId: state.activeStorageId === storageId ? null : state.activeAccountId,
        accounts: state.accounts.filter(account => account.storageId !== storageId),
      }, result: undefined }
    })
  }

  async listCredentialStorageIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.accountsRoot, { withFileTypes: true })
      return entries.filter((entry) => entry.isDirectory() && entry.name !== '.pending').map((entry) => entry.name)
    } catch {
      return []
    }
  }

  async credentialExists(storageId: string): Promise<boolean> {
    return await pathExists(this.credentialPath(storageId))
  }
}

export function createEmptyAccountState(): StoredAccountsState {
  return emptyState()
}
