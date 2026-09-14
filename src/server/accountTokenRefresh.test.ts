import { describe, expect, it, vi } from 'vitest'
import { ChatgptTokenRefreshError, classifyAccountAuthError, isTerminalAccountAuthError, refreshChatgptAccountCredential } from './accountTokenRefresh.js'

function jwt(accountId: string): string {
  return `header.${Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'pro', user_id: 'user-a' },
  })).toString('base64url')}.signature`
}

function credential(refreshToken = 'refresh-old'): string {
  return JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { account_id: 'account-a', access_token: jwt('account-a'), refresh_token: refreshToken, id_token: 'id-old' },
  })
}

describe('refreshChatgptAccountCredential', () => {
  it('returns a rotated credential for persistence before replying to app-server', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      access_token: jwt('account-a'),
      refresh_token: 'refresh-new',
      id_token: 'id-new',
    }), { status: 200 }))
    const result = await refreshChatgptAccountCredential(credential(), {}, {
      fetchImpl,
      refreshUrl: 'https://example.test/oauth/token',
      expectedAccountId: 'account-a',
    })
    const parsed = JSON.parse(result.raw) as { tokens: Record<string, string> }
    expect(parsed.tokens.refresh_token).toBe('refresh-new')
    expect(parsed.tokens.id_token).toBe('id-new')
    expect(result.response.chatgptAccountId).toBe('account-a')
  })

  it('rejects refresh identity changes without returning the rotated secret', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      access_token: jwt('account-b'),
      refresh_token: 'do-not-persist',
    }), { status: 200 }))
    await expect(refreshChatgptAccountCredential(credential(), {}, { fetchImpl }))
      .rejects.toMatchObject({ code: 'account_identity_mismatch' })
  })

  it.each([
    ['token_revoked', 'reauth_required'],
    ['HTTP 402 payment required', 'payment_required'],
    ['network timeout', 'transient_error'],
  ])('classifies %s separately', (message, expected) => {
    expect(classifyAccountAuthError(new Error(message)).authStatus).toBe(expected)
  })

  it.each([
    [{ httpStatus: 401, oauthError: 'invalid_grant' }, 'reauth_required'],
    [{ httpStatus: 400, oauthError: 'token_revoked' }, 'reauth_required'],
    [{ httpStatus: 401, oauthError: null }, 'reauth_required'],
    [{ httpStatus: 500, oauthError: null }, 'transient_error'],
    [{ httpStatus: 503, oauthError: 'temporarily_unavailable' }, 'transient_error'],
    [{ httpStatus: 402, oauthError: 'payment_required' }, 'payment_required'],
  ])('prefers the structured OAuth payload for %j', (options, expected) => {
    const error = new ChatgptTokenRefreshError('ChatGPT token refresh failed.', options)
    expect(classifyAccountAuthError(error).authStatus).toBe(expected)
  })

  it('treats a bare HTTP 401 as retryable while a structured invalid_grant stays terminal', () => {
    const response = 'upstream rejected refresh token request'
    const error = new ChatgptTokenRefreshError(response, { httpStatus: 401, oauthError: null })
    expect(classifyAccountAuthError(error)).toMatchObject({ authStatus: 'reauth_required', unavailableReason: 'reauth_required' })
    expect(isTerminalAccountAuthError(error)).toBe(false)
    expect(isTerminalAccountAuthError(new ChatgptTokenRefreshError('revoked', { oauthError: 'invalid_grant' }))).toBe(true)
    expect(isTerminalAccountAuthError(new Error('invalid_grant'))).toBe(true)
  })
})
