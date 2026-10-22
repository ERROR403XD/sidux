import { createDeliveryId } from '../delivery.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { privateJson } from './apiProxy/store.js'

export type QuotaResumeMark = { status: 'armed' | 'waiting' | 'submitted' | 'unknown'; blockedTurnId: string | null; attemptId: string | null; attemptedAt?: number; lastError?: string }
type ThreadState = { active: boolean; turnId: string | null; status: string; error: string }
type Runtime = {
  inspect(threadId: string): Promise<ThreadState>
  available(): Promise<boolean>
  submit(threadId: string, attemptId: string): Promise<void>
  cancel(attemptId: string): Promise<void>
  reconcile?(threadId: string, attemptId: string, attemptedAt?: number): Promise<'waiting' | 'submitted' | 'unknown'>
  changed(): void
}
export const isQuotaFailure = (error: string) => /rate.?limit|usage.?limit|quota|429|额度|限额/iu.test(error)
const isQuotaBlocked = (state: ThreadState) => !state.active && ['failed', 'interrupted'].includes(state.status) && isQuotaFailure(state.error)

// The delivery ledger owns submission deduplication; this file only owns intent.
export class ThreadQuotaResume {
  private marks: Record<string, QuotaResumeMark> = {}
  private serial: Promise<unknown> = Promise.resolve()
  private ticking = false
  private stopped = false
  private storageFailure: Error | null = null
  private inspectionOffset = 0
  private waitingOffset = 0
  private unknownOffset = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly path: string
  readonly ready: Promise<void>
  constructor(home: string, private runtime: Runtime, automatic = true, previousRuntimeStopped: Promise<void> = Promise.resolve()) {
    this.path = join(home, 'codexapp-quota-resume.json')
    const path = this.path
    this.ready = (async () => {
      await previousRuntimeStopped
      try {
        const data = JSON.parse(await readFile(path, 'utf8'))
        if (data.version !== 1 || !data.marks || typeof data.marks !== 'object') throw new Error('续跑标记文件格式无效')
        this.marks = data.marks
        // An interrupted hand-off is never automatically submitted a second time.
        for (const mark of Object.values(this.marks)) if (mark.status === 'submitted') mark.status = 'unknown'
      } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause }
    })()
    void this.ready.catch(() => undefined)
    if (automatic) {
      this.timer = setInterval(() => { void this.tick().catch(() => undefined) }, 30_000)
      this.timer.unref()
    }
  }
  private async saveMark(threadId: string, mark?: QuotaResumeMark): Promise<void> {
    const next = { ...this.marks }
    if (mark) next[threadId] = mark
    else delete next[threadId]
    try {
      await privateJson(this.path, { version: 1, marks: next })
    } catch {
      // Atomic rename may have committed before a later filesystem failure.
      // Do not publish speculative state or retry delivery until restart/reconciliation.
      this.storageFailure = new Error('续跑状态保存结果未确认，已停止续跑；请检查存储并重启服务核对。')
      this.notifyChanged()
      throw this.storageFailure
    }
    this.marks = next
    this.notifyChanged()
  }
  private notifyChanged(): void {
    try { this.runtime.changed() } catch { /* Notification failure cannot undo a durable state transition. */ }
  }
  private operation<T>(run: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('额度续跑服务已停止'))
    const next = this.serial.then(async () => {
      await this.ready
      if (this.storageFailure) throw this.storageFailure
      return run()
    })
    this.serial = next.catch(() => undefined)
    return next
  }
  async snapshot(): Promise<Record<string, QuotaResumeMark>> {
    await this.ready
    if (this.storageFailure) throw this.storageFailure
    return structuredClone(this.marks)
  }
  async has(threadId: string): Promise<boolean> {
    await this.ready
    if (this.storageFailure) throw this.storageFailure
    return Object.hasOwn(this.marks, threadId)
  }
  set(threadId: string, enabled: boolean): Promise<void> {
    return this.operation(async () => {
      if (!/^[a-zA-Z0-9-]{1,128}$/.test(threadId)) throw new Error('会话ID无效')
      if (!enabled) {
        const attempt = this.marks[threadId]?.attemptId
        if (attempt) await this.runtime.cancel(attempt)
        await this.saveMark(threadId)
      } else if (!this.marks[threadId]) {
        if (Object.keys(this.marks).length >= 1000) throw new Error('续跑标记数量已达上限')
        const state = await this.runtime.inspect(threadId)
        await this.saveMark(threadId, { status: isQuotaBlocked(state) ? 'waiting' : 'armed', blockedTurnId: state.turnId, attemptId: null })
      }
    })
  }
  blocked(threadId: string, turnId: string | null): Promise<void> {
    return this.operation(async () => {
      const mark = this.marks[threadId]
      if (!mark) return
      await this.saveMark(threadId, { status: 'waiting', blockedTurnId: turnId, attemptId: null })
    })
  }
  observe(notification: { method: string; params: unknown }): void {
    const params = notification.params as { threadId?: string; turn?: { id?: string; status?: string; error?: unknown } }
    if (notification.method !== 'turn/completed' || !params?.threadId) return
    const id = params.threadId
    if (isQuotaFailure(JSON.stringify(params.turn?.error || ''))) {
      void this.blocked(id, params.turn?.id || null).catch(() => undefined)
    } else if (params.turn?.status === 'completed') {
      void this.operation(async () => {
        const mark = this.marks[id]
        if (!mark) return
        await this.saveMark(id, { status: 'armed', blockedTurnId: mark.blockedTurnId, attemptId: null })
      }).catch(() => undefined)
    }
  }
  private rotatingBatch(status: 'waiting' | 'unknown'): [string, QuotaResumeMark][] {
    const rows = Object.entries(this.marks).filter(([, mark]) => mark.status === status)
    const key = status === 'waiting' ? 'waitingOffset' : 'unknownOffset'
    const count = Math.min(8, rows.length)
    const batch = Array.from({ length: count }, (_, index) => rows[(this[key] + index) % rows.length]!)
    this[key] = rows.length ? (this[key] + count) % rows.length : 0
    return batch
  }
  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return
    this.ticking = true
    try {
      await this.operation(async () => {
        // Recover missed completion notifications after disconnect/restart.
        const candidates = Object.entries(this.marks).filter(([, mark]) => ['armed', 'submitted'].includes(mark.status))
        const count = Math.min(8, candidates.length)
        for (let index = 0; index < count; index++) {
          const [threadId, mark] = candidates[(this.inspectionOffset + index) % candidates.length]!
          let state: ThreadState
          try { state = await this.runtime.inspect(threadId) }
          catch { continue }
          if (state.active) continue
          if (isQuotaBlocked(state) && (mark.status === 'armed' || state.turnId !== mark.blockedTurnId)) {
            await this.saveMark(threadId, { status: 'waiting', blockedTurnId: state.turnId, attemptId: null })
          } else if (mark.status === 'submitted' && state.status === 'completed') {
            await this.saveMark(threadId, { status: 'armed', blockedTurnId: mark.blockedTurnId, attemptId: null })
          }
        }
        if (candidates.length) this.inspectionOffset = (this.inspectionOffset + count) % candidates.length
        for (const [threadId, mark] of this.rotatingBatch('unknown')) {
          if (!mark.attemptId || !this.runtime.reconcile) continue
          let status: 'waiting' | 'submitted' | 'unknown'
          try { status = await this.runtime.reconcile(threadId, mark.attemptId, mark.attemptedAt) }
          catch { continue }
          if (status !== mark.status) {
            await this.saveMark(threadId, { ...mark, status, attemptId: status === 'waiting' ? null : mark.attemptId })
          }
        }
        const waiting = this.rotatingBatch('waiting')
        if (!waiting.length || !await this.runtime.available()) return
        for (const [threadId, mark] of waiting) {
          if (this.stopped) break
          let state: ThreadState
          try { state = await this.runtime.inspect(threadId) }
          catch { continue }
          if (state.active) continue
          if (state.turnId !== mark.blockedTurnId || !isQuotaBlocked(state)) {
            await this.saveMark(threadId, { status: 'armed', blockedTurnId: mark.blockedTurnId, attemptId: null })
            continue
          }
          const attemptId = createDeliveryId()
          const submitted: QuotaResumeMark = { status: 'submitted', blockedTurnId: mark.blockedTurnId, attemptId, attemptedAt: Date.now() }
          await this.saveMark(threadId, submitted)
          try { await this.runtime.submit(threadId, attemptId) }
          catch (cause) {
            const status = (cause as { retryableQuota?: boolean })?.retryableQuota ? 'waiting' : 'unknown'
            await this.saveMark(threadId, {
              ...submitted,
              status,
              attemptId: status === 'waiting' ? null : attemptId,
              lastError: cause instanceof Error ? cause.message : '续跑提交失败，结果未确认',
            })
          }
          break
        }
      })
    } finally { this.ticking = false }
  }
  async close(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    await this.serial
  }
}
