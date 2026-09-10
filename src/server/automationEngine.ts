import { DEFAULT_TIME_ZONE } from '../timeZoneConstants.js'
import { buildAutomationMessage } from '../automationMessage.js'
import { AutomationHistory } from './automationHistory.js'
import type { AutomationModelSettings } from '../automationOptions.js'
import { automationTimeContext, formatAutomationTime } from './automationTime.js'
import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { parseAutomationToml, type ThreadAutomationRecord } from './automationDefinition.js'
import { createAutomationSchedule, validateAutomationTimezone } from './automationSchedule.js'
import { AutomationStore, isActiveAutomationRun, isPendingAutomationRun, pruneAutomationRuns, type AutomationRun, type AutomationState } from './automationStore.js'

export type AutomationInspection = { status: 'running' | 'waiting_input' | 'completed' | 'failed' | 'interrupted' | 'unknown'; turnId?: string; error?: string }
export interface AutomationRuntime {
  acquireAccount?(runId: string, settings: AutomationModelSettings): Promise<boolean>
  releaseAccount?(runId: string): void
  accountStorageId?(runId: string): string | null | undefined
  accountBusy(): boolean
  canStart(threadId: string): Promise<boolean>
  createThread(cwd: string, name: string, settings?: AutomationModelSettings, runId?: string): Promise<{ threadId: string; model?: string }>
  prepare(threadId: string, text: string, runId: string, settings?: AutomationModelSettings): Promise<unknown>
  start(params: unknown): Promise<{ turnId: string }>
  inspect(run: AutomationRun): Promise<AutomationInspection>
  interrupt(run: AutomationRun): Promise<void>
}
const isCancelledRun = (run: AutomationRun): boolean => run.status === 'cancelled'
type Definition = { record: ThreadAutomationRecord | null; error: string | null; signature: string }

export function automationError(error: unknown): { errorCode: string; error: string } {
  const text = error instanceof Error ? error.message : String(error)
  // Do not retain upstream responses, prompts or auth material in the run journal.
  if (/quota|rate.?limit|usage.?limit|429|额度|限额/iu.test(text)) return { errorCode: 'QUOTA_EXHAUSTED', error: '本次运行因所选账号额度不足结束；可改选账号后重试' }
  if (/auth|401|403|token|credential|bearer/iu.test(text)) return { errorCode: 'AUTH_REQUIRED', error: '认证失败；请检查当前账号，然后手动重试' }
  if (/model.*(not|invalid|unavailable|support)|模型/iu.test(text)) return { errorCode: 'MODEL_UNAVAILABLE', error: '模型不可用；请检查模型配置后重试' }
  if (/ENOENT|ENOTDIR|cwd|目录/iu.test(text)) return { errorCode: 'CWD_UNAVAILABLE', error: '工作目录不存在或不可访问' }
  if (/no rollout found|thread (?:not found|not loaded)|thread.*does not exist/iu.test(text)) return { errorCode: 'THREAD_UNAVAILABLE', error: '执行会话无法加载；请检查目标会话后重试' }
  if (/timeout|timed out|超时/iu.test(text)) return { errorCode: 'TIMEOUT', error: '请求超时；请打开执行会话核对结果' }
  if (/ECONN|EPIPE|network|fetch failed|socket/iu.test(text)) return { errorCode: 'CONNECTION_ERROR', error: '上游连接暂时不可用' }
  return { errorCode: 'EXECUTION_ERROR', error: '执行未完成；请打开会话查看错误并处理' }
}

async function bounded<T>(promise: Promise<T>, ms = 30000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('请求超时')), ms) })])
  } finally { clearTimeout(timer!) }
}

export class AutomationEngine {
  private state: AutomationState = { version: 1, definitions: {}, runs: [] }
  private definitions = new Map<string, Definition>()
  private store: AutomationStore
  private chain: Promise<unknown> = Promise.resolve()
  private saving: Promise<unknown> = Promise.resolve()
  private readonly dispatches = new Map<string, Promise<void>>()
  private timer: ReturnType<typeof setInterval> | null = null
  private pendingTick = false
  private stopped = false
  private ready = false
  private retryInitialization = false
  private error: string | null = null
  private drained = false
  private lastScan = 0
  private lastRenew = 0
  private lastInspect = 0
  private listeners = new Set<() => void>()
  timezone = validateAutomationTimezone(process.env.CODEXAPP_DEFAULT_TIMEZONE || DEFAULT_TIME_ZONE)
  readonly readyPromise: Promise<void>
  constructor(private home: string, private runtime: AutomationRuntime, private now = Date.now, private automatic = true, previousRuntimeStopped?: Promise<void>) {
    this.store = new AutomationStore(join(home, 'codexapp-automations'))
    this.readyPromise = this.serial(async () => {
      await previousRuntimeStopped
      await this.initialize()
    })
    if (automatic) {
      this.timer = setInterval(() => {
        if (this.stopped) return
        if (this.retryInitialization && !this.pendingTick && this.now() - this.lastRenew > 30000) {
          this.lastRenew = this.now()
          void this.serial(() => this.initialize()).catch(() => {})
        } else void this.tick().catch(() => {})
      }, 1000)
      this.timer.unref()
    }
  }
  private async initialize() {
    if (this.stopped) return
    try {
      if (!await this.store.acquire(this.now())) {
        this.retryInitialization = true
        throw new Error('另一个实例持有调度锁；本实例等待锁释放后再执行自动化')
      }
      this.retryInitialization = false
      this.state = await this.store.read()
      await this.scan()
      for (const run of this.state.runs.filter(isActiveAutomationRun)) await this.reconcile(run, true)
      await this.persist()
      this.ready = true; this.error = null
    } catch (error) { this.error = error instanceof Error ? error.message : '调度器初始化失败' }
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn)
    this.chain = next.catch(() => {})
    return next
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private persist(): Promise<void> {
    const next = this.saving.then(() => this.persistNow())
    this.saving = next.catch(() => undefined)
    return next
  }
  private async persistNow() {
    const hot = pruneAutomationRuns(this.state.runs, this.now())
    const retained = new Set(hot.map(run => run.runId))
    await this.store.assertOwnership()
    await this.history.archive(this.state.runs.filter(run => !retained.has(run.runId)))
    this.state.runs = hot
    await this.store.write(this.state)
    for (const listener of this.listeners) listener()
  }
  snapshot() {
    return {
      ready: this.ready && !this.stopped && !this.error, draining: this.drained, error: this.error, timezone: this.timezone,
      activeCount: this.state.runs.filter(isActiveAutomationRun).length,
      queuedCount: this.state.runs.filter((run) => run.status === 'queued').length,
      definitions: [...this.definitions].map(([id, value]) => ({ id, error: value.error, ...this.state.definitions[id] })),
    }
  }
  activity() { return this.state.runs.filter(isPendingAutomationRun).map((run) => run.threadId || `automation:${run.runId}`) }
  decorate(record: ThreadAutomationRecord) {
    const meta = this.state.definitions[record.id]
    return { ...record, timezone: meta?.timezone ?? this.timezone, nextRunAtMs: record.status === 'ACTIVE' ? meta?.nextRunAtMs ?? null : null }
  }
  private get history() { return this.historyStore ??= new AutomationHistory(this.store.directory) }
  private historyStore?: AutomationHistory
  async historyPage(id: string, cursor: string | null, limit: number) { await this.readyPromise; return this.history.page(id, this.state.runs, cursor, limit) }
  runs(id: string, before = Infinity, limit = 20) {
    const items = this.state.runs.filter((run) => (!id || run.automationId === id) && run.createdAt < before).sort((a, b) => b.createdAt - a.createdAt)
    const data = items.slice(0, Math.max(1, Math.min(100, limit)))
    return { data, nextCursor: items.length > data.length ? data.at(-1)?.createdAt ?? null : null }
  }
  private async scan() {
    try {
      const global = JSON.parse(await readFile(join(this.home, 'account-activation', 'state.json'), 'utf8'))
      this.timezone = validateAutomationTimezone(global.settings.timezone)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const root = join(this.home, 'automations')
    const entries = await readdir(root, { withFileTypes: true }).catch((error) => { if (error.code === 'ENOENT') return []; throw error })
    const seen = new Set<string>()
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const id = entry.name
      const file = join(root, id, 'automation.toml')
      let signature = ''
      try {
        const info = await stat(file)
        signature = `${info.mtimeMs}:${info.size}:${this.timezone}`
        seen.add(id)
        if (this.definitions.get(id)?.signature === signature) continue
        const record = parseAutomationToml(await readFile(file, 'utf8'))
        if (!record || record.id !== id) throw new Error('automation.toml 无效或 ID 与目录不符')
        if (record.kind === 'heartbeat' ? !record.targetThreadId : !record.cwds.length || record.cwds.some((cwd) => !isAbsolute(cwd))) throw new Error('缺少有效的执行目标')
        const previous = this.state.definitions[id]
        const timezone = this.timezone
        const revision = createHash('sha256').update(JSON.stringify([record.rrule, record.prompt, record.status, record.targetThreadId, record.cwds, timezone, record.model, record.reasoningEffort, record.serviceTier, record.accountStorageId, record.protected])).digest('hex').slice(0, 16)
        const anchor = previous?.revision === revision ? previous.anchor : this.now()
        const schedule = createAutomationSchedule(record.rrule, timezone, anchor)
        if (previous?.revision !== revision) {
          this.cancelQueued(id, '任务已修改，旧的待执行记录已取消')
          this.state.definitions[id] = { revision, timezone, anchor, cursor: this.now(), nextRunAtMs: record.status === 'ACTIVE' ? schedule.next(this.now()) : null }
        }
        const current = this.state.definitions[id]!
        if (record.status === 'ACTIVE' && current.nextRunAtMs === null) current.nextRunAtMs = schedule.next(Math.max(current.cursor, this.now()))
        this.definitions.set(id, { record, error: null, signature })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        seen.add(id)
        this.definitions.set(id, { record: null, signature, error: error instanceof Error ? error.message : '无法读取任务' })
        this.cancelQueued(id, '任务定义无效，已取消待执行记录')
        if (this.state.definitions[id]) this.state.definitions[id]!.nextRunAtMs = null
      }
    }
    for (const id of this.definitions.keys()) if (!seen.has(id)) { this.cancelQueued(id, '任务已删除'); this.definitions.delete(id); delete this.state.definitions[id] }
    this.lastScan = this.now()
  }
  private finish(run: AutomationRun, status: AutomationRun['status'], error?: string, errorCode?: string) {
    this.runtime.releaseAccount?.(run.runId)
    run.status = status; run.finishedAt = this.now(); run.error = error ?? null; run.errorCode = errorCode ?? null
  }
  private cancelQueued(id: string, reason: string) {
    for (const run of this.state.runs) if (run.automationId === id && run.status === 'queued') this.finish(run, 'cancelled', reason, 'DEFINITION_CHANGED')
  }
  refresh(id?: string, timezone?: string): Promise<void> {
    return this.serial(async () => {
      this.assertReady()
      if (id && timezone) {
        validateAutomationTimezone(timezone)
        if (this.state.definitions[id]) this.state.definitions[id]!.timezone = timezone
        else this.state.definitions[id] = { timezone, revision: '', anchor: this.now(), cursor: this.now(), nextRunAtMs: null }
        this.definitions.delete(id)
      }
      await this.scan(); await this.persist()
    })
  }
  cancelAccount(storageId: string, primary: boolean, runIds: string[]): Promise<void> {
    return this.serial(async () => {
      for (const run of this.state.runs.filter(isPendingAutomationRun)) {
        const settings = this.definitions.get(run.automationId)?.record
        const selected = run.executionAccountStorageId
        const matches = selected !== undefined
          ? selected === storageId
          : settings?.accountStorageId === storageId || (primary && !settings?.accountStorageId && !run.submittedAt)
        if (runIds.includes(run.runId) || matches) {
          this.finish(run, 'cancelled', '执行账号已移除，关联连接已关闭', 'ACCOUNT_REMOVED')
        }
      }
      await this.persist()
    })
  }
  private assertReady() { if (!this.ready || this.stopped || this.error) throw new Error(this.error ?? '调度器尚未就绪') }
  drain(value = true) {
    return this.serial(async () => { this.assertReady(); this.drained = value; await this.persist(); return this.snapshot() })
  }
  manual(id: string, target: string, requestId: string, retryOf?: string): Promise<AutomationRun> {
    return this.serial(async () => {
      this.assertReady()
      if (this.drained) throw new Error('调度器正在交接，暂不接受新运行')
      if (!requestId || requestId.length > 128) throw new Error('需要有效的 requestId 以避免重复提交')
      await this.scan()
      const record = this.definitions.get(id)?.record
      if (!record || !(record.kind === 'heartbeat' ? record.targetThreadId === target : record.cwds.includes(target))) throw new Error('找不到有效任务或执行目标')
      const key = `manual:${id}:${target}:${requestId}`
      const existing = this.state.runs.find((run) => run.key === key) ?? await this.history.findByKey(key)
      if (existing) return { ...existing }
      const previous = retryOf ? this.state.runs.find((run) => run.runId === retryOf && run.automationId === id) ?? await this.history.findById(id, retryOf) : undefined
      if (retryOf && (!previous || previous.target !== target || isPendingAutomationRun(previous))) throw new Error('原运行不存在或仍未结束')
      if (this.state.runs.some((run) => run.automationId === id && run.target === target && run.status === 'queued')) throw new Error('此目标已有待执行任务，请等待队列')
      const run = this.enqueue(record, target, this.now(), key, previous ? 'retry' : 'manual')
      if (previous) { run.retryOf = previous.runId; run.attempt = previous.attempt + 1 }
      await this.persist()
      return { ...run }
    })
  }
  private enqueue(record: ThreadAutomationRecord, target: string, at: number, key: string, trigger: AutomationRun['trigger']): AutomationRun {
    const meta = this.state.definitions[record.id]!
    const run: AutomationRun = {
      runId: randomUUID(), automationId: record.id, target, kind: record.kind, key, revision: meta.revision,
      trigger, scheduledAt: at, timezone: meta.timezone, status: 'queued', attempt: 1,
      createdAt: Math.max(this.now(), (this.state.runs.at(-1)?.createdAt ?? 0) + 1), startedAt: null, finishedAt: null, threadId: record.targetThreadId, turnId: null, model: null, errorCode: null, error: null,
    }
    this.state.runs.push(run)
    return run
  }
  tick(): Promise<void> {
    if (this.pendingTick || !this.ready || this.stopped || this.error) return Promise.resolve()
    this.pendingTick = true
    const started: Promise<void>[] = []
    return this.serial(async () => {
      if (this.stopped) return
      const now = this.now()
      try {
        if (now - this.lastRenew >= 30000) { await this.store.renew(); this.lastRenew = now }
        let changed = false
        if (now - this.lastScan >= 60000) { await this.scan(); changed = true }
        if (!this.drained) for (const [id, definition] of this.definitions) {
          const record = definition.record, meta = this.state.definitions[id]
          if (!record || record.status !== 'ACTIVE' || !meta?.nextRunAtMs || meta.nextRunAtMs > now) continue
          const schedule = createAutomationSchedule(record.rrule, meta.timezone, meta.anchor)
          const latest = schedule.previous(now)
          if (latest === null || latest <= meta.cursor) continue
          const targets = record.kind === 'heartbeat' ? [record.targetThreadId!] : record.cwds
          for (const target of targets) {
            const key = `${id}:${meta.revision}:${target}:${latest}`
            if (this.state.runs.some((run) => run.key === key)) continue
            const queued = this.state.runs.some((run) => run.automationId === id && run.target === target && run.status === 'queued')
            if (latest > meta.nextRunAtMs) {
              const missed = this.enqueue(record, target, meta.nextRunAtMs, `${key}:gap`, 'schedule')
              this.finish(missed, now - meta.nextRunAtMs > 86400000 ? 'missed' : 'skipped', '多个漏跑时点已合并；仅考虑最近一个时点', 'COALESCED')
            }
            const run = this.enqueue(record, target, latest, key, 'schedule')
            if (now - latest > 86400000) this.finish(run, 'missed', '漏跑超过 24 小时，请按需手动补跑', 'MISSED')
            else if (queued) this.finish(run, 'skipped', '已有待执行记录，合并本次触发', 'COALESCED')
          }
          meta.cursor = latest; meta.nextRunAtMs = schedule.next(Math.max(now, latest)); changed = true
        }
        if (changed) await this.persist()
        if (now - this.lastInspect >= 30000) {
          this.lastInspect = now
          for (const run of this.state.runs.filter(isActiveAutomationRun)) { if (!this.dispatches.has(run.runId)) { await this.reconcile(run); await this.persist() } }
        }
        if (!this.runtime.accountBusy()) {
          for (const run of this.state.runs.filter((row) => row.status === 'queued' && (!row.retryAfter || row.retryAfter <= now))) {
            if (this.state.runs.filter(isActiveAutomationRun).length >= 4) break
            if (this.state.runs.some(other => isActiveAutomationRun(other) && other.automationId === run.automationId && other.target === run.target)) continue
            if (this.runtime.accountBusy() || this.stopped) break
            run.status = 'starting'
            await this.persist()
            const flight = this.dispatch(run).catch(() => { this.error = '运行记录保存失败，调度已暂停'; this.ready = false })
              .finally(() => { this.dispatches.delete(run.runId) })
            this.dispatches.set(run.runId, flight)
            started.push(flight)
          }
        }
      } catch (error) { this.error = error instanceof Error ? error.message : '调度器停止'; this.ready = false }
    }).finally(() => { this.pendingTick = false }).then(async () => { await Promise.all(started) })
  }
  private async dispatch(run: AutomationRun) {
    const record = this.definitions.get(run.automationId)?.record
    if (!record || this.state.definitions[record.id]?.revision !== run.revision) { this.finish(run, 'cancelled', '任务已修改'); await this.persist(); return }
    if (run.kind === 'heartbeat') {
      try {
        if (!await bounded(this.runtime.canStart(run.target))) { if (isCancelledRun(run)) return; run.status = 'queued'; await this.persist(); return }
      } catch (error) {
        const info = automationError(error)
        this.finish(run, 'failed', info.error, info.errorCode)
        await this.persist()
        return
      }
    }
    if (this.runtime.acquireAccount) {
      try {
        if (!await this.runtime.acquireAccount(run.runId, record)) {
          if (isCancelledRun(run)) return
          run.status = 'queued'
          run.retryAfter = this.now() + 30_000
          run.error = '等待所选账号额度或该账号的自动化运行结束'
          run.errorCode = 'WAITING_ACCOUNT'
          await this.persist()
          return
        }
      } catch (error) {
        if (isCancelledRun(run)) return
        this.finish(run, 'failed', automationError(error).error, 'ACCOUNT_UNAVAILABLE')
        await this.persist()
        return
      }
    }
    if (isCancelledRun(run)) { this.runtime.releaseAccount?.(run.runId); return }
    run.executionAccountStorageId = this.runtime.accountStorageId?.(run.runId)
    run.status = 'starting'; run.startedAt = this.now(); run.error = null; run.errorCode = null
    await this.persist()
    try {
      if (!run.threadId) {
        if (!(await stat(run.target)).isDirectory()) throw new Error('cwd 不是目录')
        const thread = await bounded(this.runtime.createThread(run.target, `${record.name} · ${formatAutomationTime(run.scheduledAt, run.timezone)}`, record, run.runId))
        run.threadId = thread.threadId; run.model = thread.model ?? null
        await this.persist()
      }
      const text = buildAutomationMessage({
        runId: run.runId, automationId: record.id, name: record.name,
        scheduledAt: run.scheduledAt, startedAt: run.startedAt ?? run.scheduledAt, timezone: run.timezone,
      }, automationTimeContext(run), record.prompt)
      const params = await bounded(this.runtime.prepare(run.threadId, text, run.runId, record))
      const execution = params as { model?: string; effort?: string; serviceTier?: string | null; collaborationMode?: { settings?: { model?: string; reasoning_effort?: string } } }
      const model = execution.collaborationMode?.settings?.model ?? execution.model
      if (model) run.model = model
      run.serviceTier = execution.serviceTier ?? null
      run.reasoningEffort = execution.collaborationMode?.settings?.reasoning_effort ?? execution.effort ?? null
      if (isCancelledRun(run)) { this.runtime.releaseAccount?.(run.runId); return }
      if (this.stopped) { this.finish(run, 'interrupted', '服务已停止，尚未提交', 'SERVICE_STOPPED'); await this.persist(); return }
      // Write intent before RPC. Any error after this point requires reconciliation, never an automatic replay.
      run.submittedAt = this.now()
      await this.persist()
      const result = await bounded(this.runtime.start(params))
      run.turnId = result.turnId
      if (isActiveAutomationRun(run)) run.status = 'running'
    } catch (error) {
      if (isCancelledRun(run)) { this.runtime.releaseAccount?.(run.runId); return }
      const info = automationError(error)
      if ((error as { rpcRejected?: boolean })?.rpcRejected) this.finish(run, 'failed', info.error, info.errorCode)
      else if (run.submittedAt) { run.status = 'starting'; run.error = '提交结果待核对；不会自动重复提交'; run.errorCode = 'SUBMISSION_UNKNOWN' }
      else if (['CONNECTION_ERROR', 'TIMEOUT'].includes(info.errorCode) && run.attempt < 3) {
        this.runtime.releaseAccount?.(run.runId)
        run.status = 'queued'; run.retryAfter = this.now() + 5000 * 2 ** (run.attempt - 1); run.attempt += 1
        Object.assign(run, info)
      } else this.finish(run, 'failed', info.errorCode === 'EXECUTION_ERROR' ? '消息尚未发送；请检查任务配置后重试' : info.error, info.errorCode)
    }
    await this.persist()
  }
  private async reconcile(run: AutomationRun, restart = false) {
    if (!run.submittedAt || !run.threadId) { if (restart) this.finish(run, 'interrupted', '服务在提交前退出，请按需重试', 'SERVICE_RESTARTED'); return }
    try {
      const result = await bounded(this.runtime.inspect(run))
      if (result.turnId) run.turnId = result.turnId
      if (result.status === 'unknown') {
        if (restart || this.now() - run.submittedAt > 120000) this.finish(run, 'interrupted', '无法确认提交结果，请检查会话后再决定是否重试', 'SUBMISSION_UNKNOWN')
        return
      }
      if (['completed', 'failed', 'interrupted'].includes(result.status)) {
        const info = result.status === 'failed' ? automationError(result.error ?? '') : null
        this.finish(run, result.status as AutomationRun['status'], info?.error, info?.errorCode)
      } else {
        run.status = result.status as 'running' | 'waiting_input'
        if (this.now() - run.submittedAt > Number(process.env.CODEXAPP_AUTOMATION_TIMEOUT_MS || 3600000)) {
          await bounded(this.runtime.interrupt(run))
          run.errorCode = 'RUN_TIMEOUT'; run.error = '运行已超时，已请求中止，等待上游确认'
        }
      }
    } catch (error) {
      if (restart || this.now() - run.submittedAt > 3600000) this.finish(run, 'interrupted', '上游状态无法核对，请检查执行会话', automationError(error).errorCode)
    }
  }
  notification(notification: { method: string; params: unknown }) {
    if (!this.ready || this.stopped) return
    const params = notification.params as { threadId?: string; thread_id?: string; turn?: { id?: string; status?: string; error?: unknown }; turnId?: string }
    const threadId = params?.threadId ?? params?.thread_id ?? (params as { params?: { threadId?: string } })?.params?.threadId
    if (!threadId || !/^(turn\/|server\/request)/u.test(notification.method)) return
    void this.serial(async () => {
      const run = this.state.runs.find((row) => isActiveAutomationRun(row) && row.threadId === threadId)
      if (!run) return
      if (notification.method === 'turn/completed') {
        if (run.turnId && params.turn?.id !== run.turnId) return
        // Read and correlate the run marker if the start response was lost.
        if (!run.turnId) await this.reconcile(run)
        else if (params.turn?.status === 'completed' && !params.turn.error) this.finish(run, 'completed')
        else { const info = automationError((params.turn?.error as { message?: string })?.message ?? ''); this.finish(run, params.turn?.status === 'interrupted' ? 'interrupted' : 'failed', info.error, info.errorCode) }
      } else if (notification.method === 'server/request') run.status = 'waiting_input'
      else if (notification.method === 'server/request/resolved') run.status = 'running'
      else return
      await this.persist()
    }).catch(() => { this.error = '运行记录写入失败，调度已停止'; this.ready = false })
  }
  dispose(): Promise<void> {
    this.stopped = true; this.ready = false
    if (this.timer) clearInterval(this.timer)
    return this.serial(async () => { await Promise.all(this.dispatches.values()); await this.saving; this.listeners.clear(); await this.store.release() })
  }
}
