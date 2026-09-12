import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  AccountCoordinatorError,
  getAccountAuthCoordinator,
  type AccountRuntime,
  type LoginIntent,
} from './accountAuthCoordinator.js'
import { AccountStoreError } from './accountAuthStore.js'

type AccountRouteContext = {
  appServer: AccountRuntime
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function setJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await new Promise<string>((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { body += chunk })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
  if (!raw) return {}
  let parsed: Record<string, unknown> | null = null
  try {
    parsed = asRecord(JSON.parse(raw))
  } catch {
    throw new AccountCoordinatorError('invalid_request', 'Expected valid JSON.', 400)
  }
  if (!parsed) throw new AccountCoordinatorError('invalid_request', 'Expected a JSON object.', 400)
  return parsed
}

function sendError(res: ServerResponse, error: unknown, fallback: string): void {
  if (error instanceof AccountCoordinatorError) {
    setJson(res, error.statusCode, { error: error.code, message: error.message, ...error.details })
    return
  }
  if (error instanceof AccountStoreError) {
    const statusCode = error.code === 'account_not_found' ? 404 : error.code.includes('conflict') || error.code.includes('mismatch') ? 409 : 400
    setJson(res, statusCode, { error: error.code, message: error.message })
    return
  }
  setJson(res, 500, {
    error: 'account_operation_failed',
    message: error instanceof Error && error.message.trim() ? error.message : fallback,
  })
}

export async function handleAccountRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  context: AccountRouteContext,
): Promise<boolean> {
  const coordinator = getAccountAuthCoordinator()

  if (req.method === 'GET' && url.pathname === '/codex-api/accounts/executions') {
    setJson(res, 200, { data: coordinator.executions.snapshot() })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/codex-api/accounts/models') {
    try { setJson(res, 200, { data: await coordinator.readAccountModels(url.searchParams.get('storageId') || undefined) }) }
    catch (error) { sendError(res, error, '账号模型目录读取失败。') }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/codex-api/accounts') {
    try {
      setJson(res, 200, { data: await coordinator.listAccounts() })
    } catch (error) {
      sendError(res, error, 'Failed to load accounts.')
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/codex-api/accounts/active') {
    try {
      const data = await coordinator.listAccounts({ scheduleRefresh: false })
      setJson(res, 200, { data: data.accounts.find((entry) => entry.isActive) ?? null })
    } catch (error) {
      sendError(res, error, 'Failed to load the active account.')
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/codex-api/accounts/reset-credit') {
    try {
      const input = await readJsonBody(req)
      if (input.confirmed !== true || typeof input.storageId !== 'string' || typeof input.creditId !== 'string' || !input.creditId || typeof input.idempotencyKey !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.idempotencyKey)) {
        throw new AccountCoordinatorError('confirmation_required', '请先确认所选账号与重置机会。', 400)
      }
      const outcome = await coordinator.consumeResetCredit(input.storageId, input.creditId, input.idempotencyKey)
      setJson(res, 200, { data: { outcome } })
    } catch (error) { sendError(res, error, '重置结果未确认，请刷新额度后核对。') }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/codex-api/accounts/refresh') {
    try {
      setJson(res, 200, { data: await coordinator.importActiveCredential() })
    } catch (error) {
      sendError(res, error, 'Failed to import the active credential.')
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/codex-api/accounts/quota/refresh') {
    try {
      const body = await readJsonBody(req)
      const storageId = readString(body.storageId)
      if (!storageId) throw new AccountCoordinatorError('account_not_found', 'Choose an account to refresh.', 400)
      await coordinator.refreshAccount(storageId)
      setJson(res, 200, { data: await coordinator.listAccounts({ scheduleRefresh: false }) })
    } catch (error) {
      sendError(res, error, 'Failed to refresh account quota.')
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/codex-api/accounts/login/status') {
    try { setJson(res, 200, { data: await coordinator.getLoginStatus(context.appServer) }) }
    catch (error) { sendError(res, error, 'Failed to read login status.') }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/codex-api/accounts/login/start') {
    try {
      const body = await readJsonBody(req)
      const intent: LoginIntent = body.intent === 'reauth' ? 'reauth' : 'add'
      if (body.method !== undefined && body.method !== 'link' && body.method !== 'device') throw new AccountCoordinatorError('invalid_login_method', '请选择链接或 Device 登录。', 400)
      const data = await coordinator.startLogin({
        intent,
        targetStorageId: readString(body.targetStorageId),
        method: body.method === 'device' ? 'device' : 'link',
      }, context.appServer)
      setJson(res, 200, { ok: true, data })
    } catch (error) {
      sendError(res, error, 'Failed to start account login.')
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/codex-api/accounts/login/complete') {
    try {
      const body = await readJsonBody(req)
      const loginSessionId = readString(body.loginSessionId)
      const callbackUrl = readString(body.callbackUrl)
      if (!loginSessionId || !callbackUrl) {
        throw new AccountCoordinatorError('invalid_login_completion', 'Login session and callback URL are required.', 400)
      }
      const data = await coordinator.completeLogin({ loginSessionId, callbackUrl }, context.appServer)
      setJson(res, 200, { ok: true, data })
    } catch (error) {
      sendError(res, error, 'Failed to complete account login.')
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/codex-api/accounts/login/cancel') {
    try {
      const body = await readJsonBody(req)
      const loginSessionId = readString(body.loginSessionId)
      if (loginSessionId) await coordinator.cancelLogin(loginSessionId)
      setJson(res, 200, { ok: true })
    } catch (error) {
      sendError(res, error, 'Failed to cancel account login.')
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/codex-api/accounts/switch') {
    try {
      const body = await readJsonBody(req)
      const storageId = readString(body.storageId)
      if (!storageId) throw new AccountCoordinatorError('account_not_found', 'Choose an account to switch to.', 400)
      const data = await coordinator.switchAccount({
        storageId,
        expectedActiveStorageId: body.expectedActiveStorageId === null ? null : readString(body.expectedActiveStorageId) ?? undefined,
        resumeThreadId: readString(body.resumeThreadId),
      }, context.appServer)
      setJson(res, 200, { ok: true, data })
    } catch (error) {
      sendError(res, error, 'Failed to switch account.')
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/codex-api/accounts/remove') {
    try {
      const body = await readJsonBody(req)
      const storageId = readString(body.storageId)
      if (!storageId) throw new AccountCoordinatorError('account_not_found', 'Choose an account to remove.', 400)
      setJson(res, 200, { ok: true, data: await coordinator.removeAccount(storageId, context.appServer) })
    } catch (error) {
      sendError(res, error, 'Failed to remove account.')
    }
    return true
  }

  return false
}
