import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { AuthRecoveryRegistry } from '../authRecovery'
import { customConnectionModels } from '../customConnections.js'
import type { ThreadQueueState } from '../threadQueue.js'
import { automaticResumeStartedMethod, type AutomaticResumeStarted } from '../threadAutomaticResume.js'
import { getSpawnInvocation } from '../utils/commandInvocation.js'
import { resolveCodexCommand } from '../commandResolution.js'
import { getAccountAuthCoordinator, type RuntimeQuiescenceSnapshot } from './accountAuthCoordinator.js'
import type { ChatgptAuthTokensRefreshParams, ChatgptAuthTokensRefreshResponse } from './accountTokenRefresh.js'
import { resolveAccountSelection, type AccountExecutionLease } from './accountExecution.js'
import { buildAppServerArgs } from './appServerRuntimeConfig.js'
import type { AutomationPreparation } from './automationPreparation.js'
import { AccountResourcePool, WorkerPoolAllocationError, workerPoolAllocationUserMessage } from './accountResourcePool.js'
import {
  ensureDefaultFreeModeStateForMissingAuthSync,
  refreshChatgptAuthTokensForExternalAuth,
} from './appServerRuntimeDependencies.js'
import { readLegacyThreadQueueState } from './legacyThreadQueueStore.js'
import { threadsWithBackgroundTerminals } from './backgroundTerminalReader.js'
import { getCustomConnectionStore, customRuntimeConfig } from './customConnectionStore.js'
import {
  FREE_MODE_STATE_FILE,
  getFreeModeConfigArgs,
  getFreeModeEnvVars,
  getProviderCompatibilityConfigArgs,
} from './freeMode.js'
import { asRecord, getErrorMessage } from './httpUtils.js'
import { IgnoredQuotaErrors } from './ignoredQuotaErrors.js'
import { boundedQuotaRead } from '../quotaRefresh.js'
import { ThreadCompletionList } from './threadCompletionList.js'
import { ThreadInterruptionList } from './threadInterruptionList.js'
import { STREAM_EVENT_BUFFER_LIMIT, type StreamEventFrame } from './threadResponseService.js'
import { getCodexHomeDir, readNonEmptyString } from './runtimePaths.js'

type JsonRpcCall = {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

type JsonRpcResponse = {
  id?: number
  result?: unknown
  error?: {
    code: number
    message: string
  }
  method?: string
  params?: unknown
}

type ServerRequestReply = {
  result?: unknown
  error?: {
    code: number
    message: string
  }
}

export type PendingServerRequest = {
  id: number
  method: string
  params: unknown
  receivedAtIso: string
}

type CapturedItem = {
  id: string
  type: string
  turnId: string
  data: Record<string, unknown>
  completed: boolean
}

const MERGEABLE_ITEM_TYPES = new Set([
  'commandExecution',
  'fileChange',
])

export class AppServerProcess {
  notifyAccountQuota(account: import('./accountAuthStore.js').StoredAccountEntry): void {
    this.emitNotification({ method: 'codexapp/accountQuota/updated', params: { account } })
  }
  private quotaReadFlight: { storageId: string | null; promise: Promise<{ payload: unknown; account: import('./accountAuthStore.js').StoredAccountEntry | null }> } | null = null
  private quotaReadCache: { storageId: string | null; at: number; result: { payload: unknown; account: import('./accountAuthStore.js').StoredAccountEntry | null } } | null = null
  private async readRuntimeQuota(storageId: string | null): Promise<{ payload: unknown; account: import('./accountAuthStore.js').StoredAccountEntry | null }> {
    const coordinator = getAccountAuthCoordinator()
    if (!this.runtimeOptions.isolatedTask && coordinator.blocksNewSubmissions()) throw new Error('账号正在切换，稍后读取额度')
    if (this.quotaReadFlight?.storageId === storageId) return boundedQuotaRead(this.quotaReadFlight.promise)
    if (this.quotaReadCache?.storageId === storageId && Date.now() - this.quotaReadCache.at < 2000) return this.quotaReadCache.result
    const revision = storageId ? coordinator.quotaRevision(storageId) : 0
    const promise = (async () => {
      const payload = await coordinator.readQuotaWithBackoff(storageId || 'runtime', () => this.call('account/rateLimits/read', null))
      const account = storageId ? await coordinator.applyRuntimeQuotaRead(storageId, payload, revision) : null
      const result = { payload, account }
      this.quotaReadCache = !storageId || revision === coordinator.quotaRevision(storageId) ? { storageId, at: Date.now(), result } : null
      return result
    })()
    this.quotaReadFlight = { storageId, promise }
    const clear = () => { if (this.quotaReadFlight?.promise === promise) this.quotaReadFlight = null }
    void promise.then(clear, clear)
    return boundedQuotaRead(promise)
  }
  quotaBlocked: (threadId: string, turnId: string) => Promise<void> = async () => {}
  notifyQuotaErrorIgnored(threadId: string): void { this.emitNotification({ method: 'thread/quotaErrorIgnored/changed', params: { threadId } }) }
  notifyQuotaResumeChanged(): void { this.emitNotification({ method: 'thread/quotaResume/changed', params: {} }) }
  notifyScheduledResumeChanged(): void { this.emitNotification({ method: 'thread/scheduledResume/changed', params: {} }) }
  notifyAutomaticResumeStarted(params: AutomaticResumeStarted): void {
    // This notice does not change thread history or live state.
    for (const listener of this.notificationListeners) listener({ method: automaticResumeStartedMethod, params })
  }
  async observeAccountQuota(payload: unknown): Promise<void> {
    this.quotaReadCache = null
    const coordinator = getAccountAuthCoordinator()
    const id = await this.runtimeAccountId()
    if (id && !getCustomConnectionStore().get(id)) await coordinator.observeRuntimeQuota(id, payload)
  }
  constructor(private readonly runtimeOptions: { isolatedTask?: boolean; requestIdOffset?: number } = {}) {
    this.nextId = runtimeOptions.requestIdOffset || 1
  }
  /** Invoked only for abnormal child exits (dispose() paths set `stopping` first). */
  onProcessExited: () => void = () => {}
  workerPoolDiagnostics() {
    return this.sessionWorkers.snapshot()
  }
  private runtimeStorageId: string | null = null
  private assignedStorageId: string | null = null
  private sessionOperations = 0
  private closingSession: Promise<void> | null = null
  private executionLease: AccountExecutionLease | null = null
  private taskLease: { runId: string; storageId: string | null; protected: boolean } | null = null
  private readonly acquiringAccounts = new Set<string>()
  // Native unsubscribe retains a writer for 30 minutes. A session therefore
  // keeps one process across chat and automation; credentials change only at
  // that session's boundary. Idle eviction closes the process and awaits exit.
  private readonly sessionWorkers = new AccountResourcePool<AppServerProcess>({
    capacity: 16,
    // A wedged worker must never wedge the allocation chain: every allocation
    // has a total deadline, candidate idle checks have their own shorter cap,
    // and reclaiming waits for a real child exit only up to a hard cap.
    allocationTimeoutMs: 45_000,
    idleCheckTimeoutMs: 5_000,
    disposeTimeoutMs: 15_000,
    metrics: worker => ({
      busy: !!(worker.currentTaskRun || worker.sessionOperations || worker.activeTurnThreadIds.size || worker.pendingServerRequests.size || worker.pending.size),
      activeTurns: worker.activeTurnThreadIds.size,
      nativeRpcs: worker.pending.size,
      serverRequests: worker.pendingServerRequests.size,
    }),
    idle: async (worker, _key, scope) => {
      if (worker.currentTaskRun || worker.sessionOperations || worker.activeTurnThreadIds.size || worker.pendingServerRequests.size || worker.pending.size) return false
      if (!worker.process) return true
      const terminals = await threadsWithBackgroundTerminals((method, params) => worker.rpc(method, params, undefined, scope))
      return !terminals.length && !worker.currentTaskRun && !worker.sessionOperations && !worker.activeTurnThreadIds.size && !worker.pendingServerRequests.size && !worker.pending.size
    },
    dispose: worker => worker.closeSession(),
  })
  private readonly taskRuns = new Map<string, AppServerProcess>()
  private readonly taskPreparations = new Map<string, { scope: AutomationPreparation; worker?: AppServerProcess; owned: boolean; releaseRequested?: boolean }>()
  private readonly ownedThreadIds = new Set<string>()
  private nextWorkerId = 1
  private nextForwardedRequestId = -1
  private readonly forwardedRequests = new Map<number, { worker: AppServerProcess; nativeId: number }>()
  private currentTaskRun: string | null = null

  private threadWorker(threadId: string): AppServerProcess | undefined {
    if (!threadId) return undefined
    return [...this.sessionWorkers.availableValues()].find(worker => worker.ownedThreadIds.has(threadId)) || this.sessionWorkers.getAvailable(threadId)
  }
  private readonly manualTurnInterrupts = new Map<string, symbol>()

  markManualTurnInterrupt(threadId: string, turnId: string): () => void {
    const owner = this.threadWorker(threadId)
    if (owner) return owner.markManualTurnInterrupt(threadId, turnId)
    if (!threadId || !turnId) return () => {}
    const key = JSON.stringify([threadId, turnId])
    const token = Symbol()
    this.manualTurnInterrupts.set(key, token)
    if (this.manualTurnInterrupts.size > 256) this.manualTurnInterrupts.delete(this.manualTurnInterrupts.keys().next().value!)
    // Keep a bounded receipt after success so duplicate terminal events stay silent.
    return () => {
      if (this.manualTurnInterrupts.get(key) === token) this.manualTurnInterrupts.delete(key)
    }
  }

  private runtimeAccountId(): Promise<string | null> {
    if (this.runtimeOptions.isolatedTask) return Promise.resolve(this.assignedStorageId)
    if (this.runtimeStorageId) return Promise.resolve(this.runtimeStorageId)
    return getAccountAuthCoordinator().store.readState().then(state => state.activeStorageId)
  }
  private async closeSession(): Promise<void> {
    this.dispose()
    await this.closingSession
  }
  private async sessionWorker(key: string, scope?: AutomationPreparation): Promise<AppServerProcess | null> {
    scope?.assertActive()
    const owned = this.threadWorker(key)
    if (owned) {
      // Touch the pool so an asynchronous idle check cannot evict this use.
      const entry = [...this.sessionWorkers].find(([, worker]) => worker === owned)!
      return this.mapAllocationError(this.sessionWorkers.getOrCreate(entry[0], () => owned, true, scope))
    }
    return this.mapAllocationError(this.sessionWorkers.getOrCreate(key, () => {
      const worker = new AppServerProcess({ isolatedTask: true, requestIdOffset: this.nextWorkerId++ * 1_000_000 })
      worker.quotaBlocked = (threadId, turnId) => this.quotaBlocked(threadId, turnId)
      // An abnormally exited worker must release its pool slot immediately;
      // its exit handler clears owned threads and pending work.
      worker.onProcessExited = () => {
        if (this.sessionWorkers.get(key) === worker) this.sessionWorkers.delete(key)
      }
      worker.onNotification(notification => {
        if (notification.method === 'account/rateLimits/updated') void worker.observeAccountQuota(notification.params).catch(() => undefined)
        if (/^(account\/|codexapp\/runtime\/)/.test(notification.method)) return
        this.activityRevision++
        const forwarded = this.remapTaskRequest(worker, notification)
        this.forwardTaskNotification(worker.currentTaskRun
          ? { ...forwarded, params: { ...asRecord(forwarded.params), completionKind: 'background' } }
          : forwarded)
      })
      return worker
    }, true, scope))
  }
  private mapAllocationError(allocation: Promise<AppServerProcess | null>): Promise<AppServerProcess | null> {
    return allocation.catch(error => {
      if (!(error instanceof WorkerPoolAllocationError)) throw error
      console.info(`[worker-pool] allocation failed code=${error.code} ${this.sessionWorkers.snapshotJson()}`)
      throw Object.assign(new Error(workerPoolAllocationUserMessage(error.code)), { rpcRejected: true, submissionNotSent: true, workerPoolCode: error.code })
    })
  }
  private async configureSession(storageId: string | null, kind: 'primary' | 'automation', ownerId: string, scope?: AutomationPreparation): Promise<void> {
    scope?.assertActive()
    if (this.assignedStorageId !== storageId && (this.activeTurnThreadIds.size || this.pendingServerRequests.size)) {
      throw Object.assign(new Error('会话运行中，暂不能更换账号。'), { rpcRejected: true, submissionNotSent: true })
    }
    const coordinator = getAccountAuthCoordinator()
    const changed = this.assignedStorageId !== storageId
    const initialized = this.initialized
    const customChanged = changed && (!!getCustomConnectionStore().get(storageId) || !!getCustomConnectionStore().get(this.assignedStorageId))
    if (customChanged && this.process) await this.closeSession()
    scope?.assertActive()
    this.assignedStorageId = storageId
    this.executionLease?.release()
    this.executionLease = storageId ? coordinator.executions.register({ storageId, kind, ownerId, protected: this.taskLease?.protected, busy: !!this.currentTaskRun || !!this.activeTurnThreadIds.size, disconnect: () => this.dispose() }) : null
    const lease = this.executionLease
    try {
      await this.ensureInitialized(scope)
      scope?.assertActive()
      if (initialized && changed && !customChanged) {
        if (storageId) {
          const credential = scope ? await scope.read(() => coordinator.getApiCredential(storageId)) : await coordinator.getApiCredential(storageId)
          scope?.assertActive()
          await this.call('account/login/start', { type: 'chatgptAuthTokens', accessToken: credential.accessToken, chatgptAccountId: credential.accountId })
          scope?.assertActive()
        } else {
          await this.closeSession()
          scope?.assertActive()
          await this.ensureInitialized(scope)
        }
        this.quotaReadCache = null
      }
      lease?.assertCurrent()
    } catch (error) {
      if (!scope?.signal.aborted || error !== scope.signal.reason) this.dispose()
      throw error
    }
  }
  stopTaskRouting(): void {
    for (const worker of this.sessionWorkers.values()) worker.dispose()
    this.sessionWorkers.clear()
    this.taskRuns.clear()
    this.forwardedRequests.clear()
  }
  taskAccountBusy(): boolean { return !!this.currentTaskRun }

  beginTaskPreparation(runId: string, scope: AutomationPreparation): void {
    const entry = { scope, owned: false } as { scope: AutomationPreparation; worker?: AppServerProcess; owned: boolean; releaseRequested?: boolean }
    this.taskPreparations.set(runId, entry)
    scope.onCancel(async () => {
      const worker = entry.worker
      if (!entry.owned || !worker || worker.currentTaskRun !== runId
        || worker.activeTurnThreadIds.size || worker.pendingServerRequests.size || worker.sessionOperations) return
      await worker.closeOwnedPreparationProcess(scope)
    })
  }

  private async closeOwnedPreparationProcess(scope: AutomationPreparation): Promise<void> {
    if (this.activeTurnThreadIds.size || this.pendingServerRequests.size || this.sessionOperations) return
    for (const id of this.ownedThreadIds) scope.discardedThreadIds.add(id)
    // Keep the account busy until confirmed process exit, even though dispose()
    // normally releases a lease immediately for an explicit runtime shutdown.
    const lease = this.executionLease
    this.executionLease = null
    const process = this.process
    await this.closeSession()
    if (process && process.exitCode === null && process.signalCode === null) throw new Error('自动化准备进程尚未退出')
    lease?.release()
  }

  endTaskPreparation(runId: string): void {
    const entry = this.taskPreparations.get(runId)
    this.taskPreparations.delete(runId)
    if (entry?.releaseRequested) this.releaseTaskAccount(runId)
  }

  async acquireTaskAccount(runId: string, settings: import('../automationOptions.js').AutomationModelSettings & { targetThreadId?: string | null }, scope?: AutomationPreparation): Promise<boolean> {
    scope?.assertActive()
    if (this.taskRuns.has(runId)) return true
    if (this.taskRuns.size + this.acquiringAccounts.size >= 4 || this.acquiringAccounts.has(runId)) return false
    this.acquiringAccounts.add(runId)
    let worker: AppServerProcess | null = null
    try {
      const coordinator = getAccountAuthCoordinator()
      const state = scope ? await scope.read(() => coordinator.store.readState()) : await coordinator.store.readState()
      const config = settings.accountStorageId ? null : asRecord(asRecord(await this.rpc('config/read', {}, undefined, scope))?.config)
      const followsOtherProvider = !settings.accountStorageId && !settings.protected && config?.model_provider && config.model_provider !== 'openai'
      if (scope) await scope.read(() => getCustomConnectionStore().ready)
      else await getCustomConnectionStore().ready
      scope?.assertActive()
      const custom = settings.accountStorageId ? getCustomConnectionStore().get(settings.accountStorageId) : getCustomConnectionStore().active()
      if (custom && custom.wireApi === 'chat' && !custom.protocolBridge) throw new Error('该连接仅支持 Chat Completions，可在账号设置中开启协议转换')
      const storageId = custom?.storageId || (followsOtherProvider ? null : resolveAccountSelection(state, settings).storageId)
      if (coordinator.blocksApiAccount(settings.accountStorageId || null)) return false
      if (storageId && !custom) {
        if (scope) await scope.read(() => coordinator.getApiCredential(storageId))
        else await coordinator.getApiCredential(storageId)
        const account = scope ? await scope.read(() => coordinator.refreshAccount(storageId)) : await coordinator.refreshAccount(storageId)
        const fresh = account.quotaUpdatedAtIso && Date.now() - Date.parse(account.quotaUpdatedAtIso) < 30000
        const windows = [account.quotaSnapshot?.primary, account.quotaSnapshot?.secondary].filter(Boolean)
        if (fresh && windows.some(window => window!.usedPercent >= 100)) return false
        try {
          if (scope) await scope.read(() => coordinator.assertSubmissionAllowed(undefined, { storageId, protected: settings.protected }))
          else await coordinator.assertSubmissionAllowed(undefined, { storageId, protected: settings.protected })
        }
        catch { return false }
      }
      scope?.assertActive()
      worker = await this.sessionWorker(settings.targetThreadId || `run:${runId}`, scope)
      scope?.assertActive()
      if (!worker || worker.currentTaskRun || worker.sessionOperations || worker.activeTurnThreadIds.size || worker.pendingServerRequests.size) return false
      worker.taskLease = { runId, storageId, protected: settings.protected === true }
      worker.currentTaskRun = runId
      this.taskRuns.set(runId, worker)
      const preparation = this.taskPreparations.get(runId)
      if (preparation) {
        preparation.worker = worker
        preparation.owned = !settings.targetThreadId
      }
      await worker.configureSession(storageId, 'automation', runId, scope)
      scope?.assertActive()
      return true
    } catch (error) {
      this.releaseTaskAccount(runId)
      throw error
    } finally {
      this.acquiringAccounts.delete(runId)
    }
  }
  taskAccountStorageId(runId: string): string | null | undefined {
    return this.taskRuns.get(runId)?.assignedStorageId
  }
  releaseTaskAccount(runId: string): void {
    const preparation = this.taskPreparations.get(runId)
    if (preparation) {
      preparation.releaseRequested = true
      return
    }
    const worker = this.taskRuns.get(runId)
    if (!worker) return
    worker.currentTaskRun = null
    worker.taskLease = null
    worker.executionLease?.setBusy(!!worker.activeTurnThreadIds.size)
    this.taskRuns.delete(runId)
  }

  async automationRpc(method: string, params: unknown, runId?: string, preparationScope?: AutomationPreparation): Promise<unknown> {
    const scope = runId ? this.taskPreparations.get(runId)?.scope : preparationScope
    scope?.assertActive()
    const worker = runId ? this.taskRuns.get(runId) : this.threadWorker(readNonEmptyString(asRecord(params)?.threadId))
    if (!worker && runId) throw Object.assign(new Error('自动化账号连接已释放，本次操作未发送'), { rpcRejected: true, submissionNotSent: true })
    if (!worker) return this.rpc(method, params, undefined, scope)
    const input = worker.taskLease?.storageId && ['thread/start', 'thread/resume'].includes(method)
      ? { ...asRecord(params), modelProvider: getCustomConnectionStore().get(worker.taskLease.storageId) ? `custom_${worker.taskLease.storageId}` : 'openai' }
      : params
    return worker.rpc(method, input, worker.taskLease?.runId, scope)
  }
  private remapTaskRequest(worker: AppServerProcess, notification: { method: string; params: unknown }): { method: string; params: unknown } {
    const params = asRecord(notification.params)
    const nativeId = params?.id
    if (!['server/request', 'server/request/resolved'].includes(notification.method) || typeof nativeId !== 'number') return notification
    let id = [...this.forwardedRequests].find(([, entry]) => entry.worker === worker && entry.nativeId === nativeId)?.[0]
    if (notification.method === 'server/request' && id === undefined) {
      id = this.nextForwardedRequestId--
      this.forwardedRequests.set(id, { worker, nativeId })
    }
    if (id === undefined) return notification
    if (notification.method === 'server/request/resolved') this.forwardedRequests.delete(id)
    return { ...notification, params: { ...params, id } }
  }
  private forwardTaskNotification(notification: { method: string; params: unknown }): void {
    this.recordStreamEvent(notification)
    this.captureItemFromNotification(notification)
    const id = this.extractThreadIdFromParams(notification.params)
    if (id) this.invalidateLiveStateCache(id)
    for (const listener of this.notificationListeners) listener(notification)
  }

  accountDisconnected: (storageId: string, primary: boolean, runIds: string[]) => void = () => {}
  async disconnectAccount(storageId: string, wasActive = false): Promise<void> {
    const affected = [...this.sessionWorkers].filter(([, worker]) => worker.assignedStorageId === storageId)
    const runIds = [...this.taskRuns].filter(([, runtime]) => affected.some(([, worker]) => worker === runtime)).map(([id]) => id)
    for (const [key, worker] of affected) {
      worker.dispose()
      this.sessionWorkers.delete(key)
      for (const [id, request] of this.forwardedRequests) if (request.worker === worker) this.forwardedRequests.delete(id)
    }
    for (const id of runIds) this.taskRuns.delete(id)
    await Promise.all(affected.map(([, worker]) => worker.closeSession()))
    if (wasActive || this.runtimeStorageId === storageId) {
      this.dispose()
      this.runtimeStorageId = null
    }
    this.accountDisconnected(storageId, wasActive, runIds)
    this.forwardTaskNotification({ method: 'codexapp/account/removed', params: { storageId } })
  }

  async reloadAccount(storageId: string): Promise<void> {
    const credential = await getAccountAuthCoordinator().store.readCredential(storageId)
    await this.ensureInitialized()
    await this.call('account/login/start', { type: 'chatgptAuthTokens', accessToken: credential.auth.tokens!.access_token, chatgptAccountId: credential.identity.accountId })
    this.runtimeStorageId = storageId
    this.executionLease?.release()
    this.executionLease = getAccountAuthCoordinator().executions.register({ storageId, kind: 'primary', ownerId: 'primary', busy: this.activeTurnThreadIds.size > 0, disconnect: () => this.dispose() })
    this.quotaReadCache = null
    this.authRecovery.clear()
  }

  readonly authRecovery = new AuthRecoveryRegistry()
  automationActivity: () => string[] = () => []
  backgroundActivity: () => Promise<string[]> = async () => []
  private queueStateBinding: { read: () => Promise<ThreadQueueState> } | null = null

  bindQueueStateReader(read: () => Promise<ThreadQueueState>): () => void {
    if (this.queueStateBinding) throw new Error('队列状态读取已绑定')
    const binding = { read }
    this.queueStateBinding = binding
    this.activityRevision++
    return () => {
      if (this.queueStateBinding !== binding) return
      this.queueStateBinding = null
      this.activityRevision++
    }
  }

  private readQueueState(): Promise<ThreadQueueState> {
    if (this.queueStateBinding) return this.queueStateBinding.read()
    return this.runtimeOptions.isolatedTask ? Promise.resolve({}) : readLegacyThreadQueueState()
  }
  private process: ChildProcessWithoutNullStreams | null = null
  private initialized = false
  private initializePromise: Promise<void> | null = null
  private readBuffer = ''
  private nextId = 1
  private stopping = false
  private readonly pending = new Map<number, { method: string; resolve: (value: unknown) => void; reject: (reason?: unknown) => void }>()
  private readonly notificationListeners = new Set<(value: { method: string; params: unknown }) => void>()
  private readonly pendingServerRequests = new Map<number, PendingServerRequest>()
  private readonly streamEventsByThreadId = new Map<string, StreamEventFrame[]>()
  private readonly lastThreadReadSnapshotByThreadId = new Map<string, unknown>()
  private readonly capturedItemsByThreadId = new Map<string, Map<string, CapturedItem>>()
  private readonly liveStateCache = new Map<string, { data: unknown; turnCount: number; sessionSize: number }>()
  private chatgptAuthRefreshPromise: Promise<ChatgptAuthTokensRefreshResponse> | null = null
  private readonly activeTurnThreadIds = new Set<string>()
  private readonly activeTurnIds = new Map<string, string>()
  private readonly terminalTurnIds = new Set<string>()
  private readonly accountFailureInterrupts = new Set<string>()
  private activityRevision = 0
  private activeConfigSignature = ''


  private getCodexCommand(): string {
    const codexCommand = resolveCodexCommand()
    if (!codexCommand) {
      throw new Error('Codex CLI is not available. Install @openai/codex or set CODEXUI_CODEX_COMMAND.')
    }
    return codexCommand
  }

  private buildAppServerConfig(): { args: string[]; env: Record<string, string> } {
    const args = buildAppServerArgs()
    const connections = getCustomConnectionStore()
    const custom = this.runtimeOptions.isolatedTask ? connections.get(this.assignedStorageId) : undefined
    if (custom) {
      const config = customRuntimeConfig(custom, Number(process.env.CODEXUI_SERVER_PORT) || 4173)
      return { args: [...args, ...config.args], env: config.env }
    }
    if ((!this.runtimeOptions.isolatedTask && connections.explicitSelection()) || (this.runtimeOptions.isolatedTask && this.assignedStorageId)) {
      args.push('-c', 'model_provider="openai"')
      return { args, env: {} }
    }
    let extraEnv: Record<string, string> = {}
    const serverPort = parseInt(process.env.CODEXUI_SERVER_PORT ?? '', 10) || undefined
    args.push(...getProviderCompatibilityConfigArgs(serverPort))
    const statePath = join(getCodexHomeDir(), FREE_MODE_STATE_FILE)
    try {
      const state = ensureDefaultFreeModeStateForMissingAuthSync(statePath)
      if (state) {
        args.push(...getFreeModeConfigArgs(state, serverPort))
        extraEnv = getFreeModeEnvVars(state)
      }
    } catch {
      // No free-mode state or invalid — use defaults
    }
    return { args, env: extraEnv }
  }

  private async withRuntimeThreadProvider(params: unknown): Promise<Record<string, unknown>> {
    const input = asRecord(params) ?? {}
    const custom = this.runtimeOptions.isolatedTask ? getCustomConnectionStore().get(this.assignedStorageId) : undefined
    if (custom) return { ...input, modelProvider: `custom_${custom.storageId}` }
    const result = asRecord(await this.call('config/read', {}))
    const config = asRecord(result?.config)
    // Resume/fork otherwise inherit the rollout's provider, which may only
    // exist in a previous custom worker. Use this worker's selected outlet;
    // do not register other providers or mutate the global account selection.
    return { ...input, modelProvider: readNonEmptyString(config?.model_provider) || 'openai' }
  }

  private getAppServerConfigSignature(config: { args: string[]; env: Record<string, string> }): string {
    return JSON.stringify({
      args: config.args,
      env: Object.keys(config.env)
        .sort()
        .map((key) => [key, config.env[key]]),
    })
  }

  private disposeIfConfigChanged(): void {
    if (!this.process) return
    const config = this.buildAppServerConfig()
    const nextSignature = this.getAppServerConfigSignature(config)
    if (this.activeConfigSignature === nextSignature) return
    this.dispose()
  }

  private start(): void {
    if (this.process) return

    this.stopping = false
    const config = this.buildAppServerConfig()
    this.activeConfigSignature = this.getAppServerConfigSignature(config)
    const invocation = getSpawnInvocation(this.getCodexCommand(), config.args)
    const spawnEnv = Object.keys(config.env).length > 0
      ? { ...process.env, ...config.env }
      : undefined
    const proc = spawn(invocation.command, invocation.args, { stdio: ['pipe', 'pipe', 'pipe'], ...(spawnEnv ? { env: spawnEnv } : {}) })
    this.process = proc

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      this.readBuffer += chunk

      let lineEnd = this.readBuffer.indexOf('\n')
      while (lineEnd !== -1) {
        const line = this.readBuffer.slice(0, lineEnd).trim()
        this.readBuffer = this.readBuffer.slice(lineEnd + 1)

        if (line.length > 0) {
          this.handleLine(line)
        }

        lineEnd = this.readBuffer.indexOf('\n')
      }
    })

    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', () => {
      // Keep stderr silent in dev middleware; JSON-RPC errors are forwarded via responses.
    })

    proc.on('exit', () => {
      if (this.process !== proc) {
        return
      }

      const failure = new Error(this.stopping ? 'codex app-server stopped' : 'codex app-server exited unexpectedly')
      for (const request of this.pending.values()) {
        request.reject(failure)
      }

      this.pending.clear()
      this.pendingServerRequests.clear()
      this.process = null
      this.initialized = false
      this.initializePromise = null
      this.readBuffer = ''
      this.activeTurnThreadIds.clear()
      this.activeTurnIds.clear()
      this.terminalTurnIds.clear()
      this.ownedThreadIds.clear()
      this.emitNotification({ method: 'codexapp/runtime/stopped', params: {} })
      if (!this.stopping) {
        // Abnormal exit: the owning pool must release the slot so a fresh
        // worker can be allocated instead of routing into a dead process.
        this.onProcessExited()
      }
    })
  }

  private sendLine(payload: Record<string, unknown>): void {
    if (!this.process) {
      throw new Error('codex app-server is not running')
    }

    this.process.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse
    try {
      message = JSON.parse(line) as JsonRpcResponse
    } catch {
      return
    }

    if (typeof message.id === 'number' && !message.method && this.pending.has(message.id)) {
      const pendingRequest = this.pending.get(message.id)
      this.pending.delete(message.id)

      if (!pendingRequest) return

      if (message.error) {
        pendingRequest.reject(Object.assign(new Error(message.error.message), { rpcRejected: true, data: (message.error as { data?: unknown }).data }))
      } else {
        pendingRequest.resolve(message.result)
      }
      return
    }

    if (typeof message.method === 'string' && typeof message.id !== 'number') {
      this.emitNotification({
        method: message.method,
        params: message.params ?? null,
      })
      return
    }

    // Handle server-initiated JSON-RPC requests (approvals, dynamic tool calls, etc.).
    if (typeof message.id === 'number' && typeof message.method === 'string') {
      this.handleServerRequest(message.id, message.method, message.params ?? null)
    }
  }

  private ignoredErrorMarks: IgnoredQuotaErrors | null = null
  get ignoredErrors(): IgnoredQuotaErrors {
    return this.ignoredErrorMarks ??= new IgnoredQuotaErrors(getCodexHomeDir())
  }

  private interruptionList: ThreadInterruptionList | null = null
  get interruptions(): ThreadInterruptionList {
    return this.interruptionList ??= new ThreadInterruptionList(getCodexHomeDir(), this.ignoredErrors, (threadId, issues) => {
      for (const listener of this.notificationListeners) {
        listener({ method: 'codexapp/interruptions/changed', params: { threadId, issues } })
      }
    })
  }

  private completionList: ThreadCompletionList | null = null
  get completions(): ThreadCompletionList {
    return this.completionList ??= new ThreadCompletionList(join(getCodexHomeDir(), 'codexapp-thread-completions-v1.json'), (threadId, token, kind) => {
      for (const listener of this.notificationListeners) {
        listener({ method: 'codexapp/completions/changed', params: { threadId, token, ...(kind ? { kind } : {}) } })
      }
    })
  }

  notifyQueueChanged(threadId: string): void {
    this.activityRevision++
    // Queue changes do not invalidate thread history or live item caches.
    for (const listener of this.notificationListeners) {
      listener({ method: 'codexapp/queue/changed', params: { threadId } })
    }
  }

  private emitNotification(notification: { method: string; params: unknown }): void {
    if (['turn/completed', 'turn/cancelled', 'error'].includes(notification.method)) {
      const params = asRecord(notification.params)
      const threadId = this.extractThreadIdFromParams(params)
      const turnId = readNonEmptyString(asRecord(params?.turn)?.id) || readNonEmptyString(params?.turnId) || this.activeTurnIds.get(threadId)
      if (turnId && this.manualTurnInterrupts.has(JSON.stringify([threadId, turnId]))) {
        notification = { ...notification, params: { ...params, turnId, interruptionReason: 'user' } }
      }
    }
    if (/^(turn\/(started|completed|cancelled)|thread\/(started|status\/changed|goal\/updated)|server\/request(?:\/resolved)?|codexapp\/runtime\/stopped)$/.test(notification.method)) {
      this.activityRevision++
    }
    this.authRecovery.observe(notification.method, notification.params)
    if (notification.method === 'error') {
      const payload = asRecord(notification.params)
      const error = asRecord(payload?.error)
      const detail = JSON.stringify([error?.message, error?.codexErrorInfo])
      const threadId = this.extractThreadIdFromParams(notification.params)
      const turnId = readNonEmptyString(payload?.turnId) || this.activeTurnIds.get(threadId)
      if (threadId && turnId && /usage.?limit|quota|rate.?limit|429|额度|限额|token_revoked|invalid_grant|authentication|unauthorized|\b401\b/i.test(detail) && !this.accountFailureInterrupts.has(turnId)) {
        this.accountFailureInterrupts.add(turnId)
        if (/usage.?limit|quota|rate.?limit|429|额度|限额/i.test(detail)) void this.quotaBlocked(threadId, turnId).catch(() => undefined)
        void this.call('turn/interrupt', { threadId, turnId }).catch(() => undefined)
      }
    }
    const notificationThreadId = this.extractThreadIdFromParams(notification.params)
    if (notificationThreadId && this.runtimeOptions.isolatedTask && notification.method === 'thread/started') this.ownedThreadIds.add(notificationThreadId)
    if (notificationThreadId && notification.method === 'turn/started') {
      this.executionLease?.setBusy(true)
      this.activeTurnThreadIds.add(notificationThreadId)
      const params = asRecord(notification.params)
      const turnId = readNonEmptyString(asRecord(params?.turn)?.id) || readNonEmptyString(params?.turnId)
      if (turnId) this.activeTurnIds.set(notificationThreadId, turnId)
    }
    if (notificationThreadId && (notification.method === 'turn/completed' || notification.method === 'turn/cancelled')) {
      const finishedTurnId = readNonEmptyString(asRecord(asRecord(notification.params)?.turn)?.id) || this.activeTurnIds.get(notificationThreadId)
      if (finishedTurnId) {
        this.terminalTurnIds.add(finishedTurnId)
        if (this.terminalTurnIds.size > 256) this.terminalTurnIds.delete(this.terminalTurnIds.values().next().value!)
      }
      if (finishedTurnId) this.accountFailureInterrupts.delete(finishedTurnId)
      this.activeTurnThreadIds.delete(notificationThreadId)
      this.activeTurnIds.delete(notificationThreadId)
      this.executionLease?.setBusy(this.activeTurnThreadIds.size > 0)
    }
    this.recordStreamEvent(notification)
    this.captureItemFromNotification(notification)
    const nThreadId = this.extractThreadIdFromParams(notification.params)
    if (nThreadId) {
      this.invalidateLiveStateCache(nThreadId)
    }
    for (const listener of this.notificationListeners) {
      listener(notification)
    }
  }

  private extractThreadIdFromParams(params: unknown): string {
    const record = asRecord(params)
    if (!record) return ''
    const threadId =
      (typeof record.threadId === 'string' ? record.threadId : '') ||
      (typeof record.thread_id === 'string' ? record.thread_id : '') ||
      (typeof record.conversationId === 'string' ? record.conversationId : '') ||
      (typeof record.conversation_id === 'string' ? record.conversation_id : '')
    if (threadId) return threadId
    const thread = asRecord(record.thread)
    if (thread && typeof thread.id === 'string') return thread.id
    const turn = asRecord(record.turn)
    if (turn) {
      const turnThreadId =
        (typeof turn.threadId === 'string' ? turn.threadId : '') ||
        (typeof turn.thread_id === 'string' ? turn.thread_id : '')
      if (turnThreadId) return turnThreadId
    }
    return ''
  }

  private recordStreamEvent(notification: { method: string; params: unknown }): void {
    const threadId = this.extractThreadIdFromParams(notification.params)
    if (!threadId) return
    const frame: StreamEventFrame = {
      method: notification.method,
      params: notification.params,
      atIso: new Date().toISOString(),
    }
    let buffer = this.streamEventsByThreadId.get(threadId)
    if (!buffer) {
      buffer = []
      this.streamEventsByThreadId.set(threadId, buffer)
    }
    buffer.push(frame)
    if (buffer.length > STREAM_EVENT_BUFFER_LIMIT) {
      buffer.splice(0, buffer.length - STREAM_EVENT_BUFFER_LIMIT)
    }
  }

  getStreamEvents(threadId: string, limit: number): StreamEventFrame[] {
    const buffer = this.streamEventsByThreadId.get(threadId)
    if (!buffer || buffer.length === 0) return []
    return buffer.slice(-limit)
  }

  storeThreadReadSnapshot(threadId: string, snapshot: unknown): void {
    this.lastThreadReadSnapshotByThreadId.set(threadId, snapshot)
  }

  getLastThreadReadSnapshot(threadId: string): unknown | null {
    return this.lastThreadReadSnapshotByThreadId.get(threadId) ?? null
  }

  cacheLiveState(threadId: string, data: unknown, turnCount: number, sessionSize: number): void {
    this.liveStateCache.set(threadId, { data, turnCount, sessionSize })
  }

  getCachedLiveState(threadId: string, turnCount: number, sessionSize: number): unknown | null {
    const cached = this.liveStateCache.get(threadId)
    if (!cached) return null
    if (cached.turnCount !== turnCount || cached.sessionSize !== sessionSize) return null
    return cached.data
  }

  invalidateLiveStateCache(threadId: string): void {
    this.liveStateCache.delete(threadId)
  }

  private captureItemFromNotification(notification: { method: string; params: unknown }): void {
    if (notification.method !== 'item/started' && notification.method !== 'item/completed') return

    const params = asRecord(notification.params)
    if (!params) return
    const item = asRecord(params.item)
    if (!item) return
    const itemType = typeof item.type === 'string' ? item.type : ''
    if (!MERGEABLE_ITEM_TYPES.has(itemType)) return

    const itemId = typeof item.id === 'string' ? item.id : ''
    if (!itemId) return

    const threadId = this.extractThreadIdFromParams(params)
    if (!threadId) return

    const turnId =
      (typeof params.turnId === 'string' ? params.turnId : '') ||
      (typeof params.turn_id === 'string' ? params.turn_id : '')
    if (!turnId) return

    let threadItems = this.capturedItemsByThreadId.get(threadId)
    if (!threadItems) {
      threadItems = new Map()
      this.capturedItemsByThreadId.set(threadId, threadItems)
    }

    const isCompleted = notification.method === 'item/completed'
    const existing = threadItems.get(itemId)

    if (existing && existing.completed && !isCompleted) return

    threadItems.set(itemId, {
      id: itemId,
      type: itemType,
      turnId,
      data: item as Record<string, unknown>,
      completed: isCompleted,
    })
  }

  mergeItemsIntoTurns(threadId: string, turns: unknown[]): unknown[] {
    const capturedMap = this.capturedItemsByThreadId.get(threadId)
    if (!capturedMap || capturedMap.size === 0) return turns

    const itemsByTurnId = new Map<string, CapturedItem[]>()
    for (const captured of capturedMap.values()) {
      let group = itemsByTurnId.get(captured.turnId)
      if (!group) {
        group = []
        itemsByTurnId.set(captured.turnId, group)
      }
      group.push(captured)
    }

    return turns.map((turn) => {
      const turnRecord = asRecord(turn)
      if (!turnRecord) return turn
      const turnId = typeof turnRecord.id === 'string' ? turnRecord.id : ''
      if (!turnId) return turn

      const captured = itemsByTurnId.get(turnId)
      if (!captured || captured.length === 0) return turn

      const existingItems = Array.isArray(turnRecord.items) ? (turnRecord.items as Record<string, unknown>[]) : []
      const existingIds = new Set(existingItems.map((it) => (typeof it.id === 'string' ? it.id : '')).filter(Boolean))

      const newItems = captured
        .filter((c) => !existingIds.has(c.id))
        .map((c) => c.data)

      if (newItems.length === 0) return turn

      return {
        ...turnRecord,
        items: [...existingItems, ...newItems],
      }
    })
  }

  private sendServerRequestReply(requestId: number, reply: ServerRequestReply): void {
    if (reply.error) {
      this.sendLine({
        jsonrpc: '2.0',
        id: requestId,
        error: reply.error,
      })
      return
    }

    this.sendLine({
      jsonrpc: '2.0',
      id: requestId,
      result: reply.result ?? {},
    })
  }

  private resolvePendingServerRequest(requestId: number, reply: ServerRequestReply): void {
    const pendingRequest = this.pendingServerRequests.get(requestId)
    if (!pendingRequest) {
      throw new Error(`No pending server request found for id ${String(requestId)}`)
    }
    this.pendingServerRequests.delete(requestId)

    this.sendServerRequestReply(requestId, reply)
    const requestParams = asRecord(pendingRequest.params)
    const threadId =
      typeof requestParams?.threadId === 'string' && requestParams.threadId.length > 0
        ? requestParams.threadId
        : ''
    this.emitNotification({
      method: 'server/request/resolved',
      params: {
        id: requestId,
        method: pendingRequest.method,
        threadId,
        mode: 'manual',
        resolvedAtIso: new Date().toISOString(),
      },
    })
  }

  private async refreshChatgptAuthTokens(params: ChatgptAuthTokensRefreshParams): Promise<ChatgptAuthTokensRefreshResponse> {
    const storageId = await this.runtimeAccountId()
    if (storageId) {
      const credential = await getAccountAuthCoordinator().refreshTokensForStorage(storageId, params)
      return credential
    }
    if (!this.chatgptAuthRefreshPromise) {
      this.chatgptAuthRefreshPromise = refreshChatgptAuthTokensForExternalAuth(params).finally(() => {
        this.chatgptAuthRefreshPromise = null
      })
    }
    return await this.chatgptAuthRefreshPromise
  }

  private async handleChatgptAuthTokensRefreshRequest(requestId: number, params: unknown): Promise<void> {
    const requestParams = asRecord(params)
    const previousAccountId = readNonEmptyString(requestParams?.previousAccountId ?? requestParams?.previous_account_id)
    const process = this.process
    const storageId = await this.runtimeAccountId()
    try {
      const result = await this.refreshChatgptAuthTokens({
        reason: readNonEmptyString(requestParams?.reason) || undefined,
        previousAccountId: previousAccountId || undefined,
      })
      if (this.process !== process || await this.runtimeAccountId() !== storageId) throw new Error('账号连接已变更，请重新核对认证')
      this.sendServerRequestReply(requestId, { result })
      this.emitNotification({
        method: 'server/request/resolved',
        params: {
          id: requestId,
          method: 'account/chatgptAuthTokens/refresh',
          mode: 'automatic',
          resolvedAtIso: new Date().toISOString(),
        },
      })
    } catch (error) {
      this.sendServerRequestReply(requestId, {
        error: {
          code: -32001,
          message: getErrorMessage(error, 'Failed to refresh ChatGPT auth tokens'),
        },
      })
    }
  }

  private handleServerRequest(requestId: number, method: string, params: unknown): void {
    if (method === 'account/chatgptAuthTokens/refresh') {
      void this.handleChatgptAuthTokensRefreshRequest(requestId, params)
      return
    }

    const pendingRequest: PendingServerRequest = {
      id: requestId,
      method,
      params,
      receivedAtIso: new Date().toISOString(),
    }
    this.pendingServerRequests.set(requestId, pendingRequest)

    this.emitNotification({
      method: 'server/request',
      params: pendingRequest,
    })
  }

  private async call(method: string, params: unknown): Promise<unknown> {
    this.start()
    const id = this.nextId++

    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject })

      this.sendLine({
        jsonrpc: '2.0',
        id,
        method,
        params,
      } satisfies JsonRpcCall)
    })
  }

  private readonly preparationReads = new Map<string, Promise<unknown>>()
  private async readForPreparation(method: string, params: unknown, scope: AutomationPreparation): Promise<unknown> {
    scope.assertActive()
    const key = JSON.stringify([method, params])
    let read = this.preparationReads.get(key)
    if (!read) {
      if (this.preparationReads.size >= 4) throw new Error('准备状态读取超时，仍有读取等待上游返回')
      const flight = this.call(method, params).finally(() => {
        if (this.preparationReads.get(key) === flight) this.preparationReads.delete(key)
      })
      this.preparationReads.set(key, flight)
      void flight.catch(() => {})
      read = flight
    }
    // Cancellation ends this caller's wait, not the native RPC's lifetime.
    // Keep its actual pending slot and share retries until the response/exit.
    return scope.read(() => read!)
  }

  private async ensureInitialized(scope?: AutomationPreparation): Promise<void> {
    if (scope) await scope.read(() => getCustomConnectionStore().ready)
    else await getCustomConnectionStore().ready
    if (this.closingSession) await this.closingSession
    scope?.assertActive()
    if (this.initialized) return
    if (this.initializePromise) {
      await this.initializePromise
      return
    }

    // Only a newly started process belongs to this preparation. An existing
    // shared initialization completes under its original ownership.
    const initializationScope = !this.process ? scope : undefined

    const initialization = this.call('initialize', {
      clientInfo: {
        name: 'codex-web-local',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    }).then(async () => {
      initializationScope?.assertActive()
      this.sendLine({
        jsonrpc: '2.0',
        method: 'initialized',
      })
      if (this.runtimeOptions.isolatedTask && this.assignedStorageId && !getCustomConnectionStore().get(this.assignedStorageId)) {
        const credential = initializationScope
          ? await initializationScope.read(() => getAccountAuthCoordinator().getApiCredential(this.assignedStorageId!))
          : await getAccountAuthCoordinator().getApiCredential(this.assignedStorageId)
        initializationScope?.assertActive()
        await this.call('account/login/start', { type: 'chatgptAuthTokens', accessToken: credential.accessToken, chatgptAccountId: credential.accountId })
      }
      initializationScope?.assertActive()
      if (this.runtimeOptions.isolatedTask && this.assignedStorageId && !this.executionLease) {
        this.executionLease = getAccountAuthCoordinator().executions.register({ storageId: this.assignedStorageId, kind: this.currentTaskRun ? 'automation' : 'primary', ownerId: this.currentTaskRun || [...this.ownedThreadIds][0] || 'session', busy: !!this.currentTaskRun, disconnect: () => this.dispose() })
      }
      if (!this.runtimeOptions.isolatedTask) {
        const storageId = await this.runtimeAccountId()
        if (storageId && !getCustomConnectionStore().get(storageId)) {
          this.runtimeStorageId = storageId
          const credential = await getAccountAuthCoordinator().store.readCredential(storageId)
          // All ChatGPT runtimes delegate token rotation to the same coordinator.
          // Local token login does not wait for quota or a remote refresh.
          await this.call('account/login/start', { type: 'chatgptAuthTokens', accessToken: credential.auth.tokens!.access_token, chatgptAccountId: credential.identity.accountId })
          this.executionLease?.release()
          this.executionLease = getAccountAuthCoordinator().executions.register({ storageId, kind: 'primary', ownerId: 'primary', busy: false, disconnect: () => this.dispose() })
        }
      }
      this.initialized = true
      void Promise.resolve().then(async () => {
        getAccountAuthCoordinator()
        const storageId = await this.runtimeAccountId()
        if (storageId && !getCustomConnectionStore().get(storageId) && this.initialized && this.process) await this.readRuntimeQuota(storageId)
      }).catch(() => undefined)
    }).finally(() => {
      if (this.initializePromise === initialization) this.initializePromise = null
    })
    this.initializePromise = initialization
    const process = this.process
    initializationScope?.onCancel(async () => {
      if (this.process === process) await this.closeOwnedPreparationProcess(initializationScope)
    })
    await initialization
  }

  async rpc(method: string, params: unknown, taskId?: string, scope?: AutomationPreparation): Promise<unknown> {
    scope?.assertActive()
    const coordinator = getAccountAuthCoordinator()
    const threadId = readNonEmptyString(asRecord(params)?.threadId)
    const mutatingTurn = ['turn/start', 'turn/steer', 'thread/compact/start', 'thread/goal/set'].includes(method)
    if (mutatingTurn && this.taskAccountBusy() && taskId !== this.taskLease?.runId) {
      throw Object.assign(new Error('该会话正在执行自动化，请等待本次运行结束'), { rpcRejected: true, submissionNotSent: true })
    }
    if (!this.runtimeOptions.isolatedTask) {
      coordinator.runtimeQuotaReader = async storageId => {
        const candidates = [this, ...this.sessionWorkers.availableValues()]
        for (const candidate of candidates) {
          if (candidate.initialized && await candidate.runtimeAccountId() === storageId) return (await candidate.readRuntimeQuota(storageId)).account
        }
        return null
      }
      coordinator.activeUsageAccounts = async () => {
        const ids = await Promise.all([this, ...this.sessionWorkers.availableValues()].filter(candidate => candidate.activeTurnThreadIds.size).map(candidate => candidate.runtimeAccountId()))
        return [...new Set(ids.filter((id): id is string => !!id))]
      }
      coordinator.setProtectionInterrupt(async storageId => {
        for (const candidate of [this, ...this.sessionWorkers.availableValues()]) {
          if (await candidate.runtimeAccountId() !== storageId || candidate.taskLease?.protected || !candidate.activeTurnThreadIds.size) continue
          const config = asRecord(asRecord(await candidate.call('config/read', {}))?.config)
          if (config?.model_provider && config.model_provider !== 'openai') continue
          for (const [id, turnId] of candidate.activeTurnIds) {
            if (candidate === this) void this.quotaBlocked(id, turnId).catch(() => undefined)
            await candidate.call('turn/interrupt', { threadId: id, turnId }).catch(() => undefined)
          }
        }
      })
    }
    if (!this.runtimeOptions.isolatedTask) {
      if (method === 'thread/loaded/list') {
        const ids = new Set<string>()
        for (const worker of this.sessionWorkers.availableValues()) {
          if (!worker.process) continue
          const loaded = asRecord(await worker.rpc(method, params))
          for (const id of Array.isArray(loaded?.data) ? loaded.data : []) if (typeof id === 'string') ids.add(id)
        }
        return { data: [...ids], nextCursor: null }
      }
      const owner = this.threadWorker(threadId)
      if (owner || (mutatingTurn && threadId) || ['thread/start', 'thread/resume', 'thread/fork'].includes(method)) {
        const worker = await this.sessionWorker(method === 'thread/start' || method === 'thread/fork' ? `chat:${randomUUID()}` : threadId, scope)
        scope?.assertActive()
        if (!worker) throw Object.assign(new Error('会话运行资源已满，空闲会话正在回收，请稍后重试。'), { rpcRejected: true, submissionNotSent: true })
        const selectsAccount = mutatingTurn || ['thread/start', 'thread/resume', 'thread/fork'].includes(method)
        if (selectsAccount) worker.sessionOperations++
        try {
          if (!worker.currentTaskRun && selectsAccount) {
            const state = await coordinator.store.readState()
            const config = asRecord(asRecord(await this.rpc('config/read', {}))?.config)
            const storageId = getCustomConnectionStore().active()?.storageId || (config?.model_provider && config.model_provider !== 'openai' ? null : state.activeStorageId)
            await worker.configureSession(storageId, 'primary', threadId || 'new-thread')
          }
          const input = worker.currentTaskRun && method === 'thread/resume'
            ? { threadId, excludeTurns: asRecord(params)?.excludeTurns === true }
            : params
          return await worker.rpc(method, input, taskId, scope)
        } finally {
          if (selectsAccount) worker.sessionOperations--
        }
      }
    }
    this.disposeIfConfigChanged()
    if (scope && !taskId) await scope.read(() => this.ensureInitialized())
    else await this.ensureInitialized(scope)
    scope?.assertActive()
    const customConnection = this.runtimeOptions.isolatedTask ? getCustomConnectionStore().get(this.assignedStorageId) : undefined
    const selectedCustom = getCustomConnectionStore().active()
    if (!this.runtimeOptions.isolatedTask && selectedCustom && method === 'model/list') return { data: customConnectionModels({ ...selectedCustom, hasApiKey: true }), nextCursor: null }
    if (customConnection && method === 'model/list') return { data: customConnectionModels({ ...customConnection, hasApiKey: true }), nextCursor: null }
    if (customConnection && method === 'account/rateLimits/read') return null
    if (method === 'account/rateLimits/read') {
      const storageId = await this.runtimeAccountId()
      return (await this.readRuntimeQuota(storageId)).payload
    }
    if (mutatingTurn && !customConnection) {
      await getAccountAuthCoordinator().assertSubmissionAllowed(async () => {
        const result = asRecord(await this.call('config/read', {}))
        const config = asRecord(result?.config)
        return !config?.model_provider || config.model_provider === 'openai'
      }, this.runtimeOptions.isolatedTask ? { storageId: this.assignedStorageId || undefined, protected: !!taskId && this.taskLease?.protected === true } : undefined).catch(error => {
        throw Object.assign(error instanceof Error ? error : new Error('额度校验失败'), { rpcRejected: true, submissionNotSent: true })
      })
    }
    if (this.runtimeOptions.isolatedTask && mutatingTurn && threadId && !this.ownedThreadIds.has(threadId)) {
      const resumeParams = await this.withRuntimeThreadProvider({
        threadId,
        excludeTurns: true,
        ...(customConnection ? { model: customConnection.model } : {}),
      })
      await this.call('thread/resume', resumeParams)
      this.ownedThreadIds.add(threadId)
    }
    if (method === 'thread/resume' || method === 'thread/fork') {
      params = await this.withRuntimeThreadProvider(params)
    } else if (customConnection && method === 'thread/start') {
      params = { ...asRecord(params), modelProvider: `custom_${customConnection.storageId}` }
    }
    if (customConnection && mutatingTurn) {
      const input = { ...asRecord(params) }
      const capability = customConnection.models.find(model => model.id === input.model) || customConnection.models.find(model => model.id === customConnection.model)
      if (!capability?.efforts?.length) {
        delete input.effort
        if (input.collaborationMode) {
          const mode = asRecord(input.collaborationMode)
          input.collaborationMode = { ...mode, settings: { ...asRecord(mode?.settings), reasoning_effort: null } }
        }
      }
      if (!capability?.serviceTiers?.length) delete input.serviceTier
      params = input
    }
    scope?.assertActive()
    const result = scope && ['config/read', 'thread/read', 'thread/backgroundTerminals/list'].includes(method)
      ? await this.readForPreparation(method, params, scope)
      : await this.call(method, params)
    scope?.assertActive()
    if (!this.runtimeOptions.isolatedTask && selectedCustom && method === 'config/read') {
      const response = asRecord(result)
      const config = asRecord(response?.config)
      const provider = `custom_${selectedCustom.storageId}`
      return { ...response, config: { ...config, model: selectedCustom.model, model_provider: provider,
        model_reasoning_effort: selectedCustom.models.find(model => model.id === selectedCustom.model)?.defaultEffort || null,
        model_providers: { ...asRecord(config?.model_providers), [provider]: { base_url: selectedCustom.baseUrl, wire_api: selectedCustom.wireApi } },
      } }
    }
    if (method === 'turn/start' && threadId) {
      const turn = asRecord(asRecord(result)?.turn)
      const turnId = readNonEmptyString(turn?.id)
      if (turnId && !this.terminalTurnIds.has(turnId) && !['completed', 'failed', 'interrupted'].includes(String(turn?.status))) {
        this.activeTurnThreadIds.add(threadId)
        this.activeTurnIds.set(threadId, turnId)
        this.executionLease?.setBusy(true)
      }
    }
    if (!this.runtimeOptions.isolatedTask && method === 'thread/list') {
      const response = asRecord(result)
      if (Array.isArray(response?.data)) {
        return { ...response, data: response.data.map(value => {
          const thread = asRecord(value)
          const id = readNonEmptyString(thread?.id)
          const owner = this.threadWorker(id)
          if (!owner?.process || !owner.ownedThreadIds.has(id)) return value
          // The catalog process sees other processes' threads as notLoaded.
          // Surface the actual owner so UI and deployment checks see live work.
          return { ...thread, status: owner.activeTurnThreadIds.has(id) ? { type: 'active', activeFlags: [] } : { type: 'idle' } }
        }) }
      }
    }
    if (['thread/start', 'thread/resume', 'thread/fork'].includes(method)) {
      const id = readNonEmptyString(asRecord(asRecord(result)?.thread)?.id) || threadId
      if (id) this.ownedThreadIds.add(id)
    }
    if (method === 'thread/archive' || (method === 'thread/unsubscribe' && asRecord(result)?.status === 'notLoaded')) this.ownedThreadIds.delete(threadId)
    return result
  }

  onNotification(listener: (value: { method: string; params: unknown }) => void): () => void {
    this.notificationListeners.add(listener)
    return () => {
      this.notificationListeners.delete(listener)
    }
  }

  async respondToServerRequest(payload: unknown): Promise<void> {
    const body = asRecord(payload)
    if (!body) {
      throw new Error('Invalid response payload: expected object')
    }

    const id = body.id
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      throw new Error('Invalid response payload: "id" must be an integer')
    }

    const forwarded = this.forwardedRequests.get(id)
    if (forwarded) return forwarded.worker.respondToServerRequest({ ...body, id: forwarded.nativeId })
    await this.ensureInitialized()

    const rawError = asRecord(body.error)
    if (rawError) {
      const message = typeof rawError.message === 'string' && rawError.message.trim().length > 0
        ? rawError.message.trim()
        : 'Server request rejected by client'
      const code = typeof rawError.code === 'number' && Number.isFinite(rawError.code)
        ? Math.trunc(rawError.code)
        : -32000
      this.resolvePendingServerRequest(id, { error: { code, message } })
      return
    }

    if (!('result' in body)) {
      throw new Error('Invalid response payload: expected "result" or "error"')
    }

    this.resolvePendingServerRequest(id, { result: body.result })
  }

  listPendingServerRequests(): PendingServerRequest[] {
    const taskRequests = [...this.forwardedRequests].flatMap(([id, request]) => {
      const native = request.worker.pendingServerRequests.get(request.nativeId)
      return native ? [{ ...native, id }] : []
    })
    return [...this.pendingServerRequests.values(), ...taskRequests]
  }

  liveActivity(): { activeTurnThreadIds: string[]; pendingOperationCount: number } {
    const runtimes = [this, ...this.sessionWorkers.values()]
    return {
      activeTurnThreadIds: [...new Set(runtimes.flatMap(runtime => [...runtime.activeTurnThreadIds]))],
      pendingOperationCount: runtimes.reduce((count, runtime) => count + runtime.sessionOperations + [...runtime.pending.values()].filter(request => /^(?:turn\/(?:start|steer|interrupt)|thread\/(?:start|resume|fork|compact\/start|goal\/set|settings\/update))$/.test(request.method)).length, 0),
    }
  }

  async getAccountSwitchSnapshot(): Promise<RuntimeQuiescenceSnapshot> {
    return this.getRuntimeQuiescenceSnapshot(false, true)
  }

  async getRuntimeQuiescenceSnapshot(ignoreTaskAcquisition = false, accountSwitch = false): Promise<RuntimeQuiescenceSnapshot> {
    const activityRevision = this.activityRevision
    const runtimes = [this, ...this.sessionWorkers.values()].filter(worker => !accountSwitch || !worker.currentTaskRun)
    const activeTurnThreadIds = new Set(runtimes.flatMap(worker => [...worker.activeTurnThreadIds]))
    if (accountSwitch) {
      // Account switching depends on live session owners, not the number of
      // historical threads or archived/incomplete records in the catalog.
      for (const runtime of runtimes) {
        for (const threadId of [...runtime.activeTurnThreadIds]) {
          const response = asRecord(await runtime.rpc('thread/read', { threadId, includeTurns: false }))
          const thread = asRecord(response?.thread)
          const status = readNonEmptyString(asRecord(thread?.status)?.type) || readNonEmptyString(thread?.status)
          if (['idle', 'notLoaded', 'systemError', 'completed', 'interrupted', 'failed'].includes(status)) {
            runtime.activeTurnThreadIds.delete(threadId)
            runtime.activeTurnIds.delete(threadId)
            activeTurnThreadIds.delete(threadId)
          }
        }
      }
    } else {
      let cursor: string | null = null
      let pageCount = 0
      const cursors = new Set<string>()
      do {
        const response = asRecord(await this.rpc('thread/list', {
          archived: false,
          limit: 100,
          sortKey: 'updated_at',
          modelProviders: [],
          cursor,
        }))
        if (!Array.isArray(response?.data)) throw new Error('无法核对当前会话状态，请稍后重试')
        const threads = response.data
        for (const value of threads) {
          const thread = asRecord(value)
          const threadId = readNonEmptyString(thread?.id)
          const status = asRecord(thread?.status)
          const owner = this.threadWorker(threadId)
          const statusType = owner?.activeTurnThreadIds.has(threadId) ? 'active' : readNonEmptyString(status?.type) || readNonEmptyString(thread?.status)
          if (!threadId || !['idle', 'notLoaded', 'systemError', 'completed', 'interrupted', 'failed', 'inProgress', 'running', 'active'].includes(statusType)) {
            throw new Error('会话运行状态未知，暂不能切换账号')
          }
          if (accountSwitch && owner?.currentTaskRun) continue
          if (threadId && !['active', 'running', 'inProgress'].includes(statusType)) {
            activeTurnThreadIds.delete(threadId)
          }
          if (threadId && (statusType === 'inProgress' || statusType === 'running' || statusType === 'active')) {
            activeTurnThreadIds.add(threadId)
          }
        }
        cursor = readNonEmptyString(response?.nextCursor) || null
        if (cursor && cursors.has(cursor)) throw new Error('会话分页未前进，暂不能切换账号')
        if (cursor) cursors.add(cursor)
        pageCount += 1
      } while (cursor && pageCount < 10)
      if (cursor) activeTurnThreadIds.add('__thread_inventory_truncated__')
    }

    const queuedState = await this.readQueueState()
    const queuedThreadIds = Object.entries(queuedState)
      .filter(([, messages]) => messages.some(message => !accountSwitch || ['sending', 'unknown'].includes(message.delivery?.status || 'queued')))
      .map(([threadId]) => threadId)
    const pendingTurnMutationCount = runtimes.flatMap(worker => [...worker.pending.values()]).filter((request) => (
      request.method === 'turn/start'
      || request.method === 'turn/interrupt'
      || request.method === 'turn/steer'
      || request.method === 'thread/resume'
      || request.method === 'thread/compact/start'
      || request.method === 'thread/goal/set'
      || request.method === 'thread/settings/update'
      || request.method === 'thread/backgroundTerminals/terminate'
    )).length + runtimes.reduce((count, worker) => count + worker.sessionOperations, 0)
    const pendingServerRequestCount = runtimes.reduce((count, worker) => count + worker.pendingServerRequests.size, 0)
    const automationRunIds = accountSwitch ? [] : this.automationActivity()
    if (!ignoreTaskAcquisition && this.taskAccountBusy()) automationRunIds.push('__account_task_lease__')
    const backgroundThreadIds = accountSwitch || activeTurnThreadIds.size || queuedThreadIds.length || automationRunIds.length
      || pendingServerRequestCount || pendingTurnMutationCount ? [] : await this.backgroundActivity()
    if (activityRevision !== this.activityRevision) throw new Error('核对期间运行状态已变化，请稍后重试')
    for (const id of this.activeTurnThreadIds) if (!activeTurnThreadIds.has(id)) { this.activeTurnThreadIds.delete(id); this.activeTurnIds.delete(id) }
    return {
      idle: automationRunIds.length === 0 && activeTurnThreadIds.size === 0
        && backgroundThreadIds.length === 0
        && queuedThreadIds.length === 0
        && pendingServerRequestCount === 0
        && pendingTurnMutationCount === 0,
      activeTurnThreadIds: Array.from(activeTurnThreadIds),
      queuedThreadIds,
      automationRunIds,
      backgroundThreadIds,
      pendingServerRequestCount,
      pendingTurnMutationCount,
    }
  }

  dispose(): void {
    this.ownedThreadIds.clear()
    this.executionLease?.release()
    this.executionLease = null
    this.quotaReadCache = null
    if (!this.process) return

    const proc = this.process
    const closing = proc.exitCode === null && proc.signalCode === null ? once(proc, 'exit').then(() => undefined).catch(() => undefined) : Promise.resolve()
    this.closingSession = closing
    void closing.then(() => { if (this.closingSession === closing) this.closingSession = null })
    this.stopping = true
    this.process = null
    this.initialized = false
    this.initializePromise = null
    this.activeConfigSignature = ''
    this.readBuffer = ''

    this.runtimeStorageId = null
    const failure = new Error('codex app-server stopped')
    for (const request of this.pending.values()) {
      request.reject(failure)
    }
    this.pending.clear()
    this.pendingServerRequests.clear()
    this.activeTurnThreadIds.clear()
    this.activeTurnIds.clear()
    this.terminalTurnIds.clear()
    this.accountFailureInterrupts.clear()
    this.authRecovery.clear()
    this.emitNotification({ method: 'codexapp/runtime/stopped', params: {} })

    try {
      proc.stdin.end()
    } catch {
      // ignore close errors on shutdown
    }

    try {
      proc.kill('SIGTERM')
    } catch {
      // ignore kill errors on shutdown
    }

    const forceKillTimer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        try {
          proc.kill('SIGKILL')
        } catch {
          // ignore kill errors on shutdown
        }
      }
    }, 1500)
    forceKillTimer.unref()
  }
}
