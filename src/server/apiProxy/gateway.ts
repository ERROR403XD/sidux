import { AccountResourcePool } from '../accountResourcePool.js'
import { AccountExecutionError, resolveAccountSelection } from '../accountExecution.js'
import { AccountNotificationService } from '../accountNotificationService.js'
import { assertQuotaAvailable } from './quotaProtection.js'
import { createAccountActivationRuntime } from '../accountActivationRuntime.js'
import type { AccountActivationScheduler } from '../accountActivationScheduler.js'
import { randomUUID } from 'node:crypto'
import { request as httpRequest, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { Transform } from 'node:stream'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { AccountCoordinatorError, getAccountAuthCoordinator, type AccountAuthCoordinator } from '../accountAuthCoordinator.js'
import { ProxyActivity, type Activity } from './activity.js'
import { ProxyComponent, proxyManifest, type ComponentGeneration } from './component.js'
import { hashSecret, ProxyError, ProxyStore, type ProxySettings } from './store.js'
import { ProxyUsageStore, extractUsage } from './usage.js'
import type { TokenUsage, UsageOutcome } from '../../api/proxyUsageTypes.js'

const configuredBodyMB = Number(process.env.CODEXAPP_API_PROXY_MAX_BODY_MB || 64)
const MAX_BODY = (Number.isInteger(configuredBodyMB) && configuredBodyMB >= 1 && configuredBodyMB <= 128 ? configuredBodyMB : 64) * 1024 * 1024
const allowedRoutes = new Set(['GET /v1/models', 'POST /v1/responses', 'POST /v1/responses/compact', 'POST /v1/chat/completions'])
const clientHeaders = ['user-agent', 'originator', 'version', 'openai-beta', 'x-codex-beta-features', 'x-codex-turn-metadata',
  'x-openai-internal-codex-responses-lite', 'x-codex-turn-state', 'x-client-request-id', 'x-openai-subagent']
const sessionHeaders = ['session-id', 'thread-id', 'x-codex-window-id', 'x-codex-installation-id']
function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return
  if (res.headersSent) { res.destroy(); return }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}
function errorResponse(res: ServerResponse, error: unknown): void {
  const known = error instanceof ProxyError || error instanceof AccountCoordinatorError || error instanceof AccountExecutionError
  const code = known ? error.code : 'proxy_unavailable'
  const status = error instanceof ProxyError ? error.status : error instanceof AccountCoordinatorError || error instanceof AccountExecutionError ? error.statusCode : 503
  if (status === 503 && !res.headersSent) res.setHeader('Retry-After', '3')
  json(res, status, { error: { type: status === 401 ? 'authentication_error' : 'api_error', code,
    message: known ? error.message : 'API 出口暂时不可用，请在管理页面检查账号和组件状态。' } })
}
async function body(req: IncomingMessage, limit = MAX_BODY): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > limit) throw new ProxyError('payload_too_large', '请求内容超过大小限制。', 413)
    chunks.push(bytes)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed
  } catch { throw new ProxyError('invalid_json', '请求体必须是 JSON 对象。') }
}
export class ApiProxyGateway {
  private readonly accountComponents = new AccountResourcePool<ProxyComponent>({
    capacity: 8,
    idle: (_component, id) => !this.accountHasConnections(id),
    dispose: component => component.stop(),
  })
  private readonly generationComponents = new WeakMap<ComponentGeneration, ProxyComponent>()
  private async stopComponents(): Promise<void> {
    await this.component.stop()
    for (const component of new Set(this.accountComponents.values())) if (component !== this.component) await component.stop()
    this.accountComponents.clear()
  }
  private owner(generation: ComponentGeneration): ProxyComponent { return this.generationComponents.get(generation) || this.component }
  private async resolveAccount(keyId?: string): Promise<string> {
    const state = await this.coordinator.store.readState()
    return resolveAccountSelection(state, { accountStorageId: keyId ? this.store.findKey(keyId)?.accountStorageId : null, defaultStorageId: this.store.settings.accountStorageId }).storageId
  }
  private async checkProtection(id: string, keyId?: string): Promise<void> {
    await this.store.ready
    const state = await this.coordinator.store.readState()
    const percent = state.accounts.find(account => account.storageId === id)?.protectionPercent || 0
    if (!percent || (keyId && this.store.findKey(keyId)?.protected && this.store.isKeyUsable(keyId))) return
    let account = state.accounts.find(account => account.storageId === id)
    if (!account) throw new ProxyError('account_not_found', '账号不存在。', 503)
    if (!account.quotaUpdatedAtIso || !Number.isFinite(Date.parse(account.quotaUpdatedAtIso)) || Date.now() - Date.parse(account.quotaUpdatedAtIso) > 30_000) account = await this.coordinator.refreshAccount(id)
    assertQuotaAvailable(account, percent, false)
  }
  private async enforceObservedProtection(account: import('../accountAuthStore.js').StoredAccountEntry): Promise<void> {
    try { assertQuotaAvailable(account, account.protectionPercent || 0, false) }
    catch {
      for (const entry of this.activity.entries.values()) {
        if (entry.storageId === account.storageId && !this.store.findKey(entry.keyId)?.protected) entry.abort()
      }
      await this.coordinator.interruptProtectedUsage(account.storageId).catch(() => undefined)
    }
  }
  private async prepareAccount(id: string, catalog = false): Promise<ComponentGeneration> {
    const component = await this.accountComponents.getOrCreate(id, () => this.accountComponents.size === 0 && !this.component.status().selectedStorageId
      ? this.component
      : new ProxyComponent(join(this.store.directory, 'accounts', id), this.coordinator))
    if (!component) throw new ProxyError('account_capacity', '并行账号数已达8个，请等待连接结束。', 503)
    const generation = await component.prepare(id, { catalog })
    this.generationComponents.set(generation, component)
    return generation
  }
  private invalidateKeys(matches: (keyId: string) => boolean): void {
    for (const key of this.store.listKeys()) {
      if (matches(key.id)) this.activity.abortKey(key.id)
    }
    for (const [id, owner] of this.responseOwners) {
      if (matches(owner.keyId)) this.responseOwners.delete(id)
    }
  }
  readonly notifications: AccountNotificationService
  readonly activation: AccountActivationScheduler
  private readonly accountEpochs = new Map<string, number>()
  accountActivityEpoch(id: string): number { return this.accountEpochs.get(id) || 0 }
  accountHasConnections(id: string): boolean {
    return [...this.activity.entries.values()].some(entry => entry.storageId === id || (!entry.storageId && (this.store.settings.accountStorageId === id || this.component.status().selectedStorageId === id)))
  }
  private recordAccountActivity(id: string): void {
    if (id) this.accountEpochs.set(id, this.accountActivityEpoch(id) + 1)
  }
  readonly store: ProxyStore
  readonly activity = new ProxyActivity()
  readonly component: ProxyComponent
  readonly usage: ProxyUsageStore
  private readonly unregisterLifecycle?: () => void
  private mutation = false
  private epoch = randomUUID()
  private readonly responseOwners = new Map<string, { keyId: string; epoch: string; at: number }>()
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY, perMessageDeflate: false })
  constructor(private coordinator: AccountAuthCoordinator = getAccountAuthCoordinator()) {
    this.store = new ProxyStore(join(coordinator.store.codexHome, 'api-proxy'))
    this.usage = new ProxyUsageStore(this.store.directory)
    this.component = new ProxyComponent(this.store.directory, coordinator)
    this.activation = createAccountActivationRuntime(coordinator, this)
    this.notifications = new AccountNotificationService(coordinator, fetch, true, async () => [
      ...await coordinator.activeUsageAccounts(),
      ...[...this.activity.entries.values()].map(entry => entry.storageId).filter((id): id is string => !!id),
    ])
    coordinator.setQuotaObserver(async account => {
      await this.enforceObservedProtection(account)
      await this.notifications.observe(account)
    })
    coordinator.setSubmissionGuard(async (isChatGPT, policy) => {
      await this.store.ready
      const state = await coordinator.store.readState()
      const storageId = policy?.storageId || state.activeStorageId
      if (!storageId || policy?.protected || !state.accounts.find(account => account.storageId === storageId)?.protectionPercent) return
      if (isChatGPT && !await isChatGPT()) return
      await this.checkProtection(storageId)
    })
    void this.store.ready.catch(() => undefined)
    this.unregisterLifecycle = coordinator.setApiLifecycle({
      isIdle: () => true,
      beforeMutation: async (kind, storageId) => {
        await this.store.ready
        if (kind !== 'remove' && this.mutation) throw new ProxyError('proxy_busy', 'API 出口设置正在变更。', 409)
        const affectedKey = (keyId: string) => {
          const fixed = this.store.findKey(keyId)?.accountStorageId || this.store.settings.accountStorageId
          return kind === 'switch' ? !fixed : fixed === storageId
        }
        if (kind === 'switch') {
          this.invalidateKeys(affectedKey)
        } else {
          for (const entry of this.activity.entries.values()) {
            if (entry.storageId === storageId || affectedKey(entry.keyId)) entry.abort()
          }
          if (storageId) {
            const component = this.accountComponents.get(storageId)
            if (component) await component.stop()
            else if (this.store.settings.accountStorageId === storageId) await this.component.stop()
            this.accountComponents.delete(storageId)
          }
          this.invalidateKeys(affectedKey)
        }
        return () => undefined
      },
    })
  }
  private async authorize(req: IncomingMessage): Promise<string> {
    await this.store.ready
    const raw = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? ''
    const key = this.store.authenticate(raw)
    if (!key) throw new ProxyError('invalid_api_key', '缺少有效的 API key。', 401)
    if (!this.store.settings.enabled) throw new ProxyError('proxy_disabled', 'API 出口未启用。', 503)
    if (this.coordinator.blocksApiAccount(key.accountStorageId || this.store.settings.accountStorageId || null)) throw new ProxyError('account_busy', '所选账号正在变更，请稍后重试。', 503)
    return key.id
  }
  private namespace(keyId: string, value: string): string {
    const digest = hashSecret(`${keyId}:${this.epoch}:${value}`)
    return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`
  }
  private headers(req: IncomingMessage, generation: ComponentGeneration, keyId: string): Record<string, string> {
    const result: Record<string, string> = { Authorization: `Bearer ${generation.key}`, 'Content-Type': 'application/json' }
    for (const name of clientHeaders) {
      const value = req.headers[name]
      if (typeof value === 'string') result[name] = value
    }
    for (const name of sessionHeaders) {
      const value = req.headers[name]
      result[name] = this.namespace(keyId, typeof value === 'string' ? value : name)
    }
    return result
  }
  private adapt(input: Record<string, unknown>, keyId: string, websocket = false): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProxyError('invalid_json', '请求必须是 JSON 对象。')
    if (input.previous_response_id) {
      if (!websocket) throw new ProxyError('unsupported_previous_response_id', 'HTTP 续接请发送完整 input；增量续接使用 WebSocket。')
      const owner = this.responseOwners.get(String(input.previous_response_id))
      if (!owner || owner.keyId !== keyId || owner.epoch !== this.epoch || Date.now() - owner.at > 3600_000) {
        throw new ProxyError('previous_response_not_found', '前一响应上下文不可用，请重连并发送完整上下文。')
      }
    }
    for (const field of ['prompt_cache_retention', 'safety_identifier']) {
      if (input[field] !== undefined) throw new ProxyError('unsupported_parameter', `当前 Codex 上游不支持 ${field}。`)
    }
    return { ...input, prompt_cache_key: this.namespace(keyId, String(input.prompt_cache_key || 'default')) }
  }
  private observe(event: Record<string, any>, keyId: string): void {
    const id = event.response?.id ?? (event.object === 'response' ? event.id : undefined)
    if (typeof id === 'string') {
      this.responseOwners.set(id, { keyId, epoch: this.epoch, at: Date.now() })
      while (this.responseOwners.size > 10_000) this.responseOwners.delete(this.responseOwners.keys().next().value!)
    }
  }
  async handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let entry: Activity | undefined
    let release: (() => void) | undefined
    let settle: ReturnType<ProxyUsageStore['begin']> | undefined
    try {
      const keyId = await this.authorize(req)
      await this.usage.ready
      const url = new URL(req.url || '/', 'http://localhost')
      settle = this.usage.begin(keyId, url.pathname === '/v1/models')
      if (!allowedRoutes.has(`${req.method} ${url.pathname}`)) throw new ProxyError('unsupported_endpoint', '此 API 路径未开放。', 404)
      const accountId = await this.resolveAccount(keyId)
      if (req.method === 'POST') await this.checkProtection(accountId, keyId)
      entry = this.activity.admit(keyId, 'http', this.store.settings)
      entry.storageId = accountId
      this.recordAccountActivity(accountId)
      entry.abort = () => res.destroy()
      const record = entry
      const lease = this.coordinator.executions.register({ storageId: accountId, kind: 'api', ownerId: keyId, protected: this.store.findKey(keyId)?.protected, disconnect: () => record.abort() })
      res.once('close', () => lease.release())
      res.once('finish', () => lease.release())
      const input = req.method === 'POST' ? this.adapt(await body(req), keyId) : undefined
      if (res.destroyed) { settle('interrupted'); this.activity.finish(entry.id, 'interrupted'); return }
      entry.model = typeof input?.model === 'string' ? input.model : null
      const generation = await this.prepareAccount(accountId, req.method === 'GET')
      if (res.destroyed) { settle('interrupted'); this.activity.finish(entry.id, 'interrupted'); return }
      if (!this.store.isKeyUsable(keyId) || await this.resolveAccount(keyId) !== accountId) throw new ProxyError('key_changed', 'Key账号设置已变化，请重试。', 409)
      if (req.method === 'POST') await this.checkProtection(accountId, keyId)
      release = this.owner(generation).hold(generation)
      const headers = this.headers(req, generation, keyId)
      this.store.touch(keyId)
      if (url.pathname === '/v1/responses/compact') {
        await this.compact(req, res, input!, generation, headers, entry, settle)
        release()
        this.activity.finish(entry.id, res.statusCode < 400 ? 'completed' : 'failed')
        return
      }
      this.forwardHttp(req, res, url, input, headers, generation, entry, release, settle)
    } catch (error) {
      settle?.(res.destroyed ? 'interrupted' : entry ? 'failed' : 'rejected')
      release?.()
      if (entry) this.activity.finish(entry.id, 'failed')
      errorResponse(res, error)
    }
  }
  private async compact(req: IncomingMessage, res: ServerResponse, input: Record<string, unknown>, generation: ComponentGeneration,
    headers: Record<string, string>, entry: Activity, settle: ReturnType<ProxyUsageStore['begin']>): Promise<void> {
    if (input.stream === true) throw new ProxyError('streaming_compact_unsupported', 'compact 不支持流式返回。')
    if (!Array.isArray(input.input)) throw new ProxyError('invalid_input', 'compact 的 input 必须为数组。')
    const abort = new AbortController()
    entry.abort = () => { abort.abort(); res.destroy() }
    const onClose = () => { if (!res.writableEnded) abort.abort() }
    res.once('close', onClose)
    try {
      const response = await fetch(`${generation.url}/v1/responses`, { method: 'POST', headers,
        body: JSON.stringify({ ...input, stream: false, store: false, input: [...input.input, { type: 'compaction_trigger' }] }), signal: abort.signal })
      // Compact is unary. Bound its opaque output independently of the long-running stream path.
      const chunks: Uint8Array[] = []
      let size = 0
      if (response.body) for await (const chunk of response.body as any) {
        size += chunk.length
        if (size > MAX_BODY) { abort.abort(); throw new ProxyError('upstream_payload_too_large', '压缩结果超过大小限制。', 502) }
        chunks.push(chunk)
      }
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      this.owner(generation).recordResult(generation, response.status, response.headers.get('retry-after') || undefined)
      if (!response.ok) { settle('failed', extractUsage(parsed)); json(res, response.status, parsed); return }
      const output = Array.isArray(parsed.output) ? parsed.output.filter((item: any) => item.type === 'compaction' && typeof item.encrypted_content === 'string') : []
      if (parsed.status !== 'completed' || output.length !== 1) throw new ProxyError('invalid_compaction', '上游未返回完整的加密压缩结果。', 502)
      // Preserve caller-owned user messages; the opaque item is generated by Codex, never a fabricated summary.
      const retained = input.input.filter((item: any) => item && item.role === 'user' && (!item.type || item.type === 'message'))
      settle(res.destroyed ? 'interrupted' : 'completed', extractUsage(parsed))
      json(res, 200, { id: parsed.id, object: 'response.compaction', created_at: parsed.created_at, output: [...retained, ...output], usage: parsed.usage })
    } finally { res.off('close', onClose) }
  }
  private forwardHttp(req: IncomingMessage, res: ServerResponse, url: URL, input: Record<string, unknown> | undefined,
    headers: Record<string, string>, generation: ComponentGeneration, entry: Activity, release: () => void,
    settle: ReturnType<ProxyUsageStore['begin']>): void {
    const target = new URL(url.pathname + url.search, generation.url)
    let finalized = false
    let completed = false
    let usage: TokenUsage | null = null
    let upstreamResponse: IncomingMessage | undefined
    let upstreamFinishedStatus: string | null = null
    const finalize = (status: string) => {
      if (finalized) return
      upstreamFinishedStatus = status
      if (!res.writableFinished && !res.destroyed) return
      finalized = true
      settle(status as UsageOutcome, usage)
      this.activity.finish(entry.id, status)
      release()
    }
    res.once('finish', () => { if (upstreamFinishedStatus) finalize(upstreamFinishedStatus) })
    res.once('close', () => { if (upstreamFinishedStatus) finalize(upstreamFinishedStatus) })
    const upstream = httpRequest(target, { method: req.method, headers }, response => {
      upstreamResponse = response
      res.statusCode = response.statusCode || 502
      if (res.statusCode >= 400) this.owner(generation).recordResult(generation, res.statusCode, String(response.headers['retry-after'] || ''))
      for (const name of ['content-type', 'retry-after', 'x-request-id', 'x-codex-turn-state', 'openai-processing-ms']) {
        const value = response.headers[name]
        if (value) res.setHeader(name, value)
      }
      res.setHeader('Cache-Control', 'no-store')
      const streaming = String(response.headers['content-type']).includes('text/event-stream')
      if (streaming) entry.transport = 'sse'
      let pending = ''
      let inspected = 0
      const catalog = url.pathname === '/v1/models' && res.statusCode === 200
      const catalogChunks: Buffer[] = []
      const inspect = new Transform({ transform: (chunk, _encoding, callback) => {
        inspected += chunk.length
        if (catalog) {
          if (inspected > 4 * 1024 * 1024) { callback(new ProxyError('catalog_too_large', '模型目录过大。', 502)); return }
          catalogChunks.push(Buffer.from(chunk))
          callback()
          return
        }
        if (streaming) {
          pending += chunk.toString('utf8')
          let newline = pending.indexOf('\n')
          while (newline >= 0) {
            const line = pending.slice(0, newline).trim()
            pending = pending.slice(newline + 1)
            if (line.startsWith('data: ') && line.length < MAX_BODY) {
              try {
                const event = JSON.parse(line.slice(6))
                this.observe(event, entry.keyId)
                if (extractUsage(event)) usage = extractUsage(event)
                if (event.type === 'response.completed') completed = true
                if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) {
                  entry.status = 'failed'
                  this.owner(generation).recordResult(generation, typeof event.status === 'number' ? event.status : 502)
                }
              } catch { /* Comments and [DONE] need no JSON interpretation. */ }
            }
            newline = pending.indexOf('\n')
          }
          if (pending.length > MAX_BODY) { callback(new ProxyError('upstream_frame_too_large', '上游事件过大。', 502)); return }
        } else if (inspected <= MAX_BODY) pending += chunk.toString('utf8')
        callback(null, chunk)
      }, flush: callback => {
        if (!catalog) { callback(); return }
        try {
          const payload = JSON.parse(Buffer.concat(catalogChunks).toString('utf8'))
          // Pinned 7.2.152 advertises ultra in its Codex catalog but rejects it in
          // the executor. Never advertise an effort that this outlet cannot send.
          for (const rows of [payload.models, payload.data]) {
            if (!Array.isArray(rows)) continue
            for (const model of rows) {
              if (Array.isArray(model.supported_reasoning_levels)) {
                model.supported_reasoning_levels = model.supported_reasoning_levels.filter((level: { effort?: string }) => level.effort !== 'ultra')
              }
            }
          }
          callback(null, JSON.stringify(payload))
        } catch { callback(new ProxyError('invalid_catalog', '组件模型目录格式无效。', 502)) }
      } })
      inspect.on('error', () => { upstream.destroy(); response.destroy(); res.destroy() })
      response.once('end', () => {
        if (!streaming) {
          try {
            const parsed = JSON.parse(pending)
            this.observe(parsed, entry.keyId)
            usage = extractUsage(parsed)
            if (parsed.error || ['failed', 'incomplete'].includes(parsed.status)) entry.status = 'failed'
          } catch { /* Forwarding remains independent of optional usage. */ }
        }
        completed ||= !streaming || url.pathname === '/v1/chat/completions'
        if (res.statusCode < 400 && entry.status !== 'failed' && completed) this.owner(generation).recordResult(generation, res.statusCode)
      })
      response.once('aborted', () => res.destroy())
      response.once('error', () => res.destroy())
      response.once('close', () => finalize(res.statusCode >= 400 || entry.status === 'failed' ? 'failed' : response.complete && completed ? 'completed' : 'interrupted'))
      response.pipe(inspect).pipe(res)
    })
    entry.abort = () => { upstream.destroy(); upstreamResponse?.destroy(); res.destroy() }
    res.once('close', () => { if (!res.writableEnded) { upstream.destroy(); upstreamResponse?.destroy() } })
    upstream.once('error', () => {
      this.owner(generation).recordResult(generation, 502, undefined, true)
      finalize('failed')
      errorResponse(res, new ProxyError('upstream_unavailable', '反代组件连接失败，将为后续请求重新准备组件。', 502))
    })
    upstream.once('close', () => { if (!upstreamResponse) finalize('interrupted') })
    upstream.setTimeout(30 * 60_000, () => { upstream.destroy(); upstreamResponse?.destroy(); res.destroy() })
    upstream.end(input ? JSON.stringify(input) : undefined)
  }
  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => {
      const pathname = new URL(req.url || '/', 'http://localhost').pathname
      if (pathname === '/v1' || pathname.startsWith('/v1/')) void this.upgrade(req, socket, head)
    })
  }
  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    let entry: Activity | undefined
    let upstream: WebSocket | undefined
    let release: (() => void) | undefined
    try {
      const keyId = await this.authorize(req)
      await this.usage.ready
      const url = new URL(req.url || '/', 'http://localhost')
      if (url.pathname !== '/v1/responses') throw new ProxyError('unsupported_endpoint', '此 WebSocket 路径未开放。', 404)
      const accountId = await this.resolveAccount(keyId)
      await this.checkProtection(accountId, keyId)
      entry = this.activity.admit(keyId, 'ws', this.store.settings)
      entry.storageId = accountId
      this.recordAccountActivity(accountId)
      entry.abort = () => socket.destroy()
      const admitted = entry
      const accountLease = this.coordinator.executions.register({ storageId: accountId, kind: 'api', ownerId: keyId, protected: this.store.findKey(keyId)?.protected, disconnect: () => admitted.abort() })
      socket.once('close', () => accountLease.release())
      const generation = await this.prepareAccount(accountId)
      if (socket.destroyed) { this.activity.finish(entry.id, 'interrupted'); return }
      release = this.owner(generation).hold(generation)
      upstream = new WebSocket(generation.url.replace('http:', 'ws:') + url.pathname + url.search, {
        headers: this.headers(req, generation, keyId), maxPayload: MAX_BODY, perMessageDeflate: false, handshakeTimeout: 15_000,
      })
      const upstreamSocket = upstream
      await new Promise<void>((resolve, reject) => { upstreamSocket.once('open', resolve); upstreamSocket.once('error', reject) })
      if (socket.destroyed) { upstream.terminate(); release(); this.activity.finish(entry.id, 'interrupted'); return }
      const record = entry
      const releaseGeneration = release
      this.sockets.handleUpgrade(req, socket, head, downstream => {
        let closed = false
        let processing = false
        let settle: ReturnType<ProxyUsageStore['begin']> | null = null
        const cleanup = () => {
          if (closed) return
          closed = true
          settle?.('interrupted')
          settle = null
          downstream.terminate()
          upstreamSocket.terminate()
          // ws 'close' is emitted after the underlying transport is closed.
        }
        upstreamSocket.once('close', () => {
          cleanup()
          this.activity.finish(record.id, record.busy ? 'interrupted' : 'closed')
          releaseGeneration()
        })
        downstream.once('close', cleanup)
        downstream.once('error', cleanup)
        upstreamSocket.on('error', cleanup)
        record.abort = () => {
          if (record.busy) { cleanup(); return }
          downstream.close(1001, 'API route changed')
          const timer = setTimeout(cleanup, 1500)
          timer.unref()
        }
        record.busy = false
        record.status = 'idle'
        const send = (destination: WebSocket, source: WebSocket, data: string | Buffer) => {
          if (destination.readyState !== WebSocket.OPEN) { cleanup(); return }
          if (destination.bufferedAmount > 512 * 1024) source.pause()
          if (destination.bufferedAmount > MAX_BODY) { cleanup(); return }
          destination.send(data, { binary: false }, error => { if (error) cleanup(); else if (!closed) source.resume() })
        }
        upstreamSocket.on('message', (bytes, binary) => {
          if (binary) { cleanup(); return }
          try {
            const event = JSON.parse(bytes.toString())
            this.observe(event, keyId)
            if (['response.completed', 'response.failed', 'response.incomplete', 'error'].includes(event.type)) {
              settle?.(event.type === 'response.completed' ? 'completed' : 'failed', extractUsage(event))
              settle = null
              this.owner(generation).recordResult(generation, event.type === 'response.completed' ? 200 : typeof event.status === 'number' ? event.status : 502)
              record.busy = false
              accountLease.setBusy(false)
              record.status = event.type === 'response.completed' ? 'idle' : 'failed'
              processing = false
            }
          } catch { cleanup(); return }
          send(downstream, upstreamSocket, bytes as Buffer)
        })
        downstream.on('message', async (bytes, binary) => {
          let pending: ReturnType<ProxyUsageStore['begin']> | undefined
          try {
            if (binary) throw new ProxyError('invalid_frame', '只接受 JSON 文本帧。')
            if (!this.store.isKeyUsable(keyId)) throw new ProxyError('invalid_api_key', 'API key 已停用、撤销或到期。', 401)
            pending = this.usage.begin(keyId)
            if (processing || record.busy) throw new ProxyError('response_in_progress', '当前响应尚未结束。', 409)
            if (this.coordinator.blocksApiAccount(this.store.findKey(keyId)?.accountStorageId || this.store.settings.accountStorageId || null)) throw new ProxyError('account_busy', '所选账号正在变更，请稍后重试。', 503)
            const input = JSON.parse(bytes.toString())
            if (!['response.create', 'response.append'].includes(input.type)) throw new ProxyError('unsupported_frame', '不支持此 WebSocket 事件。')
            const adapted = this.adapt(input, keyId, true)
            accountLease.assertCurrent()
            this.activity.begin(record, this.store.settings)
            accountLease.setBusy(true)
            settle = pending
            processing = true
            if (await this.resolveAccount(keyId) !== accountId) throw new ProxyError('account_changed', '账号选择已变化，请重新连接。', 409)
            await this.checkProtection(accountId, keyId)
            // The authenticated upstream socket owns incremental response context.
            // Credential rotation prepares new connections; it must not replace a
            // healthy existing socket between turns. Explicit account/key changes
            // are still enforced by the lease and account selection above.
            if (closed) return
            record.model = typeof input.model === 'string' ? input.model : record.model
            this.store.touch(keyId)
            send(upstreamSocket, downstream, JSON.stringify(adapted))
          } catch (error) {
            pending?.(settle === pending ? 'failed' : 'rejected')
            const known = error instanceof ProxyError ? error : new ProxyError('invalid_frame', '请求帧无效。')
            // Close after a protocol error so an error for a second request cannot terminate the first response ambiguously.
            if (downstream.readyState === WebSocket.OPEN) downstream.send(JSON.stringify({ type: 'error', status: known.status, error: { type: 'invalid_request_error', code: known.code, message: known.message } }), cleanup)
            else cleanup()
          }
        })
      })
    } catch (error) {
      upstream?.terminate()
      release?.()
      if (entry) this.activity.finish(entry.id, 'failed')
      const status = error instanceof ProxyError ? error.status : 503
      if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
  }
  async handleManagement(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.store.ready
      const url = new URL(req.url || '/', 'http://localhost')
      const path = url.pathname.slice('/codex-api/api-proxy'.length)
      if (req.method === 'GET' && path === '/notifications') {
        json(res, 200, { data: await this.notifications.snapshot() })
        return
      }
      if (req.method === 'GET' && path === '/activation') {
        json(res, 200, { data: await this.activation.snapshot() })
        return
      }
      if (req.method === 'GET' && path === '/status') {
        await this.usage.ready
        const selectedId = await this.resolveAccount().catch(() => null)
        const selectedComponent = selectedId ? this.accountComponents.get(selectedId) : null
        json(res, 200, { data: { settings: this.store.settings, ...(selectedComponent || this.component).status(), selectedStorageId: selectedId, installed: await this.component.available(),
          usage: this.usage.summary(url.searchParams.get('timeZone') || 'UTC'),
          activity: this.activity.snapshot(), keys: this.store.listKeys(), manifest: { name: proxyManifest.name, version: proxyManifest.version },
          accounts: await this.coordinator.listAccounts({ scheduleRefresh: false }) } })
        return
      }
      if (req.method === 'GET' && path === '/models') {
        if (!this.store.settings.enabled) throw new ProxyError('proxy_disabled', '请先启用出口。', 503)
        const keyId = url.searchParams.get('keyId') || undefined
        if (keyId && !this.store.findKey(keyId)) throw new ProxyError('key_not_found', 'Key不存在。', 404)
        const selectedId = url.searchParams.get('accountStorageId') || await this.resolveAccount(keyId)
        const generation = await this.prepareAccount(selectedId, true)
        const response = await fetch(`${generation.url}/v1/models`, { headers: { Authorization: `Bearer ${generation.key}` }, signal: AbortSignal.timeout(5000) })
        json(res, response.status, await response.json())
        return
      }
      if (req.method !== 'POST') throw new ProxyError('unsupported_endpoint', '管理接口不存在。', 404)
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new ProxyError('cross_origin', '不接受跨站管理操作。', 403)
      const input = await body(req, 64 * 1024)
      if (path === '/notifications/test') {
        json(res, 200, { data: await this.notifications.test() })
        return
      }
      if (path === '/notifications') {
        try {
          const { protectionChanged, ...next } = await this.notifications.save(input as any)
          if (protectionChanged && input.accountId) {
            const account = (await this.coordinator.store.readState()).accounts.find(account => account.storageId === input.accountId)
            if (account) await this.enforceObservedProtection(account)
          }
          json(res, 200, { data: next })
        }
        catch { throw new ProxyError('invalid_notifications', '通知配置无效，请检查URL、JSON请求体、占位符和时段。') }
        return
      }
      if (path === '/activation') {
        try {
          const next = await this.activation.configure(input)
          await this.notifications.setTimezone(next.settings.timezone)
          json(res, 200, { data: next })
        }
        catch (cause) { throw new ProxyError('invalid_activation_settings', cause instanceof Error ? cause.message : '激活计划保存失败') }
        return
      }
      if (path === '/keys' || path.startsWith('/keys/')) {
        this.store.validateKeyPolicy(input)
        if (input.accountStorageId) {
          const state = await this.coordinator.store.readState()
          if (!state.accounts.some(account => account.storageId === input.accountStorageId)) throw new ProxyError('account_not_found', '所选账号不存在。')
        }
      }
      if (path === '/keys') {
        json(res, 201, { data: await this.store.createKey(String(input.name || ''), typeof input.expiresAt === 'string' ? input.expiresAt : null, input) })
        return
      }
      if (path.startsWith('/keys/')) {
        const id = path.slice('/keys/'.length)
        await this.store.updateKey(id, input as Parameters<ProxyStore['updateKey']>[1])
        if (input.interrupt === true || input.accountStorageId !== undefined || input.protected !== undefined) this.activity.abortKey(id)
        json(res, 200, { ok: true })
        return
      }
      if (path === '/drain') {
        if (this.mutation || this.coordinator.isAccountOperationInProgress()) throw new ProxyError('proxy_busy', '另一项变更正在进行。', 409)
        if (typeof input.draining !== 'boolean') throw new ProxyError('invalid_request', 'draining 必须为布尔值。')
        this.mutation = true
        try {
          if (input.draining) await this.activity.drain(this.store.settings.drainTimeoutSeconds * 1000)
          else this.activity.draining = false
        } finally { this.mutation = false }
        json(res, 200, { data: this.activity.snapshot() })
        return
      }
      if (path === '/settings' || path === '/stop') {
        if (this.mutation) throw new ProxyError('proxy_busy', '出口设置正在变更。', 409)
        this.mutation = true
        const previous = this.store.settings
        let drained = false
        try {
          const settings = path === '/stop' ? { ...previous, enabled: false } : { ...previous, ...(input.settings && typeof input.settings === 'object' && !Array.isArray(input.settings) ? input.settings : {}) } as ProxySettings
          this.store.validateSettings(settings)
          if (settings.accountStorageId) {
            const state = await this.coordinator.listAccounts({ scheduleRefresh: false })
            if (!state.accounts.some(account => account.storageId === settings.accountStorageId)) throw new ProxyError('account_not_found', '所选账号不存在。')
          }
          if (!settings.enabled) {
            await this.activity.drain(previous.drainTimeoutSeconds * 1000, input.force === true)
            drained = true
          }
          // Save the route even when the old account is exhausted or logged out.
          // Credentials and component readiness are checked on actual requests.
          await this.store.saveSettings(settings)
          if (drained) {
            await this.stopComponents()
            this.epoch = randomUUID()
            this.responseOwners.clear()
          } else if (previous.accountStorageId !== settings.accountStorageId) {
            this.invalidateKeys(keyId => !this.store.findKey(keyId)?.accountStorageId)
          }
        } finally {
          this.mutation = false
          this.activity.draining = false
        }
        json(res, 200, { ok: true })
        return
      }
      throw new ProxyError('unsupported_endpoint', '管理接口不存在。', 404)
    } catch (error) { errorResponse(res, error) }
  }
  async close(): Promise<void> {
    await this.activation.dispose()
    await this.notifications.close()
    this.coordinator.setQuotaObserver(null)
    await this.activity.drain(5000, true)
    await this.stopComponents()
    await this.store.close()
    await this.usage.close()
    this.sockets.close()
    this.unregisterLifecycle?.()
    this.coordinator.setSubmissionGuard(null)
  }
}
