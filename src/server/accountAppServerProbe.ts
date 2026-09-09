import { once } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveCodexCommand } from '../commandResolution.js'
import { getSpawnInvocation } from '../utils/commandInvocation.js'
import { buildAppServerArgs } from './appServerRuntimeConfig.js'
import {
  refreshChatgptAccountCredential,
  type ChatgptAuthTokensRefreshResponse,
} from './accountTokenRefresh.js'

type JsonRpcMessage = {
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback
}

export class AccountProbeRpcClient {
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()

  constructor(
    private readonly send: (message: Record<string, unknown>) => void,
    private readonly refreshTokens: (params: unknown) => Promise<ChatgptAuthTokensRefreshResponse>,
  ) {}

  call(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }

  handleLine(line: string): void {
    let message: JsonRpcMessage
    try {
      message = JSON.parse(line) as JsonRpcMessage
    } catch {
      return
    }
    if (typeof message.id === 'number' && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(Object.assign(new Error(message.error.message || 'Account probe request failed.'), { code: message.error.code, data: message.error.data }))
      else pending.resolve(message.result)
      return
    }
    if (typeof message.id === 'number' && message.method === 'account/chatgptAuthTokens/refresh') {
      void this.handleRefreshRequest(message.id, message.params)
    }
  }

  rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private async handleRefreshRequest(id: number, params: unknown): Promise<void> {
    try {
      const result = await this.refreshTokens(params)
      this.send({ jsonrpc: '2.0', id, result })
    } catch (error) {
      this.send({
        jsonrpc: '2.0',
        id,
        error: { code: -32001, message: getErrorMessage(error, 'Failed to refresh account credentials.') },
      })
    }
  }
}

export type AccountProbeInspection = {
  accountId: string | null
  email: string | null
  planType: string | null
  resetOutcome?: string
  models?: unknown[]
  rateLimits: unknown
}

export class AccountAppServerProbe {
  private process: ChildProcessWithoutNullStreams | null = null
  private readBuffer = ''
  private client: AccountProbeRpcClient | null = null

  constructor(private readonly options: {
    profileDir: string
    expectedAccountId: string
    persistRefreshedCredential: (raw: string) => Promise<void>
    beforeReset?: () => Promise<void>
    refreshTokens?: (params: unknown) => Promise<ChatgptAuthTokensRefreshResponse>
    command?: string
    prepareExternalTokens?: () => Promise<{ accessToken: string; chatgptAccountId: string; chatgptPlanType?: string }>
    externalTokens?: { accessToken: string; chatgptAccountId: string; chatgptPlanType?: string }
    spawnImpl?: typeof spawn
  }) {}

  async inspect(reset?: { creditId: string; idempotencyKey: string }, includeModels = false, quotaOptional = false): Promise<AccountProbeInspection> {
    try {
      const externalTokens = await this.options.prepareExternalTokens?.() || this.options.externalTokens
      const client = this.start()
      await client.call('initialize', {
        clientInfo: { name: 'codexapp-account-probe', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      })
      client.notify('initialized')
      if (externalTokens) await client.call('account/login/start', { type: 'chatgptAuthTokens', ...externalTokens })
      const accountPayload = asRecord(await client.call('account/read', { refreshToken: false }))
      const account = asRecord(accountPayload?.account)
      const runtimeAccountId = readString(account?.id ?? account?.accountId ?? account?.account_id)
      if (runtimeAccountId && runtimeAccountId !== this.options.expectedAccountId) {
        throw new Error('account_identity_mismatch')
      }
      let resetOutcome: string | undefined
      if (reset) {
        await this.options.beforeReset?.()
        const result = asRecord(await client.call('account/rateLimitResetCredit/consume', reset))
        resetOutcome = readString(result?.outcome) || 'unknown'
      }
      const models: unknown[] = []
      if (includeModels) {
        let cursor: string | null = null
        const seen = new Set<string>()
        for (let page = 0; page < 20; page++) {
          const result = asRecord(await client.call('model/list', { limit: 100, ...(cursor ? { cursor } : {}) }))
          if (!Array.isArray(result?.data)) throw new Error('账号模型目录格式无效')
          models.push(...result.data)
          cursor = readString(result.nextCursor)
          if (!cursor) break
          if (seen.has(cursor) || page === 19) throw new Error('账号模型目录分页无效')
          seen.add(cursor)
        }
      }
      // Model discovery must not depend on an unrelated quota endpoint.
      const rateLimits = includeModels ? null : await client.call('account/rateLimits/read', null).catch(error => {
        if (!quotaOptional || /401|402|403|token_revoked|invalid_grant|unauthorized/i.test(String(error))) throw error
        return null
      })
      return {
        accountId: runtimeAccountId,
        email: readString(account?.email),
        planType: readString(account?.planType ?? account?.plan_type),
        rateLimits,
        resetOutcome,
        ...(includeModels ? { models } : {}),
      }
    } finally {
      await this.dispose()
    }
  }

  async dispose(): Promise<void> {
    const proc = this.process
    this.process = null
    this.client?.rejectAll(new Error('Account probe stopped.'))
    this.client = null
    if (!proc) return
    const exited = once(proc, 'exit').catch(() => undefined)
    try { proc.stdin.end() } catch {}
    try { proc.kill('SIGTERM') } catch {}
    if (exited && proc.exitCode === null && proc.signalCode === null) {
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1000))])
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGKILL')
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1000))])
      }
      if (proc.exitCode === null && proc.signalCode === null) throw new Error('临时额度探针未退出')
    }
  }

  private start(): AccountProbeRpcClient {
    if (this.client) return this.client
    const command = this.options.command ?? resolveCodexCommand()
    if (!command) throw new Error('Codex CLI is not available for account inspection.')
    const invocation = getSpawnInvocation(command, buildAppServerArgs())
    const proc = (this.options.spawnImpl ?? spawn)(invocation.command, invocation.args, {
      env: { ...process.env, CODEX_HOME: this.options.profileDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.process = proc
    const client = new AccountProbeRpcClient(
      (message) => proc.stdin.write(`${JSON.stringify(message)}\n`),
      async (params) => {
        if (this.options.refreshTokens) return this.options.refreshTokens(params)
        if (this.options.externalTokens) throw new Error('定时激活不刷新凭据')
        const request = asRecord(params)
        const raw = await readFile(join(this.options.profileDir, 'auth.json'), 'utf8')
        const refreshed = await refreshChatgptAccountCredential(raw, {
          reason: readString(request?.reason) ?? undefined,
          previousAccountId: readString(request?.previousAccountId ?? request?.previous_account_id),
        }, { expectedAccountId: this.options.expectedAccountId })
        await this.options.persistRefreshedCredential(refreshed.raw)
        return refreshed.response
      },
    )
    this.client = client
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      this.readBuffer += chunk
      let newline = this.readBuffer.indexOf('\n')
      while (newline >= 0) {
        const line = this.readBuffer.slice(0, newline).trim()
        this.readBuffer = this.readBuffer.slice(newline + 1)
        if (line) client.handleLine(line)
        newline = this.readBuffer.indexOf('\n')
      }
    })
    proc.on('error', (error) => client.rejectAll(error))
    proc.on('exit', () => client.rejectAll(new Error('Account probe app-server exited unexpectedly.')))
    proc.stderr.resume()
    return client
  }
}
