import type { GetAccountRateLimitsResponse } from './appServerDtos'
import { normalizeResetCredits } from '../accountResetCredits'
import type {
  UiAccountEntry,
  UiAccountQuotaStatus,
  UiAccountUnavailableReason,
  UiCreditsSnapshot,
  UiRateLimitSnapshot,
  UiRateLimitWindow,
} from '../types/codex'
import { normalizeCodexApiError } from './codexErrors'
import { callRpc } from './rpcGateway'

export type AccountsListResult = {
  activeAccountId: string | null
  activeStorageId: string | null
  accounts: UiAccountEntry[]
  importedAccountId?: string
  importedStorageId?: string
  operation?: { kind: string; storageId: string | null; startedAt: number } | null
}

export type AccountLoginStartResult = { loginSessionId: string; loginUrl: string; method?: 'link' | 'device'; userCode?: string | null; expiresAt?: string }
export type AccountLoginStatus = AccountLoginStartResult & {
  intent: 'add' | 'reauth'; targetStorageId: string | null
  status: 'waiting' | 'verifying' | 'completed' | 'failed' | 'expired'
  error: string | null; result?: AccountLoginCompleteResult
}
export type AccountLoginCompleteResult = AccountsListResult & {
  outcome: 'added' | 'reauthenticated'
  account: UiAccountEntry
  poolSize: number
}

export type AccountSwitchResult = {
  account: UiAccountEntry
  activeStorageId: string
  workspaceContinuity: { checked: boolean; restored: boolean; threadId: string | null }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function normalizeAccountUnavailableReason(value: unknown): UiAccountUnavailableReason | null {
  return value === 'payment_required' || value === 'reauth_required' ? value : null
}

function normalizeAccountAuthStatus(value: unknown): UiAccountEntry['authStatus'] {
  return value === 'refreshing' || value === 'switching' || value === 'reauth_required' || value === 'payment_required'
    || value === 'stale' || value === 'transient_error' || value === 'materialization_dirty'
    ? value
    : 'ready'
}

function isPaymentRequiredErrorMessage(value: string | null): boolean {
  if (!value) return false
  const normalized = value.toLowerCase()
  return normalized.includes('payment required') || /\b402\b/.test(normalized)
}

function normalizeRateLimitWindow(value: unknown): UiRateLimitWindow | null {
  const record = asRecord(value)
  if (!record) return null

  const usedPercent = readNumber(record.usedPercent ?? record.used_percent)
  if (usedPercent === null) return null

  const windowValue = readNumber(record.windowDurationMins ?? record.windowMinutes ?? record.window_minutes)
  return {
    usedPercent,
    windowDurationMins: windowValue,
    windowMinutes: windowValue,
    resetsAt: readNumber(record.resetsAt ?? record.resets_at),
  }
}

function normalizeCreditsSnapshot(value: unknown): UiCreditsSnapshot | null {
  const record = asRecord(value)
  if (!record) return null

  const hasCredits = readBoolean(record.hasCredits ?? record.has_credits)
  const unlimited = readBoolean(record.unlimited)
  if (hasCredits === null || unlimited === null) return null

  return {
    hasCredits,
    unlimited,
    balance: readString(record.balance),
  }
}

function normalizeRateLimitSnapshot(value: unknown): UiRateLimitSnapshot | null {
  const record = asRecord(value)
  if (!record) return null

  const primary = normalizeRateLimitWindow(record.primary)
  const secondary = normalizeRateLimitWindow(record.secondary)
  const credits = normalizeCreditsSnapshot(record.credits)

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

export function normalizeAccountEntry(
  value: unknown,
  activeAccountId: string | null = null,
  activeStorageId: string | null = null,
): UiAccountEntry | null {
  const record = asRecord(value)
  if (!record) return null
  const accountId = readString(record.accountId)
  const storageId = readString(record.storageId) ?? accountId
  const quotaStatusRaw = readString(record.quotaStatus)
  const quotaStatus: UiAccountQuotaStatus =
    quotaStatusRaw === 'loading' || quotaStatusRaw === 'ready' || quotaStatusRaw === 'error' ? quotaStatusRaw : 'idle'
  if (!accountId) return null
  return {
    accountId,
    storageId: storageId ?? accountId,
    alias: readString(record.alias) ?? '',
    userId: readString(record.userId),
    authMode: readString(record.authMode),
    email: readString(record.email),
    planType: readString(record.planType),
    credentialRevision: Math.max(0, Math.trunc(readNumber(record.credentialRevision) ?? 0)),
    authStatus: normalizeAccountAuthStatus(record.authStatus),
    lastVerifiedAtIso: readString(record.lastVerifiedAtIso),
    lastRefreshedAtIso: readString(record.lastRefreshedAtIso) ?? '',
    lastActivatedAtIso: readString(record.lastActivatedAtIso),
    quotaSnapshot: normalizeRateLimitSnapshot(record.quotaSnapshot),
    resetCredits: normalizeResetCredits(record.resetCredits),
    protectionPercent: readNumber(record.protectionPercent) ?? 0,
    quotaUpdatedAtIso: readString(record.quotaUpdatedAtIso),
    quotaFailedAtIso: readString(record.quotaFailedAtIso),
    quotaStatus,
    quotaError: readString(record.quotaError),
    unavailableReason: normalizeAccountUnavailableReason(record.unavailableReason)
      ?? (isPaymentRequiredErrorMessage(readString(record.quotaError)) ? 'payment_required' : null),
    canSwitch: readBoolean(record.canSwitch) ?? true,
    actionRequired: record.actionRequired === 'reauthenticate' || record.actionRequired === 'resolve_payment' || record.actionRequired === 'repair_active_credential'
      ? record.actionRequired
      : null,
    isActive: readBoolean(record.isActive) ?? (storageId === activeStorageId || accountId === activeAccountId),
  }
}

export function pickCodexRateLimitSnapshot(payload: unknown): UiRateLimitSnapshot | null {
  const record = asRecord(payload)
  if (!record) return null

  const rateLimitsByLimitId = asRecord(record.rateLimitsByLimitId ?? record.rate_limits_by_limit_id)
  const codexBucket = normalizeRateLimitSnapshot(rateLimitsByLimitId?.codex)
  if (codexBucket) return codexBucket

  return normalizeRateLimitSnapshot(record.rateLimits ?? record.rate_limits)
}

function getErrorMessageFromPayload(payload: unknown, fallback: string): string {
  const record = asRecord(payload)
  const message = record?.message
  if (typeof message === 'string' && message.trim().length > 0) {
    return message
  }
  const error = record?.error
  return typeof error === 'string' && error.trim().length > 0 ? error : fallback
}

export async function getCodexLoginStatus(): Promise<AccountLoginStatus | null> {
  const response = await fetch('/codex-api/accounts/login/status', { cache: 'no-store' })
  const payload = await response.json()
  if (!response.ok) throw new Error(getErrorMessageFromPayload(payload, '读取登录状态失败。'))
  return payload.data ?? null
}

export async function getAccountRateLimits(): Promise<UiRateLimitSnapshot | null> {
  try {
    const payload = await callRpc<unknown>('account/rateLimits/read')
    return pickCodexRateLimitSnapshot(payload)
  } catch (error) {
    throw normalizeCodexApiError(error, 'Failed to load account rate limits', 'account/rateLimits/read')
  }
}

function normalizeAccountsListResult(payload: unknown): AccountsListResult {
  const record = asRecord(payload)
  const activeAccountId = readString(record?.activeAccountId)
  const activeStorageId = readString(record?.activeStorageId)
  const data = Array.isArray(record?.accounts) ? record?.accounts : []
  return {
    activeAccountId,
    activeStorageId,
    importedAccountId: readString(record?.importedAccountId) ?? undefined,
    importedStorageId: readString(record?.importedStorageId) ?? undefined,
    operation: asRecord(record?.operation) as AccountsListResult['operation'],
    accounts: data
      .map((entry) => normalizeAccountEntry(entry, activeAccountId, activeStorageId))
      .filter((entry): entry is UiAccountEntry => entry !== null),
  }
}

export async function getAccounts(): Promise<AccountsListResult> {
  const response = await fetch('/codex-api/accounts')
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to load accounts'))
  }
  const envelope = asRecord(payload)
  return normalizeAccountsListResult(envelope?.data)
}

export async function refreshAccountsFromAuth(): Promise<AccountsListResult> {
  const response = await fetch('/codex-api/accounts/refresh', {
    method: 'POST',
  })
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to refresh accounts'))
  }
  const envelope = asRecord(payload)
  return normalizeAccountsListResult(envelope?.data)
}

export async function startCodexLogin(intent: 'add' | 'reauth' = 'add', targetStorageId?: string, method?: 'link' | 'device'): Promise<AccountLoginStartResult> {
  const response = await fetch('/codex-api/accounts/login/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intent, ...(targetStorageId ? { targetStorageId } : {}), ...(method ? { method } : {}) }),
  })
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to start Codex login'))
  }
  const envelope = asRecord(payload)
  const data = asRecord(envelope?.data)
  const loginUrl = readString(data?.loginUrl)
  const loginSessionId = readString(data?.loginSessionId)
  if (!loginUrl || !loginSessionId) {
    throw new Error('Failed to start Codex login')
  }
  return { loginUrl, loginSessionId, ...(data?.method ? { method: data.method as 'link' | 'device', userCode: readString(data.userCode), expiresAt: readString(data.expiresAt) || undefined } : {}) }
}

export async function completeCodexLogin(loginSessionId: string, callbackUrl: string): Promise<AccountLoginCompleteResult> {
  const response = await fetch('/codex-api/accounts/login/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginSessionId, callbackUrl }),
  })
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to complete Codex login'))
  }
  const envelope = asRecord(payload)
  const data = asRecord(envelope?.data)
  const normalized = normalizeAccountsListResult(data)
  const outcome = data?.outcome === 'reauthenticated' ? 'reauthenticated' : data?.outcome === 'added' ? 'added' : null
  const account = normalizeAccountEntry(data?.account, normalized.activeAccountId, normalized.activeStorageId)
  if (!outcome || !account) throw new Error('Failed to complete Codex login')
  return { ...normalized, outcome, account, poolSize: readNumber(data?.poolSize) ?? normalized.accounts.length }
}

export async function cancelCodexLogin(loginSessionId: string): Promise<void> {
  await fetch('/codex-api/accounts/login/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginSessionId }),
  })
}

export async function refreshAccountQuota(storageId: string): Promise<AccountsListResult> {
  const response = await fetch('/codex-api/accounts/quota/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storageId }),
  })
  const payload = (await response.json() as unknown)
  if (!response.ok) throw new Error(getErrorMessageFromPayload(payload, 'Failed to refresh account quota'))
  return normalizeAccountsListResult(asRecord(payload)?.data)
}

export async function switchAccount(storageId: string, expectedActiveStorageId: string | null, resumeThreadId?: string): Promise<AccountSwitchResult> {
  const response = await fetch('/codex-api/accounts/switch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storageId, expectedActiveStorageId, ...(resumeThreadId ? { resumeThreadId } : {}) }),
  })
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to switch account'))
  }
  const envelope = asRecord(payload)
  const data = asRecord(envelope?.data)
  const account = normalizeAccountEntry(data?.account, readString(data?.activeAccountId), readString(data?.activeStorageId))
  if (!account) {
    throw new Error('Failed to switch account')
  }
  const continuity = asRecord(data?.workspaceContinuity)
  return {
    account,
    activeStorageId: readString(data?.activeStorageId) ?? account.storageId,
    workspaceContinuity: {
      checked: readBoolean(continuity?.checked) ?? false,
      restored: readBoolean(continuity?.restored) ?? false,
      threadId: readString(continuity?.threadId),
    },
  }
}

export async function removeAccount(storageId: string): Promise<AccountsListResult> {
  const response = await fetch('/codex-api/accounts/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storageId }),
  })
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to remove account'))
  }
  const envelope = asRecord(payload)
  return normalizeAccountsListResult(envelope?.data)
}

export async function getAccountRateLimitsResponse(): Promise<GetAccountRateLimitsResponse> {
  return await callRpc<GetAccountRateLimitsResponse>('account/rateLimits/read')
}
