import { AccountStoreError, parseAccountCredential, type CodexAuthFile } from './accountAuthStore.js'

const CODEX_CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const DEFAULT_CODEX_REFRESH_TOKEN_URL = 'https://auth.openai.com/oauth/token'

export type ChatgptAuthTokensRefreshParams = {
  reason?: string
  previousAccountId?: string | null
}

export type ChatgptAuthTokensRefreshResponse = {
  accessToken: string
  chatgptAccountId: string
  chatgptPlanType: string | null
}

export type RefreshedAccountCredential = {
  raw: string
  response: ChatgptAuthTokensRefreshResponse
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
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

export function accessTokenExpiresAt(token: string): number {
  const payload = decodeJwtPayload(token)
  return typeof payload?.exp === 'number' ? payload.exp * 1000 : 0
}

function errorMessage(payload: Record<string, unknown> | null, fallback: string): string {
  const nested = asRecord(payload?.error)
  return readString(payload?.message)
    ?? readString(payload?.error)
    ?? readString(nested?.message)
    ?? readString(nested?.error_description)
    ?? readString(payload?.error_description)
    ?? fallback
}

export function classifyAccountAuthError(error: unknown): {
  authStatus: 'reauth_required' | 'payment_required' | 'transient_error'
  unavailableReason: 'reauth_required' | 'payment_required' | null
} {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  if (message.includes('token_revoked') || message.includes('invalid_grant') || message.includes('refresh token') || /\b401\b/.test(message)) {
    return { authStatus: 'reauth_required', unavailableReason: 'reauth_required' }
  }
  if (message.includes('payment required') || /\b402\b/.test(message)) {
    return { authStatus: 'payment_required', unavailableReason: 'payment_required' }
  }
  return { authStatus: 'transient_error', unavailableReason: null }
}

export async function refreshChatgptAccountCredential(
  raw: string,
  params: ChatgptAuthTokensRefreshParams = {},
  options: {
    fetchImpl?: typeof fetch
    refreshUrl?: string
    expectedAccountId?: string | null
  } = {},
): Promise<RefreshedAccountCredential> {
  const current = parseAccountCredential(raw, { requireRefreshToken: true })
  const currentRefreshToken = current.auth.tokens?.refresh_token?.trim() ?? ''
  const refreshUrl = options.refreshUrl
    ?? process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE?.trim()
    ?? DEFAULT_CODEX_REFRESH_TOKEN_URL
  const response = await (options.fetchImpl ?? fetch)(refreshUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: currentRefreshToken,
      client_id: CODEX_CHATGPT_CLIENT_ID,
    }).toString(),
    signal: AbortSignal.timeout(25_000),
  })
  const text = await response.text()
  let payload: Record<string, unknown> | null = null
  try {
    payload = asRecord(JSON.parse(text))
  } catch {
    payload = null
  }
  if (!response.ok) {
    throw new Error(errorMessage(payload, `ChatGPT token refresh failed with HTTP ${String(response.status)}`))
  }

  const accessToken = readString(payload?.access_token ?? payload?.accessToken)
  if (!accessToken) throw new Error('ChatGPT token refresh response did not include an access token.')
  const authMetadata = asRecord(decodeJwtPayload(accessToken)?.['https://api.openai.com/auth'])
  const chatgptAccountId = readString(authMetadata?.chatgpt_account_id)
    ?? readString(payload?.chatgpt_account_id ?? payload?.chatgptAccountId)
    ?? readString(params.previousAccountId)
    ?? current.identity.accountId
  const expectedAccountId = options.expectedAccountId ?? current.identity.accountId
  if (expectedAccountId && chatgptAccountId !== expectedAccountId) {
    throw new AccountStoreError('account_identity_mismatch', 'The refreshed credential belongs to a different account.')
  }

  const nextAuth: CodexAuthFile = {
    ...current.auth,
    auth_mode: current.auth.auth_mode || 'chatgpt',
    last_refresh: Date.now(),
    tokens: {
      ...current.auth.tokens,
      access_token: accessToken,
      refresh_token: readString(payload?.refresh_token ?? payload?.refreshToken) ?? currentRefreshToken,
      account_id: chatgptAccountId,
      ...(readString(payload?.id_token ?? payload?.idToken)
        ? { id_token: readString(payload?.id_token ?? payload?.idToken) ?? undefined }
        : {}),
    },
  }
  return {
    raw: `${JSON.stringify(nextAuth, null, 2)}\n`,
    response: {
      accessToken,
      chatgptAccountId,
      chatgptPlanType: readString(authMetadata?.chatgpt_plan_type),
    },
  }
}
