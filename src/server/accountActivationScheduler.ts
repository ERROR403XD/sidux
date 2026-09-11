import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AutomationStore } from './automationStore.js'
import { privateJson } from './apiProxy/store.js'
import { AccountActivationHistory, activationHistoryCutoff, activationRunDate } from './accountActivationHistory.js'
import { activationClock, nextActivationAt, validateActivationSettings, type ActivationSettings, type ActivationRun, type ActivationSnapshot } from '../accountActivation.js'
export type ActivationCheck = { allowed: boolean; reason: string; stamp: string }
export type ActivationWorker = { send: (signal: AbortSignal) => Promise<void>; dispose: () => Promise<void> }
export function activationBounded<T>(work: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('激活已中止或超时，不自动重发'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    work.then(value => {
      if (signal.aborted) late?.(value)
      else resolve(value)
    }, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
type State = { version: 1; settings: ActivationSettings; runs: ActivationRun[]; claims: Record<string, number> }
export class AccountActivationScheduler {
  readonly ready: Promise<void>
  private state: State = { version: 1, settings: { enabled: false, accountIds: [], times: [], timezone: 'UTC' }, runs: [], claims: {} }
  private error = ''
  private nextAt: number | null = null
  private revision = 0
  private timer: NodeJS.Timeout | null = null
  private flight: Promise<void> | null = null
  private writes: Promise<unknown> = Promise.resolve()
  private closed = false
  private activeAbort: AbortController | null = null
  private readonly lease: AutomationStore
  private readonly abort = new AbortController()
  private readonly history: AccountActivationHistory
  constructor(private directory: string, private dependencies: {
    check: (accountId: string, phase: 'before' | 'after') => Promise<ActivationCheck>
    busy: (accountId: string) => boolean
    initialize?: () => Promise<void>
    prepare: (accountId: string, signal: AbortSignal) => Promise<ActivationWorker>
    accountExists: (accountId: string) => Promise<boolean>
    afterSend?: (accountId: string) => Promise<string>
    timeoutMs?: number
    cleanupMs?: number
    syncMs?: number
    model: string
  }, private now = Date.now, start = true) {
    this.lease = new AutomationStore(join(directory, 'writer'))
    this.history = new AccountActivationHistory(join(directory, 'history'), this.now)
    this.ready = this.initialize(start).catch(error => { this.error = error instanceof Error ? error.message : '激活调度器不可用' })
  }
  private async initialize(start: boolean): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    if (!await this.lease.acquire(this.now())) throw new Error('另一个进程正在管理账号激活计划')
    try {
      const saved = JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8'))
      if (saved.version !== 1 || !Array.isArray(saved.runs) || !saved.claims || typeof saved.claims !== 'object') throw new Error('激活计划文件损坏，已停止执行')
      this.state = { ...saved, settings: validateActivationSettings(saved.settings) }
      this.state.runs = this.state.runs.map(run => ['preparing', 'sending'].includes(run.status) ? { ...run, status: 'unknown', reason: '服务曾中断，不自动重发', finishedAt: this.now() } : run)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    this.state.runs = this.state.runs.filter(run => activationRunDate(run) >= activationHistoryCutoff(this.now()))
    await this.history.initialize(this.state.runs)
    await this.write()
    await this.dependencies.initialize?.()
    // Startup deliberately chooses the next future slot; there is no backfill.
    this.nextAt = nextActivationAt(this.state.settings, this.now())
    if (start) {
      this.timer = setInterval(() => { void this.tick().catch(() => { this.error = '激活调度状态保存失败，已停止执行' }) }, 10000)
      this.timer.unref()
    }
  }
  private write(run?: ActivationRun): Promise<void> {
    const historyRun = run ? structuredClone(run) : undefined
    const work = this.writes.then(async () => {
      await this.lease.assertOwnership()
      await privateJson(join(this.directory, 'state.json'), this.state)
      if (historyRun) await this.history.record(historyRun)
    })
    this.writes = work.catch(() => {})
    return work
  }
  async snapshot(): Promise<ActivationSnapshot> {
    await this.ready
    return { settings: structuredClone(this.state.settings), runs: structuredClone(this.state.runs.slice(-100).reverse()), nextAt: this.nextAt, error: this.error, model: this.dependencies.model }
  }
  async historyPage(page: number) {
    await this.ready
    if (this.error) throw new Error(this.error)
    await this.writes
    return this.history.page(page)
  }
  async configure(input: unknown): Promise<ActivationSnapshot> {
    await this.ready
    if (this.closed || this.error) throw new Error(this.error || '调度器已关闭')
    const settings = validateActivationSettings(input)
    for (const id of settings.accountIds) if (!await this.dependencies.accountExists(id)) throw new Error('所选账号已移除，请重新选择')
    const previous = this.state.settings
    this.revision += 1
    this.activeAbort?.abort()
    this.state.settings = settings
    this.nextAt = nextActivationAt(settings, this.now())
    try { await this.write() } catch (error) {
      this.state.settings = previous
      this.nextAt = nextActivationAt(previous, this.now())
      throw error
    }
    return this.snapshot()
  }
  async tick(): Promise<void> {
    await this.ready
    if (this.closed || this.error) return
    await this.lease.renew()
    await this.history.prune()
    const cutoff = activationHistoryCutoff(this.now())
    if (this.state.runs.some(run => activationRunDate(run) < cutoff)) {
      this.state.runs = this.state.runs.filter(run => activationRunDate(run) >= cutoff)
      await this.write()
    }
    if (this.flight) return
    const at = this.nextAt
    if (at === null || this.now() < at) return
    const settings = structuredClone(this.state.settings)
    this.nextAt = nextActivationAt(settings, this.now())
    const revision = this.revision
    const work = this.execute(settings, at, revision).finally(() => { this.flight = null })
    this.flight = work
    return work
  }
  private async execute(settings: ActivationSettings, at: number, revision: number): Promise<void> {
    const clock = activationClock(settings.timezone)(at)
    for (const accountId of settings.accountIds) {
      if (this.closed || this.error || revision !== this.revision) break
      const key = JSON.stringify([accountId, settings.timezone, clock.date, clock.time])
      if (this.state.claims[key]) continue
      const run: ActivationRun = { key, accountId, scheduledAt: at, status: 'preparing', reason: '' }
      this.state.claims[key] = at
      this.state.claims = Object.fromEntries(Object.entries(this.state.claims).filter(([, timestamp]) => this.now() - timestamp < 3 * 86400000))
      this.state.runs = [...this.state.runs.slice(-199), run]
      await this.write(run) // claim before any network operation; crash cannot cause replay.
      let worker: ActivationWorker | undefined
      let dispatched = false
      const activeAbort = new AbortController()
      this.activeAbort = activeAbort
      const signal = AbortSignal.any([this.abort.signal, activeAbort.signal, AbortSignal.timeout(this.dependencies.timeoutMs ?? 60000)])
      try {
        if (this.dependencies.busy(accountId)) throw new Error('账号正在使用或凭据正在变更，本次跳过')
        const before = await activationBounded(this.dependencies.check(accountId, 'before'), signal)
        if (!before.allowed) throw new Error(before.reason)
        worker = await activationBounded(this.dependencies.prepare(accountId, signal), signal, late => { void late.dispose().catch(() => {}) })
        run.status = 'sending'
        await this.write(run)
        const after = await activationBounded(this.dependencies.check(accountId, 'after'), signal)
        // No await between the final synchronous admission check and starting fetch.
        if (!after.allowed || after.stamp !== before.stamp || this.dependencies.busy(accountId)) throw new Error(after.reason || '准备期间账号状态或连接发生变化')
        if (this.closed || revision !== this.revision || signal.aborted) throw new Error('计划已变更或准备超时')
        dispatched = true
        await activationBounded(worker.send(signal), signal)
        run.status = 'sent'
        run.reason = '请求已完成；额度待同步'
      } catch (error) {
        run.status = dispatched ? 'unknown' : 'skipped'
        // Dependencies return only fixed diagnostic strings, never upstream credential-bearing bodies.
        run.reason = error instanceof Error && error.name !== 'AbortError' ? error.message : '激活已中止，不自动重发'
      } finally {
        activeAbort.abort()
        this.activeAbort = null
        if (worker) {
          await activationBounded(worker.dispose(), AbortSignal.timeout(this.dependencies.cleanupMs ?? 2000)).catch(() => {
            run.reason = '激活资源释放异常；本次不重发，继续后续计划'
          })
        }
        run.finishedAt = this.now()
        await this.write(run)
      }
      // Persist generation completion and release its lease before optional quota work.
      if (run.status === 'sent' && this.dependencies.afterSend && !this.closed && revision === this.revision) {
        const syncSignal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(this.dependencies.syncMs ?? 5000)])
        try { run.reason = await activationBounded(this.dependencies.afterSend(accountId), syncSignal) }
        catch { run.reason = '请求已完成；额度同步失败，不重发' }
        await this.write(run)
      }
    }
  }
  async dispose(): Promise<void> {
    this.closed = true
    this.abort.abort()
    if (this.timer) clearInterval(this.timer)
    await this.ready
    await this.flight?.catch(() => {})
    await this.writes
    await this.lease.release()
  }
}
