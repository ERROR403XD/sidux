import { readFile } from 'node:fs/promises'
import { getErrorCode } from './httpUtils.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatgptAuthTokensRefreshParams, ChatgptAuthTokensRefreshResponse } from './accountTokenRefresh.js'
import { getAccountAuthCoordinator } from './accountAuthCoordinator.js'

type CodexAuth = {
  auth_mode?: string
  last_refresh?: number
  tokens?: {
    access_token?: string
    refresh_token?: string
    id_token?: string
    account_id?: string
  }
}

export type CodexAuthShape = CodexAuth

import { getCodexHomeDir } from './runtimePaths.js'

export function getCodexAuthPath(): string {
  return join(getCodexHomeDir(), 'auth.json')
}

export async function readCodexAuth(): Promise<{ accessToken: string; accountId?: string } | null> {
  try {
    const auth = JSON.parse(await readFile(getCodexAuthPath(), 'utf8')) as CodexAuth
    const token = auth.tokens?.access_token
    if (!token) return null
    return { accessToken: token, accountId: auth.tokens?.account_id ?? undefined }
  } catch {
    return null
  }
}

export async function refreshChatgptAuthTokensForExternalAuth(
  params: ChatgptAuthTokensRefreshParams = {},
): Promise<ChatgptAuthTokensRefreshResponse> {
  return await getAccountAuthCoordinator().refreshActiveTokens(params)
}

export function hasUsableCodexAuthSync(): boolean {
  try {
    const auth = JSON.parse(readFileSync(getCodexAuthPath(), 'utf8')) as CodexAuth
    return Boolean(auth.tokens?.access_token?.trim())
  } catch {
    return false
  }
}

const warnedCodexAuthReadFailures = new Set<string>()

function getCodexAuthReadErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : String(error)
}

function warnCodexAuthReadFailure(authPath: string, error: unknown): void {
  const message = getCodexAuthReadErrorMessage(error)
  const warningKey = `${authPath}:${message}`
  if (warnedCodexAuthReadFailures.has(warningKey)) return
  warnedCodexAuthReadFailures.add(warningKey)
  console.warn('[codex-auth] Unable to read Codex auth state', { path: authPath, error: message })
}

export async function hasUsableCodexAuth(): Promise<boolean> {
  const authPath = getCodexAuthPath()
  try {
    const raw = await readFile(authPath, 'utf8')
    const auth = JSON.parse(raw) as CodexAuth
    return Boolean(auth.tokens?.access_token?.trim() || auth.tokens?.refresh_token?.trim())
  } catch (error) {
    if (getErrorCode(error) !== 'ENOENT') {
      warnCodexAuthReadFailure(authPath, error)
    }
    return false
  }
}
