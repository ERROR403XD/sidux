import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { capabilityValue } from '../modelCapabilities.js'
import { deliveryView } from '../delivery.js'
import { normalizeStoredQueuedMessage, type StoredQueuedMessage, type ThreadQueueState } from '../threadQueue.js'
import { getAccountAuthCoordinator } from './accountAuthCoordinator.js'
import { getCustomConnectionStore } from './customConnectionStore.js'
import { DeliveryService } from './deliveryService.js'
import { DeliveryStore } from './deliveryStore.js'
import { inspectDelivery } from './deliveryHistory.js'
import { clearLegacyThreadQueueState, readLegacyThreadQueueState } from './legacyThreadQueueStore.js'
import { asRecord, getErrorMessage } from './httpUtils.js'
import { MethodCatalog } from './runtimeCapabilities.js'
import { ThreadHistory } from './threadHistory.js'
import { isEmptyThreadReadError } from './threadReadErrors.js'
import { inspectGoalContinuation, prepareGoalContinuation, readContinuationGoal, resumeGoalContinuation } from './threadContinuation.js'
import type { GoalResumeIdentity } from '../delivery.js'
import { automaticResumeStartedMethod, type AutomaticResumeStarted } from '../threadAutomaticResume.js'
import type { CollaborationModeKind, ReasoningEffort } from '../types/codex.js'

type BackendQueuedTurn = {
  threadId: string
  message: StoredQueuedMessage
}

type ResolvedCollaborationModeSettings = {
  model: string
  reasoningEffort: ReasoningEffort | null
}

export type BackendQueueRuntime = {
  rpc: (method: string, params: unknown) => Promise<unknown>
  taskAccountBusy: () => boolean
  listPendingServerRequests: () => Array<{ method: string; params: unknown }>
  onNotification: (listener: (notification: { method: string; params: unknown }) => void) => () => void
  notifyQueueChanged: (threadId: string) => void
  notifyAutomaticResumeStarted?: (params: AutomaticResumeStarted) => void
  getLastThreadReadSnapshot: (threadId: string) => unknown | null
  bindQueueStateReader: (read: () => Promise<ThreadQueueState>) => () => void
}

export type QueueRuntimeProbe = {
  rpcCalls: Array<{ method: string; params: unknown }>
  notifications: Array<{ method: string; params: unknown }>
  queueChanges: string[]
}

export function createBackendQueueRuntimeFixture(overrides: Partial<BackendQueueRuntime> = {}): {
  runtime: BackendQueueRuntime
  probe: QueueRuntimeProbe & {
    emitNotification: (notification: { method: string; params: unknown }) => void
    setPendingRequests: (requests: Array<{ method: string; params: unknown }>) => void
    readQueueState: () => Promise<ThreadQueueState>
  }
} {
  const probe = {
    rpcCalls: [] as QueueRuntimeProbe['rpcCalls'],
    notifications: [] as QueueRuntimeProbe['notifications'],
    queueChanges: [] as QueueRuntimeProbe['queueChanges'],
    emitNotification: (_notification: { method: string; params: unknown }) => {},
    setPendingRequests: (_requests: Array<{ method: string; params: unknown }>) => {},
    readQueueState: async (): Promise<ThreadQueueState> => queueStateBinding?.read() ?? {},
  }
  const listeners = new Set<(notification: { method: string; params: unknown }) => void>()
  let pendingRequests: Array<{ method: string; params: unknown }> = []
  let queueStateBinding: { read: () => Promise<ThreadQueueState> } | null = null
  const runtime: BackendQueueRuntime = {
    rpc: async (method, params) => {
      probe.rpcCalls.push({ method, params })
      if (method === 'thread/read') return { thread: { id: (params as { threadId?: string })?.threadId, status: { type: 'idle' } } }
      if (method === 'turn/start') return { turn: { id: 'native-turn' } }
      return {}
    },
    taskAccountBusy: () => false,
    listPendingServerRequests: () => pendingRequests,
    onNotification: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    notifyQueueChanged: threadId => { probe.queueChanges.push(threadId) },
    notifyAutomaticResumeStarted: params => { probe.emitNotification({ method: automaticResumeStartedMethod, params }) },
    getLastThreadReadSnapshot: () => null,
    bindQueueStateReader: read => {
      if (queueStateBinding) throw new Error('队列状态读取已绑定')
      const binding = { read }
      queueStateBinding = binding
      return () => {
        if (queueStateBinding === binding) queueStateBinding = null
      }
    },
    ...overrides,
  }
  probe.emitNotification = notification => {
    probe.notifications.push(notification)
    for (const listener of listeners) listener(notification)
  }
  probe.setPendingRequests = requests => { pendingRequests = requests }
  return { runtime, probe }
}

function readNonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : ''
}

function getCodexHomeDir(): string {
  const codexHome = process.env.CODEX_HOME?.trim()
  return codexHome && codexHome.length > 0 ? codexHome : join(homedir(), '.codex')
}

async function readCodexAuth(): Promise<{ accessToken: string; accountId?: string } | null> {
  try {
    const auth = JSON.parse(await readFile(join(getCodexHomeDir(), 'auth.json'), 'utf8')) as {
      tokens?: { access_token?: string; account_id?: string }
    }
    const token = auth.tokens?.access_token
    if (!token) return null
    return { accessToken: token, accountId: auth.tokens?.account_id ?? undefined }
  } catch {
    return null
  }
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | '' {
  return capabilityValue(value)
}

function normalizeCollaborationModeReasoningEffort(value: ReasoningEffort | '' | null | undefined): ReasoningEffort | null {
  return value && value.length > 0 ? value : null
}

function extractLocalImagePathFromUrl(value: string): string | null {
  if (!value) return null
  try {
    const parsed = new URL(value, 'http://localhost')
    if (parsed.pathname !== '/codex-local-image') return null
    const path = parsed.searchParams.get('path')?.trim() ?? ''
    return path.length > 0 ? path : null
  } catch {
    return null
  }
}

function buildTextWithAttachments(prompt: string, files: StoredQueuedMessage['fileAttachments']): string {
  if (files.length === 0) return prompt
  let prefix = '# Files mentioned by the user:\n'
  for (const file of files) {
    prefix += `\n## ${file.label}: ${file.path}\n`
  }
  return `${prefix}\n## My request to Codex:\n\n${prompt}\n`
}

function fileNameFromPath(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, '/')
  const segments = normalized.split('/').filter(Boolean)
  return segments.at(-1) ?? normalized
}

function extractThreadIdFromNotificationParams(params: unknown): string {
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

export class BackendQueueProcessor {
  readonly store: DeliveryStore
  readonly deliveries: DeliveryService
  readonly history: ThreadHistory
  private readonly processingThreadIds = new Set<string>()
  private readonly queueDrainTimersByThreadId = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly queueDrainDueAtByThreadId = new Map<string, number>()
  private readonly recoveryChecks = new Map<string, number>()
  private readonly threadsNeedingResume = new Set<string>()
  private readonly unsubscribe: () => void
  private readonly unbindQueueStateReader: () => void
  private pruneTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  private disposal: Promise<void> | null = null
  private providerChanging = false

  constructor(private readonly appServer: BackendQueueRuntime, options: {
    startRecovery?: boolean
    directory?: string
    features?: ConstructorParameters<typeof ThreadHistory>[1]
    context?: () => Promise<string>
    previousRuntimeStopped?: Promise<void>
  } = {}) {
    this.store = new DeliveryStore(options.directory ?? join(getCodexHomeDir(), 'codexapp-delivery'), {
      ...(options.directory ? {} : { readLegacy: readLegacyThreadQueueState, clearLegacy: clearLegacyThreadQueueState }),
      previousRuntimeStopped: options.previousRuntimeStopped,
    })
    const catalog = new MethodCatalog()
    this.history = new ThreadHistory(
      (method, params) => this.appServer.rpc(method, params),
      options.features ?? (async () => (await catalog.snapshot()).features),
    )
    this.deliveries = new DeliveryService(this.store, {
      accountBusy: () => this.providerChanging || this.appServer.taskAccountBusy() || getAccountAuthCoordinator().blocksNewSubmissions(),
      submissionBlocked: () => this.providerChanging || getAccountAuthCoordinator().blocksNewSubmissions(),
      context: options.context ?? (() => this.deliveryContext()),
      canStart: threadId => this.canStartQueuedTurn(threadId),
      prepare: async row => {
        if (row.mode === 'steer') await this.readThreadStatus(row.threadId)
        const needsResume = this.threadsNeedingResume.delete(row.threadId)
        if (needsResume) await this.appServer.rpc('thread/resume', { threadId: row.threadId, excludeTurns: true })
        if (row.message.continuation) {
          const goalParams = await prepareGoalContinuation((method, params) => this.appServer.rpc(method, params), row)
          if (goalParams) return goalParams
        }
        return row.params ?? this.buildQueuedTurnParams(row)
      },
      start: async params => {
        if (params.goalResume) return resumeGoalContinuation((method, input) => this.appServer.rpc(method, input), params)
        const response = asRecord(await this.appServer.rpc('turn/start', params))
        const turnId = readNonEmptyString(asRecord(response?.turn)?.id)
        if (!turnId) throw new Error('未收到回合 ID，请核对发送状态')
        return { turnId }
      },
      // GOAL mutations have no user-message client ID to reconcile from history.
      inspect: row => row.params?.goalResume ? Promise.resolve({}) : inspectDelivery(this.history, row),
      changed: threadId => this.appServer.notifyQueueChanged(threadId),
      accepted: (delivery, receipt) => {
        if (!delivery.message.resumeSource) return
        this.appServer.notifyAutomaticResumeStarted?.({
          threadId: delivery.threadId, deliveryId: receipt.id, source: delivery.message.resumeSource,
          ...(receipt.turnId ? { turnId: receipt.turnId } : {}),
        })
      },
    })
    this.unbindQueueStateReader = this.appServer.bindQueueStateReader(() => this.readState())
    this.unsubscribe = this.appServer.onNotification(notification => {
      if (notification.method === 'codexapp/runtime/stopped') this.history.clear()
      const threadId = extractThreadIdFromNotificationParams(notification.params)
      if (threadId && notification.method !== automaticResumeStartedMethod) this.history.invalidate(threadId)
      void this.deliveries.observe(notification).catch(() => {})
      if (threadId && notification.method === 'turn/completed') this.scheduleThreadQueueDrain(threadId, 0)
    })
    if (options.startRecovery !== false) {
      void this.scheduleAllQueuedThreads(1000)
      this.pruneTimer = setInterval(() => { void this.store.pruneReceipts().catch(() => {}) }, 3600000)
      this.pruneTimer.unref?.()
    }
  }

  async cancelAccountDeliveries(): Promise<void> {
    for (const row of await this.store.records()) {
      if (row.status === 'sending') await this.store.unknown(row.message.id, '账号已移除，请核对会话历史')
      else if (row.status === 'queued') await this.store.failed(row.message.id, row.revision, '账号已移除，请登录后重新发送')
      this.appServer.notifyQueueChanged(row.threadId)
    }
  }

  async deliveryContext(): Promise<string> {
    const [account, auth, response] = await Promise.all([
      getAccountAuthCoordinator().store.readState(),
      readCodexAuth(),
      this.appServer.rpc('config/read', {}),
    ])
    const config = asRecord(asRecord(response)?.config)
    const provider = readNonEmptyString(config?.model_provider) || 'openai'
    const settings = asRecord(asRecord(config?.model_providers)?.[provider])
    return createHash('sha256').update(JSON.stringify({
      account: getCustomConnectionStore().active()?.storageId || account.activeStorageId || auth?.accountId || null,
      connectionRevision: getCustomConnectionStore().active()?.revision || null,
      provider, baseUrl: settings?.base_url ?? null, wireApi: settings?.wire_api ?? null,
    })).digest('hex')
  }

  async runProviderChange<T>(change: () => Promise<T>): Promise<T> {
    if (this.providerChanging || getAccountAuthCoordinator().isAccountOperationInProgress()) throw new Error('账号或供应方正在切换，请稍后重试')
    this.providerChanging = true
    try {
      return await change()
    } finally {
      this.providerChanging = false
    }
  }

  isIdentityChanging(): boolean {
    return this.providerChanging || getAccountAuthCoordinator().blocksNewSubmissions()
  }

  async readState(): Promise<ThreadQueueState> {
    const state: ThreadQueueState = {}
    const records = await this.store.records()
    const pendingIds = new Set(records.map(row => row.message.id))
    for (const id of this.recoveryChecks.keys()) {
      if (!pendingIds.has(id)) this.recoveryChecks.delete(id)
    }
    for (const row of records) {
      (state[row.threadId] ??= []).push({ ...row.message, delivery: deliveryView(row) })
    }
    return state
  }

  inspectGoalContinuation(threadId: string, identity: GoalResumeIdentity) {
    return inspectGoalContinuation((method, params) => this.appServer.rpc(method, params), threadId, identity)
  }

  readContinuationGoal(threadId: string) {
    return readContinuationGoal((method, params) => this.appServer.rpc(method, params), threadId)
  }

  async readDeliveryStatuses(threadId: string, ids: string[]): Promise<Array<{ id: string; status: string; turnId?: string }>> {
    if (!threadId || ids.length > 100 || ids.some(id => !/^[a-zA-Z0-9_-]{1,160}$/.test(id))) throw new Error('无效的发送记录查询')
    const result: Array<{ id: string; status: string; turnId?: string }> = []
    for (const id of new Set(ids)) {
      const receipt = await this.store.readReceipt(id)
      if (receipt?.threadId === threadId) result.push({ id, status: receipt.status, turnId: receipt.turnId })
    }
    return result
  }

  async submit(input: unknown): Promise<Record<string, unknown>> {
    const body = asRecord(input)
    if (body?.protocol !== 2) throw new Error('发送接口已更新，请刷新页面后重试')
    const threadId = readNonEmptyString(body.threadId)
    const message = normalizeStoredQueuedMessage(body.message)
    const params = asRecord(body.params)
    const expectedContextId = readNonEmptyString(body.expectedContextId)
    if (!threadId || !message || !params || !expectedContextId || params.threadId !== threadId || !Array.isArray(params.input)) throw new Error('无效的发送内容或缺少账号快照，请刷新页面')
    const browserMessageId = message.id
    if (browserMessageId.startsWith('question:')) {
      const createdAt = body.legacyQuestionCreatedAt
      if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt)) throw new Error('发送接口已更新，请刷新页面后重试')
      message.id = `q-${createdAt}-${createHash('sha256').update(browserMessageId).digest('hex')}`
    }
    const result = await this.deliveries.submit({
      threadId, message, params, expectedContextId,
      mode: body.mode === 'steer' ? 'steer' : 'immediate',
    })
    this.scheduleThreadQueueDrain(threadId, 1000)
    if (!result) throw new Error('找不到发送记录，请核对状态')
    return 'message' in result
      ? { id: browserMessageId, ...deliveryView(result) }
      : { id: browserMessageId, status: result.status, turnId: result.turnId }
  }

  async mutate(input: unknown): Promise<{ state: ThreadQueueState; removed?: StoredQueuedMessage; delivered?: { id: string; turnId: string } }> {
    const body = asRecord(input)
    if (body?.protocol !== 2) throw new Error('队列接口已更新，请刷新页面后重试')
    const threadId = readNonEmptyString(body.threadId)
    if (!threadId) throw new Error('缺少会话 ID')
    let removed: StoredQueuedMessage | undefined
    if (body.type === 'add') {
      const message = normalizeStoredQueuedMessage(body.message)
      const expectedContextId = readNonEmptyString(body.expectedContextId)
      if (!message || !expectedContextId) throw new Error('无效的排队消息或缺少账号快照，请刷新页面')
      await this.deliveries.submit({ threadId, message, mode: 'queue', expectedContextId }, readNonEmptyString(body.beforeId) || undefined)
    } else {
      const id = readNonEmptyString(body.messageId)
      const row = await this.deliveries.result(id)
      if (!row || row.threadId !== threadId) throw new Error('该消息状态已变化，请刷新队列')
      if (!('message' in row)) {
        if (!['remove', 'abandon', 'reconcile', 'steer'].includes(String(body.type))) throw new Error('该消息已发送或已移除，请刷新队列')
      } else if (body.type === 'reconcile') {
        await this.deliveries.reconcile(id)
      } else {
        const revision = Number(body.revision)
        if (!Number.isInteger(revision) || revision < 1) throw new Error('缺少消息版本，请刷新队列')
        if (body.type === 'remove' || body.type === 'abandon') {
          removed = await this.store.remove(id, revision, body.type === 'abandon')
        } else if (body.type === 'move') {
          await this.store.move(id, revision, readNonEmptyString(body.targetId))
        } else if (body.type === 'edit' || body.type === 'update') {
          const contents = body.type === 'update' ? normalizeStoredQueuedMessage({ ...asRecord(body.message), id }) : undefined
          if (body.type === 'update' && !contents) throw new Error('无效的编辑内容')
          await this.store.edit(id, revision, readNonEmptyString(body.editToken), contents ? {
            text: contents.text, imageUrls: contents.imageUrls, skills: contents.skills, fileAttachments: contents.fileAttachments,
          } : undefined)
        } else if (body.type === 'resume') {
          await this.store.resume(id, revision)
        } else if (body.type === 'steer') {
          await this.deliveries.steer(id, revision)
        } else {
          throw new Error('无效的队列操作')
        }
      }
    }
    this.appServer.notifyQueueChanged(threadId)
    this.scheduleThreadQueueDrain(threadId, 0)
    const receipt = body.messageId ? await this.store.readReceipt(String(body.messageId)) : null
    return { state: await this.readState(), ...(removed ? { removed } : {}),
      ...(receipt?.turnId ? { delivered: { id: receipt.id, turnId: receipt.turnId } } : {}) }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    this.unsubscribe()
    if (this.pruneTimer) clearInterval(this.pruneTimer)
    for (const timer of this.queueDrainTimersByThreadId.values()) clearTimeout(timer)
    this.queueDrainTimersByThreadId.clear()
    this.queueDrainDueAtByThreadId.clear()
    this.recoveryChecks.clear()
    this.threadsNeedingResume.clear()
    this.history.clear()
    this.disposal = this.deliveries.dispose().finally(() => this.unbindQueueStateReader())
    return this.disposal
  }

  async scheduleAllQueuedThreads(delayMs = 0): Promise<void> {
    try {
      for (const threadId of Object.keys(await this.readState())) this.scheduleThreadQueueDrain(threadId, delayMs)
    } catch (error) {
      console.error('[delivery] 自动恢复已停止:', getErrorMessage(error, '无法读取发送记录'))
    }
  }

  scheduleThreadQueueDrain(threadId: string, delayMs = 5000): void {
    if (!threadId || this.disposed) return
    const normalizedDelayMs = Math.max(0, delayMs)
    const nextDueAt = Date.now() + normalizedDelayMs
    const existingDueAt = this.queueDrainDueAtByThreadId.get(threadId)
    const existingTimer = this.queueDrainTimersByThreadId.get(threadId)
    if (existingTimer) {
      if (existingDueAt !== undefined && existingDueAt <= nextDueAt) return
      clearTimeout(existingTimer)
    }
    const timer = setTimeout(() => {
      this.queueDrainTimersByThreadId.delete(threadId)
      this.queueDrainDueAtByThreadId.delete(threadId)
      void this.processThreadQueue(threadId)
    }, normalizedDelayMs)
    timer.unref?.()
    this.queueDrainTimersByThreadId.set(threadId, timer)
    this.queueDrainDueAtByThreadId.set(threadId, nextDueAt)
  }

  async processThreadQueue(threadId: string): Promise<void> {
    if (this.disposed || this.processingThreadIds.has(threadId)) return
    this.processingThreadIds.add(threadId)
    try {
      const rows = await this.store.records(threadId)
      const uncertain = rows.find(row => ['sending', 'unknown'].includes(row.status))
      if (uncertain) {
        const count = this.recoveryChecks.get(uncertain.message.id) ?? 0
        if (count >= 3) return
        this.recoveryChecks.set(uncertain.message.id, count + 1)
        await this.deliveries.reconcile(uncertain.message.id)
        this.scheduleThreadQueueDrain(threadId, [1000, 5000, 15000][count])
        return
      }
      const steer = rows.find(row => row.status === 'queued' && row.mode === 'steer')
      const head = steer ?? rows[0]
      if (!head || head.status !== 'queued') return
      await this.deliveries.process(threadId, steer?.message.id)
      if ((await this.store.records(threadId)).length) this.scheduleThreadQueueDrain(threadId)
    } catch (error) {
      console.error('[delivery] 队列已暂停:', getErrorMessage(error, '发送状态读取失败'))
    } finally {
      this.processingThreadIds.delete(threadId)
    }
  }

  private async canStartQueuedTurn(threadId: string): Promise<boolean> {
    if (this.appServer.listPendingServerRequests().some(row => extractThreadIdFromNotificationParams(row.params) === threadId)) return false
    try {
      const statusType = await this.readThreadStatus(threadId)
      return !['inProgress', 'running', 'active'].includes(statusType)
    } catch {
      // A failed live read cannot authorize dispatch or consume the queued intent.
      return false
    }
  }

  private async readThreadStatus(threadId: string): Promise<string> {
    this.threadsNeedingResume.delete(threadId)
    let response: Record<string, unknown> | null
    try {
      response = asRecord(await this.appServer.rpc('thread/read', { threadId, includeTurns: false }))
    } catch (error) {
      if (!isEmptyThreadReadError(error)) throw error
      response = asRecord(this.appServer.getLastThreadReadSnapshot(threadId))
    }
    const thread = asRecord(response?.thread)
    if (!thread) throw new Error('无法读取会话状态')
    const statusType = readNonEmptyString(asRecord(thread.status)?.type) || readNonEmptyString(thread.status)
    if (statusType === 'notLoaded') this.threadsNeedingResume.add(threadId)
    return statusType
  }

  private async resolveCollaborationModeSettings(mode: CollaborationModeKind): Promise<ResolvedCollaborationModeSettings> {
    let currentConfig: Record<string, unknown> | null = null
    try {
      currentConfig = asRecord(asRecord(await this.appServer.rpc('config/read', {}))?.config)
    } catch {
      currentConfig = null
    }

    const configuredModel = readNonEmptyString(currentConfig?.model)
    if (configuredModel) {
      return {
        model: configuredModel,
        reasoningEffort: normalizeCollaborationModeReasoningEffort(normalizeReasoningEffort(currentConfig?.model_reasoning_effort)),
      }
    }

    try {
      const modelsPayload = asRecord(await this.appServer.rpc('model/list', {}))
      const models = Array.isArray(modelsPayload?.data) ? modelsPayload.data : []
      for (const row of models) {
        const record = asRecord(row)
        const candidate = readNonEmptyString(record?.id) || readNonEmptyString(record?.model)
        if (candidate) {
          return {
            model: candidate,
            reasoningEffort: normalizeCollaborationModeReasoningEffort(normalizeReasoningEffort(currentConfig?.model_reasoning_effort)),
          }
        }
      }
    } catch {
      // Fall through to no collaboration-mode payload.
    }

    throw new Error(`${mode === 'plan' ? 'Plan' : 'Default'} mode requires an available model.`)
  }

  async buildQueuedTurnParams(turn: BackendQueuedTurn): Promise<Record<string, unknown>> {
    const localImageAttachments: StoredQueuedMessage['fileAttachments'] = []
    for (const imageUrl of turn.message.imageUrls) {
      const localImagePath = extractLocalImagePathFromUrl(imageUrl.trim())
      if (!localImagePath) continue
      localImageAttachments.push({
        label: fileNameFromPath(localImagePath),
        path: localImagePath,
        fsPath: localImagePath,
      })
    }

    const allFileAttachments = [...turn.message.fileAttachments, ...localImageAttachments]
    const dedupedFileAttachments = allFileAttachments.filter((entry, index) =>
      allFileAttachments.findIndex((candidate) => candidate.fsPath === entry.fsPath) === index)

    const queuedText = turn.message.text.trim().length > 0
      ? turn.message.text
      : turn.message.imageUrls.length > 0 ? '[Image]' : dedupedFileAttachments.length > 0 ? '[Attachment]' : ''

    const input: Array<Record<string, unknown>> = [{
      type: 'text',
      text: buildTextWithAttachments(queuedText, dedupedFileAttachments),
    }]

    for (const imageUrl of turn.message.imageUrls) {
      const normalizedUrl = imageUrl.trim()
      if (!normalizedUrl) continue
      const localImagePath = extractLocalImagePathFromUrl(normalizedUrl)
      if (localImagePath) {
        input.push({ type: 'localImage', path: localImagePath })
      } else {
        input.push({ type: 'image', url: normalizedUrl, image_url: normalizedUrl })
      }
    }

    for (const skill of turn.message.skills) {
      input.push({ type: 'skill', name: skill.name, path: skill.path })
    }

    const params: Record<string, unknown> = {
      threadId: turn.threadId,
      input,
    }
    if (dedupedFileAttachments.length > 0) {
      params.attachments = dedupedFileAttachments.map((file) => ({ label: file.label, path: file.path, fsPath: file.fsPath }))
    }

    const defaults = turn.message.model ? null : await this.resolveCollaborationModeSettings(turn.message.collaborationMode)
    const model = turn.message.model || defaults!.model
    const reasoningEffort = turn.message.effort !== undefined ? turn.message.effort || null : defaults?.reasoningEffort || null
    params.model = model
    if (turn.message.effort) params.effort = turn.message.effort
    if (turn.message.serviceTier !== undefined) params.serviceTier = turn.message.serviceTier
    params.collaborationMode = {
      mode: turn.message.collaborationMode,
      settings: { model, reasoning_effort: reasoningEffort, developer_instructions: null },
    }

    return params
  }
}
