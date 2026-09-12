import { AccountExecutionRegistry } from './accountExecution.js'
import { normalizeResetCredits } from '../accountResetCredits.js'
import { mergeQuotaUpdate, quotaRetryDelay } from '../quotaRefresh.js'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { readFile, stat } from 'node:fs/promises'
import { resolveCodexCommand } from '../commandResolution.js'
import { getSpawnInvocation } from '../utils/commandInvocation.js'
import { AccountAppServerProbe, type AccountProbeInspection } from './accountAppServerProbe.js'
import {
  AccountAuthStore,
  AccountStoreError,
  normalizeRateLimitPayload,
  parseAccountCredential,
  type AccountAuthStatus,
  type StoredAccountEntry,
  type StoredAccountsState,
} from './accountAuthStore.js'
import { accessTokenExpiresAt, classifyAccountAuthError, refreshChatgptAccountCredential, type ChatgptAuthTokensRefreshParams, type ChatgptAuthTokensRefreshResponse } from './accountTokenRefresh.js'

const LOGIN_URL_TIMEOUT_MS = 15_000
const LOGIN_CALLBACK_TIMEOUT_MS = 20_000
const LOGIN_AUTH_FILE_TIMEOUT_MS = 10_000
const ACCOUNT_INSPECTION_TIMEOUT_MS = 25_000
const ACCOUNT_QUOTA_REFRESH_TTL_MS = 5 * 60_000

export type RuntimeQuiescenceSnapshot = {
  idle: boolean
  activeTurnThreadIds: string[]
  queuedThreadIds: string[]
  pendingServerRequestCount: number
  pendingTurnMutationCount: number
  automationRunIds?: string[]
  backgroundThreadIds?: string[]
}

export type AccountRuntime = {
  rpc(method: string, params: unknown): Promise<unknown>
  dispose(): void
  reloadAccount?(storageId: string): Promise<void>
  disconnectAccount?(storageId: string, wasActive?: boolean): Promise<void>
  getAccountSwitchSnapshot?(): Promise<RuntimeQuiescenceSnapshot>
  listPendingServerRequests(): unknown[]
  getRuntimeQuiescenceSnapshot?(): Promise<RuntimeQuiescenceSnapshot>
}

export type LoginIntent = 'add' | 'reauth'
export type LoginMethod = 'link' | 'device'
export type AccountLoginStatus = {
  loginSessionId: string; method: LoginMethod; intent: LoginIntent; targetStorageId: string | null
  loginUrl: string | null; userCode: string | null; expiresAt: string
  status: 'waiting' | 'verifying' | 'completed' | 'failed' | 'expired'
  error: string | null
  result?: Awaited<ReturnType<AccountAuthCoordinator['completeLogin']>>
}

type LoginSession = {
  id: string
  intent: LoginIntent
  targetStorageId: string | null
  home: string
  proc: ChildProcessWithoutNullStreams
  loginUrl: string | null
  output: string
  exited: boolean
  exitCode: number | null
  method: LoginMethod
  userCode: string | null
  expiresAt: number
  timer?: ReturnType<typeof setTimeout>
  completing?: Promise<Awaited<ReturnType<AccountAuthCoordinator['completeLogin']>>>
  completionStarted?: boolean
  removalRevision: number
}

type CoordinatorOperation = {
  kind: 'login' | 'refresh' | 'switch' | 'remove'
  startedAt: number
  storageId: string | null
}

export class AccountCoordinatorError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 409,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'AccountCoordinatorError'
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

function publicAccount(entry: StoredAccountEntry, activeStorageId: string | null) {
  return {
    ...entry,
    isActive: entry.storageId === activeStorageId,
    canSwitch: entry.authStatus === 'ready' || entry.authStatus === 'stale' || entry.authStatus === 'transient_error',
    actionRequired: entry.authStatus === 'reauth_required'
      ? 'reauthenticate'
      : entry.authStatus === 'payment_required'
        ? 'resolve_payment'
        : entry.authStatus === 'materialization_dirty'
          ? 'repair_active_credential'
          : null,
  }
}

function sortAccounts(state: StoredAccountsState): StoredAccountEntry[] {
  return [...state.accounts].sort((left, right) => {
    if (left.storageId === state.activeStorageId) return -1
    if (right.storageId === state.activeStorageId) return 1
    return right.lastRefreshedAtIso.localeCompare(left.lastRefreshedAtIso)
  })
}

function isLocalCallbackUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    return parsed.protocol === 'http:'
      && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]' || parsed.hostname === '::1')
  } catch {
    return false
  }
}

function extractLoginUrl(output: string): string | null {
  return output.match(/https:\/\/auth\.openai\.com\/oauth\/authorize\?\S+/u)?.[0] ?? null
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback
}

function threadContinuity(payload: unknown): {
  threadId: string | null
  cwd: string | null
  rolloutPath: string | null
  messageCount: number
  lastMessageId: string | null
} {
  const response = asRecord(payload)
  const thread = asRecord(response?.thread)
  const turns = Array.isArray(thread?.turns) ? thread.turns : []
  const items = turns.flatMap((turn) => {
    const record = asRecord(turn)
    return Array.isArray(record?.items) ? record.items : []
  })
  return {
    threadId: readString(thread?.id),
    cwd: readString(thread?.cwd),
    rolloutPath: readString(thread?.rolloutPath ?? thread?.rollout_path),
    messageCount: items.length,
    lastMessageId: readString(asRecord(items.at(-1))?.id),
  }
}

function sameContinuity(left: ReturnType<typeof threadContinuity>, right: ReturnType<typeof threadContinuity>): boolean {
  return left.threadId === right.threadId
    && left.cwd === right.cwd
    && left.rolloutPath === right.rolloutPath
    && left.messageCount === right.messageCount
    && left.lastMessageId === right.lastMessageId
}

export class AccountAuthCoordinator {
  private quotaRevisions = new Map<string, number>()
  private quotaBackoff = new Map<string, { until: number; failures: number }>()
  private quotaReadGeneration = new Map<string, number>()
  private quotaListeners = new Set<(account: StoredAccountEntry) => void>()
  private rollingUpdates = new Map<string, Promise<void>>()
  runtimeQuotaReader: ((storageId: string) => Promise<StoredAccountEntry | null>) | null = null
  subscribeQuotaUpdates(listener: (account: StoredAccountEntry) => void): () => void {
    this.quotaListeners.add(listener)
    return () => this.quotaListeners.delete(listener)
  }
  quotaRevision(storageId: string): number { return this.quotaRevisions.get(storageId) || 0 }
  quotaRetryAt(storageId: string): number { return this.quotaBackoff.get(storageId)?.until || 0 }
  async readQuotaWithBackoff<T>(storageId: string, read: () => Promise<T>): Promise<T> {
    const backoff = this.quotaBackoff.get(storageId)
    if (backoff && backoff.until > Date.now()) throw new Error(`额度读取需等待 ${Math.ceil((backoff.until - Date.now()) / 1000)} 秒`)
    const generation = (this.quotaReadGeneration.get(storageId) || 0) + 1
    this.quotaReadGeneration.set(storageId, generation)
    try {
      const result = await read()
      if (this.quotaReadGeneration.get(storageId) === generation) this.quotaBackoff.delete(storageId)
      return result
    } catch (error) {
      if (error instanceof Error && /app-server stopped|账号正在切换/.test(error.message)) throw error
      const failures = (backoff?.failures || 0) + 1
      if (this.quotaReadGeneration.get(storageId) === generation) this.quotaBackoff.set(storageId, { failures, until: Date.now() + quotaRetryDelay(error, failures) })
      throw error
    }
  }
  async applyRuntimeQuotaRead(storageId: string, payload: unknown, revision: number): Promise<StoredAccountEntry> {
    return this.applyInspection(storageId, { accountId: null, email: null, planType: null, rateLimits: payload }, undefined, revision)
  }
  private protectionInterrupt: ((storageId: string) => Promise<void>) | null = null
  setProtectionInterrupt(handler: (storageId: string) => Promise<void>): void { this.protectionInterrupt = handler }
  async interruptProtectedUsage(storageId: string): Promise<void> { await this.protectionInterrupt?.(storageId) }
  private quotaObserver: ((account: StoredAccountEntry) => Promise<void>) | null = null
  setQuotaObserver(observer: ((account: StoredAccountEntry) => Promise<void>) | null): void { this.quotaObserver = observer }
  private submissionGuard: ((isChatGPT?: () => Promise<boolean>, policy?: { storageId?: string; protected?: boolean }) => Promise<void>) | null = null
  setSubmissionGuard(guard: typeof this.submissionGuard): void { this.submissionGuard = guard }
  async assertSubmissionAllowed(isChatGPT?: () => Promise<boolean>, policy?: { storageId?: string; protected?: boolean }): Promise<void> { await this.submissionGuard?.(isChatGPT, policy) }
  activeUsageAccounts: () => Promise<string[]> = async () => []
  async observeRuntimeQuota(storageId: string, payload: unknown): Promise<void> {
    this.quotaRevisions.set(storageId, this.quotaRevision(storageId) + 1)
    const update = (this.rollingUpdates.get(storageId) || Promise.resolve()).catch(() => undefined).then(async () => {
    const current = (await this.store.readState()).accounts.find(account => account.storageId === storageId)
    const quotaSnapshot = normalizeRateLimitPayload(mergeQuotaUpdate(current?.quotaSnapshot, payload))
    if (!quotaSnapshot) return
    const account = await this.patchAccount(storageId, {
      quotaSnapshot, quotaUpdatedAtIso: new Date().toISOString(), quotaStatus: 'ready', quotaError: null,
      ...(quotaSnapshot.planType ? { planType: quotaSnapshot.planType } : {}),
    })
    for (const listener of this.quotaListeners) listener(account)
    await this.quotaObserver?.(account)
    })
    this.rollingUpdates.set(storageId, update)
    try { await update }
    finally { if (this.rollingUpdates.get(storageId) === update) this.rollingUpdates.delete(storageId) }
  }
  private readonly refreshOperations = new Map<string, Promise<unknown>>()
  private credentialMutationStorageId: string | null = null
  private primaryCredentialMutation = false
  isAccountOperationInProgress(): boolean { return this.operation !== null || this.refreshOperations.size > 0 }
  isAccountRefreshInProgress(storageId: string): boolean {
    return this.refreshOperations.has(`probe:${storageId}`) || this.refreshOperations.has(`token:${storageId}`)
  }
  blocksApiAccount(storageId: string | null): boolean {
    if (storageId ? this.executions.isRemoved(storageId) || this.removals.has(storageId) : this.removingPrimary) return true
    const operation = this.operation
    if (!operation || operation.kind === 'refresh') return false
    if (operation.kind === 'switch') return storageId === null
    if (operation.kind === 'login') return storageId === null ? this.primaryCredentialMutation : this.credentialMutationStorageId === storageId
    return storageId !== null && operation.storageId === storageId
  }
  blocksNewSubmissions(): boolean { return this.removingPrimary || this.operation?.kind === 'switch' || this.primaryCredentialMutation }
  readonly executions = new AccountExecutionRegistry()
  private readonly removals = new Map<string, Promise<unknown>>()
  private removingPrimary = false
  private drainingAccountRefreshes = false
  private mutationAccounts = new Set<string>()
  private operation: CoordinatorOperation | null = null
  private loginSession: LoginSession | null = null
  private lastLogin: AccountLoginStatus | null = null
  private readonly refreshFlights = new Map<string, Promise<StoredAccountEntry>>()
  private backgroundRefresh: Promise<void> | null = null
  private readonly tokenRefreshFailures = new Map<string, { revision: number; until: number; error: unknown }>()
  private readonly tokenRefreshFlights = new Map<string, Promise<ChatgptAuthTokensRefreshResponse>>()
  private apiLifecycle: { beforeMutation(kind: 'switch' | 'remove', storageId: string | null): Promise<() => void>; isIdle(): boolean } | null = null

  setApiLifecycle(lifecycle: { beforeMutation(kind: 'switch' | 'remove', storageId: string | null): Promise<() => void>; isIdle(): boolean } | null): () => void {
    this.apiLifecycle = lifecycle
    return () => { if (this.apiLifecycle === lifecycle) this.apiLifecycle = null }
  }

  async getApiCredential(selectedStorageId: string | null, options: { allowRefresh?: boolean } = {}): Promise<{
    storageId: string; revision: number; accessToken: string; accountId: string; expiresAt: string
  }> {
    if (this.blocksApiAccount(selectedStorageId)) throw new AccountCoordinatorError('account_operation_in_progress', '所选账号正在变更，请稍后重试。', 503)
    let state = await this.store.readState()
    const storageId = selectedStorageId ?? state.activeStorageId
    let entry = state.accounts.find(item => item.storageId === storageId)
    if (!storageId || !entry) throw new AccountCoordinatorError('account_not_found', '请选择已登录的 Codex 账号。', 503)
    let credential = await this.store.readCredential(storageId)
    if (accessTokenExpiresAt(credential.auth.tokens?.access_token ?? '') < Date.now() + 300_000) {
      if (options.allowRefresh === false) throw new AccountCoordinatorError('background_refresh_skipped', '凭据需要刷新，跳过本次激活。', 503)
      await this.refreshTokensForStorage(storageId, { reason: 'api_proxy_expiry', previousAccountId: entry.accountId })
      state = await this.store.readState()
      entry = state.accounts.find(item => item.storageId === storageId)
      if (!entry) throw new AccountCoordinatorError('account_not_found', '账号已移除。', 503)
      credential = await this.store.readCredential(storageId)
    }
    if (['reauth_required', 'payment_required', 'materialization_dirty'].includes(entry.authStatus)) {
      throw new AccountCoordinatorError('account_unavailable', '所选账号需要处理认证或额度问题。', 503)
    }
    const accessToken = credential.auth.tokens?.access_token ?? ''
    const expires = accessTokenExpiresAt(accessToken)
    if (expires <= Date.now()) throw new AccountCoordinatorError('invalid_access_token', '未获得有效的访问令牌。', 503)
    return { storageId, revision: entry.credentialRevision, accessToken, accountId: entry.accountId, expiresAt: new Date(expires).toISOString() }
  }

  constructor(
    readonly store: AccountAuthStore,
    private readonly dependencies: {
      spawnImpl?: typeof spawn
      fetchImpl?: typeof fetch
      createProbe?: (options: ConstructorParameters<typeof AccountAppServerProbe>[0]) => AccountAppServerProbe
    } = {},
  ) {}

  async listAccounts(options: { scheduleRefresh?: boolean } = {}): Promise<{
    activeAccountId: string | null
    activeStorageId: string | null
    operation: CoordinatorOperation | null
    accounts: ReturnType<typeof publicAccount>[]
  }> {
    const state = await this.store.readState()
    if (options.scheduleRefresh !== false) this.scheduleBackgroundRefresh(state)
    return {
      activeAccountId: state.activeAccountId,
      activeStorageId: state.activeStorageId,
      operation: this.operation,
      accounts: sortAccounts(state).map((entry) => publicAccount(entry, state.activeStorageId)),
    }
  }

  async importActiveCredential(): Promise<ReturnType<AccountAuthCoordinator['listAccounts']> extends Promise<infer T> ? T : never> {
    return await this.withOperation('refresh', null, async () => {
      const active = await this.store.readActiveCredential()
      if (!active) throw new AccountCoordinatorError('invalid_auth_json', 'The active Codex credential is unavailable.', 400)
      await this.store.upsertCredential(active.raw, { activate: true })
      return await this.listAccounts({ scheduleRefresh: true })
    })
  }

  async startLogin(input: { intent: LoginIntent; targetStorageId?: string | null; method?: LoginMethod }, runtime?: AccountRuntime): Promise<{ loginSessionId: string; loginUrl: string; method: LoginMethod; userCode: string | null; expiresAt: string }> {
    if (this.operation || this.loginSession) {
      throw new AccountCoordinatorError('account_operation_in_progress', 'Another account operation is already in progress.')
    }
    if (input.intent === 'reauth' && !input.targetStorageId) {
      throw new AccountCoordinatorError('missing_target_account', 'Choose an account to re-authenticate.', 400)
    }
    if (input.targetStorageId) {
      const state = await this.store.readState()
      if (!state.accounts.some((entry) => entry.storageId === input.targetStorageId)) {
        throw new AccountCoordinatorError('account_not_found', 'The selected account was not found.', 404)
      }
    }
    this.operation = { kind: 'login', startedAt: Date.now(), storageId: input.targetStorageId ?? null }
    const pending = await this.store.createPendingHome().catch(error => {
      this.operation = null
      throw error
    })
    const command = resolveCodexCommand()
    if (!command) {
      this.operation = null
      await this.store.removePendingHome(pending.loginSessionId)
      throw new AccountCoordinatorError('codex_cli_missing', 'Codex CLI is not available.', 500)
    }
    const method = input.method || 'link'
    this.lastLogin = null
    const invocation = getSpawnInvocation(command, ['login', ...(method === 'device' ? ['--device-auth'] : []), '-c', 'cli_auth_credentials_store="file"'])
    let proc: ChildProcessWithoutNullStreams
    try {
      proc = (this.dependencies.spawnImpl ?? spawn)(invocation.command, invocation.args, {
        env: { ...process.env, CODEX_HOME: pending.home },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      this.operation = null
      await this.store.removePendingHome(pending.loginSessionId)
      throw error
    }
    proc.stdin.end()
    const session: LoginSession = {
      id: pending.loginSessionId,
      removalRevision: this.executions.generation(),
      intent: input.intent,
      targetStorageId: input.targetStorageId ?? null,
      home: pending.home,
      proc,
      loginUrl: null,
      output: '',
      exited: false,
      exitCode: null,
      method,
      userCode: null,
      expiresAt: Date.now() + 15 * 60_000,
    }
    this.loginSession = session
    const append = (chunk: Buffer | string) => {
      if (this.loginSession !== session) return
      session.output = `${session.output}${String(chunk)}`.slice(-16_000)
      const plain = session.output.replace(/\u001b\[[0-9;]*m/g, '')
      session.loginUrl = session.loginUrl ?? (method === 'link' ? extractLoginUrl(plain) : plain.match(/https:\/\/auth\.openai\.com\/codex\/device\b/u)?.[0] || null)
      if (method === 'device') session.userCode = session.userCode ?? plain.match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/)?.[0] ?? null
    }
    proc.stdout.on('data', append)
    proc.stderr.on('data', append)
    proc.once('exit', code => {
      session.exited = true
      session.exitCode = code
      // Completion must continue when the browser is hidden or disconnected.
      if (this.loginSession === session && session.timer && !session.completionStarted) {
        void this.getLoginStatus(runtime).catch(() => undefined)
      }
    })
    proc.once('error', (error) => { session.exited = true; session.output += getErrorMessage(error, 'Login process failed.') })
    try {
      const loginUrl = await this.waitForLoginUrl(session)
      session.timer = setTimeout(() => {
        if (this.loginSession !== session || session.completionStarted) return
        this.lastLogin = { ...this.loginStatus(session), status: 'expired', error: '登录已过期，请重新开始。', userCode: null, loginUrl: null }
        void this.finishLoginSession(session)
      }, Math.max(1, session.expiresAt - Date.now()))
      session.timer.unref()
      if (session.exited) void this.getLoginStatus(runtime).catch(() => undefined)
      return { loginSessionId: session.id, loginUrl, method, userCode: session.userCode, expiresAt: new Date(session.expiresAt).toISOString() }
    } catch (error) {
      await this.cancelLogin(session.id)
      throw error
    }
  }

  async completeLogin(input: { loginSessionId: string; callbackUrl: string }, runtime?: AccountRuntime): Promise<{
    outcome: 'added' | 'reauthenticated'
    account: ReturnType<typeof publicAccount>
    activeAccountId: string | null
    activeStorageId: string | null
    poolSize: number
    accounts: ReturnType<typeof publicAccount>[]
  }> {
    const session = this.loginSession
    if (!session || session.id !== input.loginSessionId || (session.exited && session.method === 'link')) {
      throw new AccountCoordinatorError('login_not_running', 'The account login session is not running.')
    }
    if (session.method === 'device' && (!session.exited || session.exitCode !== 0)) {
      throw new AccountCoordinatorError('login_pending', '设备授权尚未完成。')
    }
    if (session.method === 'link' && !isLocalCallbackUrl(input.callbackUrl)) {
      throw new AccountCoordinatorError('invalid_callback_url', 'The callback URL must use localhost.', 400)
    }
    if (session.completionStarted) throw new AccountCoordinatorError('login_verifying', '正在验证账号。')
    session.completionStarted = true
    try {
      const before = await stat(`${session.home}/auth.json`).then((value) => value.mtimeMs).catch(() => null)
      if (session.method === 'link') {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), LOGIN_CALLBACK_TIMEOUT_MS)
        try {
          const response = await (this.dependencies.fetchImpl ?? fetch)(input.callbackUrl, { redirect: 'manual', signal: controller.signal })
          if (response.status >= 400) throw new Error(`Login callback returned HTTP ${String(response.status)}.`)
        } finally {
          clearTimeout(timer)
        }
        await this.waitForAuthFile(session.home, before)
      }
      let raw = await readFile(`${session.home}/auth.json`, 'utf8')
      const parsed = parseAccountCredential(raw)
      if (session.intent === 'reauth' && session.targetStorageId !== parsed.identity.storageId) {
        throw new AccountCoordinatorError('account_identity_mismatch', 'The signed-in account does not match the selected account.', 409, { outcome: 'identity_mismatch' })
      }
      const probe = this.createProbe({
        profileDir: session.home,
        expectedAccountId: parsed.identity.accountId,
        persistRefreshedCredential: async (nextRaw) => {
          parseAccountCredential(nextRaw)
          await this.store.atomicWrite(`${session.home}/auth.json`, nextRaw)
          raw = nextRaw
        },
      })
      const inspection = await this.withTimeout(probe.inspect(undefined, false, true), ACCOUNT_INSPECTION_TIMEOUT_MS, () => probe.dispose())
      raw = await readFile(`${session.home}/auth.json`, 'utf8')
      const beforeState = await this.store.readState()
      const wasActive = beforeState.activeStorageId === parsed.identity.storageId
      this.credentialMutationStorageId = parsed.identity.storageId
      this.primaryCredentialMutation = wasActive
      await Promise.all([
        this.refreshOperations.get(`probe:${parsed.identity.storageId}`),
        this.refreshOperations.get(`token:${parsed.identity.storageId}`),
      ].map(pending => pending?.catch(() => undefined)))
      if (this.executions.removedAfter(parsed.identity.storageId, session.removalRevision) || this.loginSession !== session) throw new AccountCoordinatorError('login_cancelled', '账号已移除，本次登录已取消。')
      this.executions.reopen(parsed.identity.storageId)
      const saved = await this.store.upsertCredential(raw, {
        expectedStorageId: session.targetStorageId,
        materializeIfActive: true,
      })
      await this.applyInspection(saved.account.storageId, inspection, wasActive ? 'ready' : undefined)
      if (wasActive && runtime) {
        await this.reloadRuntime(runtime, saved.account.storageId)
      }
      const state = await this.store.readState()
      const account = state.accounts.find((entry) => entry.storageId === saved.account.storageId) ?? saved.account
      return {
        outcome: saved.outcome,
        account: publicAccount(account, state.activeStorageId),
        activeAccountId: state.activeAccountId,
        activeStorageId: state.activeStorageId,
        poolSize: state.accounts.length,
        accounts: sortAccounts(state).map((entry) => publicAccount(entry, state.activeStorageId)),
      }
    } finally {
      this.credentialMutationStorageId = null
      this.primaryCredentialMutation = false
      await this.finishLoginSession(session)
    }
  }

  async cancelLogin(loginSessionId: string): Promise<void> {
    const session = this.loginSession
    if (!session || session.id !== loginSessionId) return
    if (session.completionStarted) throw new AccountCoordinatorError('login_verifying', '正在验证账号。')
    await this.finishLoginSession(session)
  }

  private loginStatus(session: LoginSession): AccountLoginStatus {
    return { loginSessionId: session.id, method: session.method, intent: session.intent, targetStorageId: session.targetStorageId,
      loginUrl: session.loginUrl, userCode: session.userCode, expiresAt: new Date(session.expiresAt).toISOString(),
      status: session.completionStarted ? 'verifying' : 'waiting', error: null }
  }

  async getLoginStatus(runtime?: AccountRuntime): Promise<AccountLoginStatus | null> {
    const session = this.loginSession
    if (!session) return this.lastLogin
    if (session.exited && !session.completionStarted) {
      if (session.exitCode !== 0 || session.method === 'link') {
        this.lastLogin = { ...this.loginStatus(session), status: 'failed', userCode: null, loginUrl: null,
          error: session.method === 'device' ? 'Device 授权未完成或已失效，请重试；若账号未开启设备码登录，可改用链接登录。' : '链接登录进程已结束，请重新开始登录。' }
        await this.finishLoginSession(session)
        return this.lastLogin
      }
      const snapshot = this.loginStatus(session)
      session.completing = this.completeLogin({ loginSessionId: session.id, callbackUrl: '' }, runtime)
      void session.completing.then(result => {
        this.lastLogin = { ...snapshot, status: 'completed', result, userCode: null, loginUrl: null }
      }, () => {
        this.lastLogin = { ...snapshot, status: 'failed', error: '授权后账号验证失败，请重新登录。', userCode: null, loginUrl: null }
      })
    }
    return this.loginStatus(session)
  }

  private modelCatalogs = new Map<string, { until: number; promise: Promise<unknown[]> }>()
  async readAccountModels(storageId?: string): Promise<unknown[]> {
    const state = await this.store.readState()
    const id = storageId || state.activeStorageId
    const entry = state.accounts.find(account => account.storageId === id)
    if (!entry) throw new AccountCoordinatorError('account_not_found', '请选择可用账号。', 404)
    const key = `${entry.storageId}:${entry.credentialRevision}:${entry.planType}`
    const cached = this.modelCatalogs.get(key)
    if (cached && cached.until > Date.now()) return cached.promise
    const promise = this.withOperation('refresh', entry.storageId, async () => {
      let revision = entry.credentialRevision
      const probe = this.createProbe({
        profileDir: `${this.store.accountsRoot}/${entry.storageId}`,
        expectedAccountId: entry.accountId,
        persistRefreshedCredential: async raw => {
          const saved = await this.store.upsertCredential(raw, { expectedStorageId: entry.storageId, expectedRevision: revision, materializeIfActive: true })
          revision = saved.account.credentialRevision
        },
      })
      const result = await this.withTimeout(probe.inspect(undefined, true), ACCOUNT_INSPECTION_TIMEOUT_MS, () => probe.dispose())
      return result.models || []
    })
    if (this.modelCatalogs.size >= 16) this.modelCatalogs.delete(this.modelCatalogs.keys().next().value!)
    this.modelCatalogs.set(key, { until: Date.now() + 30_000, promise })
    void promise.catch(() => { this.modelCatalogs.delete(key) })
    return promise
  }

  async consumeResetCredit(storageId: string, creditId: string, idempotencyKey: string): Promise<string> {
    return await this.withOperation('refresh', storageId, async () => {
      const state = await this.store.readState()
      const entry = state.accounts.find(account => account.storageId === storageId)
      if (!entry) throw new AccountCoordinatorError('account_not_found', '账号不存在。', 404)
      let revision = entry.credentialRevision
      const probe = this.createProbe({
        profileDir: `${this.store.accountsRoot}/${storageId}`,
        expectedAccountId: entry.accountId,
        beforeReset: async () => { await this.patchAccount(storageId, { lastResetUsedAtIso: new Date().toISOString() }) },
        persistRefreshedCredential: async raw => {
          const saved = await this.store.upsertCredential(raw, { expectedStorageId: storageId, expectedRevision: revision, materializeIfActive: true })
          revision = saved.account.credentialRevision
        },
      })
      const inspection = await this.withTimeout(probe.inspect({ creditId, idempotencyKey }), ACCOUNT_INSPECTION_TIMEOUT_MS, () => probe.dispose())
      await this.applyInspection(storageId, inspection)
      return inspection.resetOutcome || 'unknown'
    })
  }

  async refreshAccount(storageId: string): Promise<StoredAccountEntry> {
    const existing = this.refreshFlights.get(storageId)
    if (existing) return await existing
    const promise = this.withOperation('refresh', storageId, async () => {
      const state = await this.store.readState()
      const entry = state.accounts.find((item) => item.storageId === storageId)
      if (!entry) throw new AccountCoordinatorError('account_not_found', 'The selected account was not found.', 404)
      if (this.quotaRetryAt(storageId) > Date.now()) return entry
      if (this.runtimeQuotaReader) {
        try {
          const runtime = await this.runtimeQuotaReader(storageId)
          if (runtime) return runtime
        } catch (error) {
          const classified = classifyAccountAuthError(error)
          const failed = await this.patchAccount(storageId, { authStatus: classified.authStatus, unavailableReason: classified.unavailableReason, quotaStatus: 'error', quotaError: getErrorMessage(error, '额度读取失败'), quotaUpdatedAtIso: new Date().toISOString() })
          for (const listener of this.quotaListeners) listener(failed)
          await this.quotaObserver?.(failed).catch(() => undefined)
          return failed
        }
      }
      const quotaRevision = this.quotaRevision(storageId)
      await this.patchAccount(storageId, { authStatus: 'refreshing', quotaStatus: 'loading', quotaError: null })
      let revision = entry.credentialRevision
      const probe = this.createProbe({
        profileDir: `${this.store.accountsRoot}/${storageId}`,
        expectedAccountId: entry.accountId,
        persistRefreshedCredential: async (raw) => {
          const saved = await this.store.upsertCredential(raw, { expectedStorageId: storageId, expectedRevision: revision, materializeIfActive: true })
          revision = saved.account.credentialRevision
        },
      })
      try {
        const inspection = await this.readQuotaWithBackoff(storageId, () => this.withTimeout(probe.inspect(), ACCOUNT_INSPECTION_TIMEOUT_MS, () => probe.dispose()))
        return await this.applyInspection(storageId, inspection, 'ready', quotaRevision)
      } catch (error) {
        const classified = classifyAccountAuthError(error)
        const failed = await this.patchAccount(storageId, {
          authStatus: classified.authStatus,
          unavailableReason: classified.unavailableReason,
          quotaStatus: 'error',
          quotaError: getErrorMessage(error, 'Failed to refresh account quota.'),
          quotaUpdatedAtIso: new Date().toISOString(),
        })
        await this.quotaObserver?.(failed).catch(() => undefined)
        for (const listener of this.quotaListeners) listener(failed)
        return failed
      }
    })
    this.refreshFlights.set(storageId, promise)
    try {
      return await promise
    } finally {
      this.refreshFlights.delete(storageId)
    }
  }

  async refreshActiveTokens(params: ChatgptAuthTokensRefreshParams): Promise<ChatgptAuthTokensRefreshResponse> {
    const state = await this.store.readState()
    if (!state.activeStorageId) throw new AccountCoordinatorError('account_not_found', 'No active account credential is available.', 404)
    return await this.refreshTokensForStorage(state.activeStorageId, params)
  }

  async refreshTokensForStorage(storageId: string, params: ChatgptAuthTokensRefreshParams, mutationOwner?: CoordinatorOperation | null): Promise<ChatgptAuthTokensRefreshResponse> {
    const existing = this.tokenRefreshFlights.get(storageId)
    if (existing) return await existing
    const generation = this.executions.generation()
    const flight = this.withRefreshOperation(`token:${storageId}`, async () => {
      const state = await this.store.readState()
      const entry = storageId ? state.accounts.find((item) => item.storageId === storageId) ?? null : null
      if (!storageId || !entry) throw new AccountCoordinatorError('account_not_found', 'No active account credential is available.', 404)
      const failure = this.tokenRefreshFailures.get(storageId)
      if (failure && failure.revision === entry.credentialRevision && failure.until > Date.now()) throw failure.error
      const credential = await this.store.readCredential(storageId, { requireRefreshToken: true })
      try {
        const refreshed = await refreshChatgptAccountCredential(credential.raw, params, {
          fetchImpl: this.dependencies.fetchImpl,
          expectedAccountId: entry.accountId,
        })
        if (this.executions.removedAfter(storageId, generation)) throw new AccountCoordinatorError('account_disconnected', '旧账号连接已撤销。', 409)
        const saved = await this.store.upsertCredential(refreshed.raw, {
          expectedStorageId: storageId,
          expectedRevision: entry.credentialRevision,
          materializeIfActive: true,
        })
        await this.patchAccount(storageId, {
          authStatus: 'ready',
          credentialRevision: saved.account.credentialRevision,
          lastVerifiedAtIso: new Date().toISOString(),
        })
        this.tokenRefreshFailures.delete(storageId)
        return refreshed.response
      } catch (error) {
        if (this.executions.removedAfter(storageId, generation)) throw error
        const classified = classifyAccountAuthError(error)
        this.tokenRefreshFailures.set(storageId, { revision: entry.credentialRevision, until: classified.authStatus === 'reauth_required' ? Infinity : Date.now() + 30_000, error })
        await this.patchAccount(storageId, {
          authStatus: classified.authStatus,
          unavailableReason: classified.unavailableReason,
        })
        throw error
      }
    }, mutationOwner)
    this.tokenRefreshFlights.set(storageId, flight)
    try {
      return await flight
    } finally {
      this.tokenRefreshFlights.delete(storageId)
    }
  }

  async switchAccount(input: {
    storageId: string
    expectedActiveStorageId?: string | null
    resumeThreadId?: string | null
  }, runtime: AccountRuntime): Promise<{
    account: ReturnType<typeof publicAccount>
    activeStorageId: string
    workspaceContinuity: { checked: boolean; restored: boolean; threadId: string | null }
  }> {
    return await this.withOperation('switch', input.storageId, async () => {
      const switchStartedAt = Date.now()
      const initial = await this.store.readState()
      if (input.expectedActiveStorageId !== undefined && input.expectedActiveStorageId !== initial.activeStorageId) {
        throw new AccountCoordinatorError('active_account_conflict', 'The active account changed in another browser.', 409)
      }
      const target = initial.accounts.find((entry) => entry.storageId === input.storageId)
      if (!target) throw new AccountCoordinatorError('account_not_found', 'The selected account was not found.', 404)
      if (target.storageId === initial.activeStorageId) {
        return {
          account: publicAccount(target, initial.activeStorageId),
          activeStorageId: target.storageId,
          workspaceContinuity: { checked: false, restored: true, threadId: input.resumeThreadId ?? null },
        }
      }
      await this.assertRuntimeIdle(runtime)
      let beforeThread: ReturnType<typeof threadContinuity> | null = null
      if (input.resumeThreadId) {
        beforeThread = threadContinuity(await runtime.rpc('thread/read', { threadId: input.resumeThreadId, includeTurns: true }))
      }
      if (initial.activeStorageId) {
        const live = await this.store.readActiveCredential()
        if (live && live.identity.storageId === initial.activeStorageId) {
          const activeEntry = initial.accounts.find((entry) => entry.storageId === initial.activeStorageId)
          await this.store.upsertCredential(live.raw, {
            expectedStorageId: initial.activeStorageId,
            expectedRevision: activeEntry?.credentialRevision,
          })
        }
      }
      const preflightStartedAt = Date.now()
      const refreshedTarget = await this.refreshAccountOutsideOperation(target.storageId)
      const preflightMs = Date.now() - preflightStartedAt
      if (refreshedTarget.authStatus === 'reauth_required' || refreshedTarget.authStatus === 'payment_required') {
        throw new AccountCoordinatorError('account_unavailable', 'The target account cannot be activated until its account issue is resolved.', 409)
      }
      const previousStorageId = initial.activeStorageId
      const previousRaw = previousStorageId ? (await this.store.readCredential(previousStorageId)).raw : null
      let materialized = false
      try {
        const materializeStartedAt = Date.now()
        if (this.executions.isRemoved(target.storageId)) throw new AccountCoordinatorError('account_not_found', '目标账号已移除。', 404)
        await this.store.materializeActive(target.storageId)
        materialized = true
        await this.reloadRuntime(runtime, target.storageId)
        const materializeRestartMs = Date.now() - materializeStartedAt
        const continuityStartedAt = Date.now()
        let afterThread: ReturnType<typeof threadContinuity> | null = null
        if (input.resumeThreadId && beforeThread) {
          try {
            afterThread = threadContinuity(await runtime.rpc('thread/read', { threadId: input.resumeThreadId, includeTurns: true }))
          } catch {
            await runtime.rpc('thread/resume', { threadId: input.resumeThreadId })
            afterThread = threadContinuity(await runtime.rpc('thread/read', { threadId: input.resumeThreadId, includeTurns: true }))
          }
          if (!sameContinuity(beforeThread, afterThread)) throw new Error('thread_continuity_mismatch')
        }
        const continuityMs = Date.now() - continuityStartedAt
        const commitStartedAt = Date.now()
        const next = await this.store.updateState((state) => {
          if (this.executions.isRemoved(target.storageId) || !state.accounts.some(account => account.storageId === target.storageId)) throw new AccountCoordinatorError('account_not_found', '目标账号已移除。', 404)
          const now = new Date().toISOString()
          const accounts = state.accounts.map((entry) => entry.storageId === target.storageId
            ? { ...entry, authStatus: 'ready' as const, lastActivatedAtIso: now }
            : entry)
          const activated = accounts.find((entry) => entry.storageId === target.storageId) ?? target
          const nextState = {
            ...state,
            operationEpoch: state.operationEpoch + 1,
            activeStorageId: target.storageId,
            activeAccountId: target.accountId,
            accounts,
          }
          return { state: nextState, result: { state: nextState, activated } }
        })
        const commitMs = Date.now() - commitStartedAt
        console.info(
          `[accounts] switch_phases storage=${target.storageId.slice(0, 8)} preflightMs=${String(preflightMs)} materializeRestartMs=${String(materializeRestartMs)} continuityMs=${String(continuityMs)} commitMs=${String(commitMs)} totalMs=${String(Date.now() - switchStartedAt)}`,
        )
        return {
          account: publicAccount(next.activated, target.storageId),
          activeStorageId: target.storageId,
          workspaceContinuity: {
            checked: Boolean(input.resumeThreadId),
            restored: true,
            threadId: input.resumeThreadId ?? null,
          },
        }
      } catch (error) {
        if (materialized) {
          let rollbackSucceeded = false
          try {
            await this.store.restoreActive(previousStorageId && this.executions.isRemoved(previousStorageId) ? null : previousRaw)
            if (previousStorageId && !this.executions.isRemoved(previousStorageId)) await this.reloadRuntime(runtime, previousStorageId)
            else runtime.dispose()
            if (input.resumeThreadId && beforeThread) {
              const restored = threadContinuity(await runtime.rpc('thread/read', { threadId: input.resumeThreadId, includeTurns: true }))
              rollbackSucceeded = sameContinuity(beforeThread, restored)
            } else {
              rollbackSucceeded = true
            }
          } catch {
            rollbackSucceeded = false
          }
          if (!rollbackSucceeded && previousStorageId) {
            await this.patchAccount(previousStorageId, { authStatus: 'materialization_dirty' })
          }
          throw new AccountCoordinatorError(
            rollbackSucceeded ? 'account_switch_failed_rolled_back' : 'account_switch_degraded',
            rollbackSucceeded ? 'Account switch failed and the previous account was restored.' : 'Account switch failed and automatic recovery is incomplete.',
            502,
            { rollbackSucceeded },
          )
        }
        throw error
      }
    }, () => this.assertRuntimeIdle(runtime))
  }

  async removeAccount(storageId: string, runtime?: AccountRuntime): Promise<Awaited<ReturnType<AccountAuthCoordinator['listAccounts']>>> {
    const existing = this.removals.get(storageId)
    if (existing) return existing as Promise<Awaited<ReturnType<AccountAuthCoordinator['listAccounts']>>>
    if (!/^[a-f0-9]{64}$/.test(storageId)) throw new AccountCoordinatorError('invalid_account', '账号标识无效。', 400)
    this.executions.revoke(storageId)
    const removal = (async () => {
      const state = await this.store.readState()
      const primary = state.activeStorageId === storageId
      if (primary) this.removingPrimary = true
      try {
        for (const probe of this.probes.get(storageId) || []) void probe.dispose().catch(() => undefined)
        const login = this.loginSession
        if (login && (login.targetStorageId === storageId || this.credentialMutationStorageId === storageId)) {
          void this.finishLoginSession(login).catch(() => undefined)
        }
        // Revoke the durable credential first. Late refreshes use revision checks
        // and cannot recreate a removed account. Do not wait for quota/network RPC.
        await this.store.deleteAccount(storageId)
        await Promise.all([
          runtime?.disconnectAccount?.(storageId, primary),
          this.apiLifecycle?.beforeMutation('remove', storageId),
        ])
        this.modelCatalogs.clear()
        this.quotaBackoff.delete(storageId)
        this.tokenRefreshFailures.delete(storageId)
        this.quotaRevisions.delete(storageId)
        return await this.listAccounts({ scheduleRefresh: false })
      } finally {
        if (primary) this.removingPrimary = false
      }
    })()
    this.removals.set(storageId, removal)
    try { return await removal }
    finally { this.removals.delete(storageId) }
  }

  private readonly probes = new Map<string, Set<AccountAppServerProbe>>()
  private createProbe(options: ConstructorParameters<typeof AccountAppServerProbe>[0]): AccountAppServerProbe {
    const storageId = options.profileDir.startsWith(this.store.accountsRoot + '/') ? options.profileDir.slice(this.store.accountsRoot.length + 1) : ''
    const savedAccount = /^[a-f0-9]{64}$/.test(storageId)
    const generation = this.executions.generation()
    const mutationOwner = this.operation
    const refreshTokens = (params: unknown) => this.refreshTokensForStorage(storageId, asRecord(params) || {}, mutationOwner)
    const probeOptions = savedAccount ? {
      ...options,
      refreshTokens,
      prepareExternalTokens: async () => {
        let credential = await this.store.readCredential(storageId)
        const expires = accessTokenExpiresAt(credential.auth.tokens?.access_token || '')
        if (expires && expires < Date.now() + 300_000) {
          await refreshTokens({ reason: 'account_probe_expiry', previousAccountId: credential.identity.accountId })
          credential = await this.store.readCredential(storageId)
        }
        this.executions.assertAvailable(storageId)
        if (this.executions.removedAfter(storageId, generation)) throw new AccountCoordinatorError('account_disconnected', '旧账号探针已撤销。', 409)
        return { accessToken: credential.auth.tokens?.access_token || '', chatgptAccountId: credential.identity.accountId, chatgptPlanType: credential.identity.planType || undefined }
      },
    } : options
    const probe = this.dependencies.createProbe?.(probeOptions) ?? new AccountAppServerProbe(probeOptions)
    if (savedAccount) {
      const probes = this.probes.get(storageId) || new Set<AccountAppServerProbe>()
      probes.add(probe)
      this.probes.set(storageId, probes)
      const dispose = probe.dispose.bind(probe)
      probe.dispose = async () => {
        try { await dispose() }
        finally { probes.delete(probe); if (!probes.size) this.probes.delete(storageId) }
      }
    }
    return probe
  }

  private async applyInspection(storageId: string, inspection: AccountProbeInspection, authStatus?: AccountAuthStatus, revision?: number): Promise<StoredAccountEntry> {
    await this.rollingUpdates.get(storageId)
    const quotaSnapshot = normalizeRateLimitPayload(inspection.rateLimits)
    const account = await this.patchAccount(storageId, {
      ...(inspection.email ? { email: inspection.email } : {}),
      ...(quotaSnapshot?.planType || inspection.planType ? { planType: quotaSnapshot?.planType || inspection.planType } : {}),
      authStatus: authStatus ?? 'ready',
      lastVerifiedAtIso: new Date().toISOString(),
      quotaSnapshot,
      resetCredits: normalizeResetCredits(asRecord(inspection.rateLimits)?.rateLimitResetCredits),
      quotaUpdatedAtIso: new Date().toISOString(),
      quotaStatus: 'ready',
      quotaError: null,
      unavailableReason: null,
    }, revision)
    for (const listener of this.quotaListeners) listener(account)
    await this.quotaObserver?.(account).catch(() => undefined)
    return account
  }

  private async patchAccount(storageId: string, patch: Partial<StoredAccountEntry>, quotaRevision?: number): Promise<StoredAccountEntry> {
    return await this.store.updateState((state) => {
      const current = state.accounts.find((entry) => entry.storageId === storageId)
      if (!current) throw new AccountCoordinatorError('account_not_found', 'The selected account was not found.', 404)
      const next = { ...current, ...patch, ...(quotaRevision !== undefined && quotaRevision !== this.quotaRevision(storageId) ? { quotaSnapshot: current.quotaSnapshot, planType: current.planType } : {}) }
      return {
        state: { ...state, accounts: state.accounts.map((entry) => entry.storageId === storageId ? next : entry) },
        result: next,
      }
    })
  }

  private async refreshAccountOutsideOperation(storageId: string): Promise<StoredAccountEntry> {
    const state = await this.store.readState()
    const entry = state.accounts.find((item) => item.storageId === storageId)
    if (!entry) throw new AccountCoordinatorError('account_not_found', 'The selected account was not found.', 404)
    let revision = entry.credentialRevision
    const probe = this.createProbe({
      profileDir: `${this.store.accountsRoot}/${storageId}`,
      expectedAccountId: entry.accountId,
      persistRefreshedCredential: async (raw) => {
        const saved = await this.store.upsertCredential(raw, { expectedStorageId: storageId, expectedRevision: revision, materializeIfActive: true })
        revision = saved.account.credentialRevision
      },
    })
    try {
      return await this.applyInspection(
        storageId,
        await this.withTimeout(probe.inspect(undefined, false, true), ACCOUNT_INSPECTION_TIMEOUT_MS, () => probe.dispose()),
        'ready',
      )
    } catch (error) {
      const classified = classifyAccountAuthError(error)
      await this.patchAccount(storageId, {
        authStatus: classified.authStatus,
        unavailableReason: classified.unavailableReason,
        quotaStatus: 'error',
        quotaError: getErrorMessage(error, 'Failed to validate the target account.'),
      })
      throw error
    }
  }

  private scheduleBackgroundRefresh(state: StoredAccountsState): void {
    if (this.backgroundRefresh || this.operation) return
    const stale = state.accounts.filter((entry) => {
      if (!entry.quotaUpdatedAtIso) return true
      const updated = Date.parse(entry.quotaUpdatedAtIso)
      return !Number.isFinite(updated) || Date.now() - updated >= ACCOUNT_QUOTA_REFRESH_TTL_MS
    })
    if (stale.length === 0) return
    this.backgroundRefresh = (async () => {
      for (const entry of stale) await this.refreshAccount(entry.storageId).catch(() => undefined)
    })().finally(() => { this.backgroundRefresh = null })
  }

  private async reloadRuntime(runtime: AccountRuntime, storageId: string): Promise<void> {
    if (runtime.reloadAccount) {
      await runtime.reloadAccount(storageId)
      return
    }
    runtime.dispose()
    await runtime.rpc('account/read', { refreshToken: false })
  }

  private async assertRuntimeIdle(runtime: AccountRuntime): Promise<void> {
    const snapshot = runtime.getAccountSwitchSnapshot
      ? await runtime.getAccountSwitchSnapshot()
      : runtime.getRuntimeQuiescenceSnapshot
      ? await runtime.getRuntimeQuiescenceSnapshot()
      : {
          idle: runtime.listPendingServerRequests().length === 0,
          activeTurnThreadIds: [],
          queuedThreadIds: [],
          pendingServerRequestCount: runtime.listPendingServerRequests().length,
          pendingTurnMutationCount: 0,
        }
    if (!snapshot.idle) {
      const message = snapshot.backgroundThreadIds?.length
        ? '请先处理 Codex 后台终端，再切换账号。'
        : 'Finish active turns, queued messages, and pending requests before switching accounts.'
      throw new AccountCoordinatorError('account_switch_blocked', message, 409, { quiescence: snapshot })
    }
  }

  private async withRefreshOperation<T>(key: string, run: () => Promise<T>, mutationOwner?: CoordinatorOperation | null): Promise<T> {
    const accountId = key.slice(key.indexOf(':') + 1)
    if (this.executions.isRemoved(accountId)) throw new AccountCoordinatorError('account_not_found', '账号已移除。', 404)
    const ownedTokenRefresh = key.startsWith('token:') && (this.operation?.kind === 'switch' || (!!mutationOwner && mutationOwner === this.operation))
    if (this.operation && !ownedTokenRefresh && (accountId === 'active' || (this.mutationAccounts.has(accountId) && !(this.drainingAccountRefreshes && key.startsWith('token:'))) || this.credentialMutationStorageId === accountId)) {
      throw new AccountCoordinatorError('account_operation_in_progress', '所选账号正在变更，请稍后重试。')
    }
    const previous = this.refreshOperations.get(key)
    const pending = (async () => {
      await previous?.catch(() => undefined)
      return await run()
    })()
    this.refreshOperations.set(key, pending)
    try {
      return await pending
    } finally {
      if (this.refreshOperations.get(key) === pending) this.refreshOperations.delete(key)
    }
  }

  private async withOperation<T>(kind: CoordinatorOperation['kind'], storageId: string | null, run: () => Promise<T>, preflight?: () => Promise<void>): Promise<T> {
    if (kind === 'refresh') return this.withRefreshOperation(`probe:${storageId || 'active'}`, run)
    if (this.operation) throw new AccountCoordinatorError('account_operation_in_progress', '另一项账号变更正在进行。')
    this.operation = { kind, storageId, startedAt: Date.now() }
    const shortId = storageId?.slice(0, 8) ?? 'active'
    const startedAt = Date.now()
    let releaseApi: (() => void) | undefined
    try {
      const state = await this.store.readState()
      this.mutationAccounts = new Set([storageId, ...(kind === 'switch' ? [state.activeStorageId] : [])].filter((id): id is string => !!id))
      this.drainingAccountRefreshes = true
      await Promise.all([...this.refreshOperations].filter(([key]) => this.mutationAccounts.has(key.slice(key.indexOf(':') + 1))).map(([, pending]) => pending.catch(() => undefined)))
      this.drainingAccountRefreshes = false
      await preflight?.()
      if (kind === 'switch' || kind === 'remove') releaseApi = await this.apiLifecycle?.beforeMutation(kind, storageId)
      const result = await run()
      console.info(`[accounts] operation=${kind} storage=${shortId} result=ok durationMs=${String(Date.now() - startedAt)}`)
      return result
    } catch (error) {
      const code = error instanceof AccountCoordinatorError || error instanceof AccountStoreError ? error.code : 'failed'
      console.warn(`[accounts] operation=${kind} storage=${shortId} result=${code} durationMs=${String(Date.now() - startedAt)}`)
      throw error
    } finally {
      this.operation = null
      this.mutationAccounts.clear()
      this.drainingAccountRefreshes = false
      releaseApi?.()
    }
  }

  private async waitForLoginUrl(session: LoginSession): Promise<string> {
    const started = Date.now()
    while (Date.now() - started < LOGIN_URL_TIMEOUT_MS) {
      if (this.loginSession !== session) throw new AccountCoordinatorError('login_cancelled', '登录已取消。')
      if (session.loginUrl && (session.method === 'link' || session.userCode)) return session.loginUrl
      if (session.exited) throw new AccountCoordinatorError('account_login_start_failed', 'Codex login exited before returning a login URL.', 500)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new AccountCoordinatorError('account_login_start_failed', 'Timed out waiting for the Codex login URL.', 504)
  }

  private async waitForAuthFile(home: string, previousMtimeMs: number | null): Promise<void> {
    const started = Date.now()
    while (Date.now() - started < LOGIN_AUTH_FILE_TIMEOUT_MS) {
      const next = await stat(`${home}/auth.json`).then((value) => value.mtimeMs).catch(() => null)
      if (next !== null && (previousMtimeMs === null || next > previousMtimeMs)) return
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new AccountCoordinatorError('account_login_complete_failed', 'Login completed without writing an account credential.', 504)
  }

  private async finishLoginSession(session: LoginSession): Promise<void> {
    if (this.loginSession !== session) return
    if (session.timer) clearTimeout(session.timer)
    this.loginSession = null
    try {
      if (!session.exited) {
        const exited = once(session.proc, 'exit').catch(() => undefined)
        session.proc.kill('SIGTERM')
        await this.withTimeout(exited, 1500).catch(async () => {
          session.proc.kill('SIGKILL')
          await this.withTimeout(exited, 1500)
        })
      }
      await this.store.removePendingHome(session.id)
    } finally { this.operation = null }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout?: () => void | Promise<void>): Promise<T> {
    let timer: NodeJS.Timeout | null = null
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            void Promise.resolve(onTimeout?.()).catch(() => undefined)
            reject(new Error(`Account inspection timed out after ${String(timeoutMs)}ms.`))
          }, timeoutMs)
          timer.unref?.()
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

const coordinators = new Map<string, AccountAuthCoordinator>()

export function getAccountAuthCoordinator(): AccountAuthCoordinator {
  const store = new AccountAuthStore()
  const existing = coordinators.get(store.codexHome)
  if (existing) return existing
  const created = new AccountAuthCoordinator(store)
  coordinators.set(store.codexHome, created)
  return created
}
