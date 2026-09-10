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

// The delivery ledger owns submission deduplication; this file only owns intent.
export class ThreadQuotaResume {
  private marks: Record<string, QuotaResumeMark> = {}
  private serial: Promise<unknown> = Promise.resolve()
  private ticking = false
  private stopped = false
  private inspectionOffset = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly path: string
  readonly ready: Promise<void>
  constructor(home: string, private runtime: Runtime, automatic = true) {
    this.path = join(home, 'codexapp-quota-resume.json')
    const path = this.path
    this.ready = (async () => {
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
  private async save(): Promise<void> {
    await privateJson(this.path, { version: 1, marks: this.marks })
    this.runtime.changed()
  }
  private operation<T>(run: () => Promise<T>): Promise<T> {
    const next = this.serial.then(async () => { await this.ready; return run() })
    this.serial = next.catch(() => undefined)
    return next
  }
  async snapshot(): Promise<Record<string, QuotaResumeMark>> {
    await this.ready
    return structuredClone(this.marks)
  }
  set(threadId: string, enabled: boolean): Promise<void> {
    return this.operation(async () => {
      if (!/^[a-zA-Z0-9-]{1,128}$/.test(threadId)) throw new Error('会话ID无效')
      if (!enabled) {
        const attempt = this.marks[threadId]?.attemptId
        if (attempt) await this.runtime.cancel(attempt)
        delete this.marks[threadId]
      } else if (!this.marks[threadId]) {
        if (Object.keys(this.marks).length >= 1000) throw new Error('续跑标记数量已达上限')
        const state = await this.runtime.inspect(threadId)
        this.marks[threadId] = { status: !state.active && ['failed', 'interrupted'].includes(state.status) ? 'waiting' : 'armed', blockedTurnId: state.turnId, attemptId: null }
      }
      await this.save()
    })
  }
  blocked(threadId: string, turnId: string | null): Promise<void> {
    return this.operation(async () => {
      const mark = this.marks[threadId]
      if (!mark) return
      mark.status = 'waiting'
      mark.blockedTurnId = turnId
      mark.attemptId = null
      delete mark.lastError
      await this.save()
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
        mark.status = 'armed'
        mark.attemptId = null
        await this.save()
      }).catch(() => undefined)
    }
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
          try {
            const state = await this.runtime.inspect(threadId)
            if (state.active) continue
            if (['failed', 'interrupted'].includes(state.status) && isQuotaFailure(state.error)
              && (mark.status === 'armed' || state.turnId !== mark.blockedTurnId)) {
              mark.status = 'waiting'
              mark.blockedTurnId = state.turnId
              mark.attemptId = null
              await this.save()
            } else if (mark.status === 'submitted' && state.status === 'completed') {
              mark.status = 'armed'
              mark.attemptId = null
              await this.save()
            }
          } catch { /* One unreadable thread must not stop other continuations. */ }
        }
        if (candidates.length) this.inspectionOffset = (this.inspectionOffset + count) % candidates.length
        for (const [threadId, mark] of Object.entries(this.marks).filter(([, mark]) => mark.status === 'unknown').slice(0, 8)) {
          if (!mark.attemptId || !this.runtime.reconcile) continue
          let status: 'waiting' | 'submitted' | 'unknown'
          try { status = await this.runtime.reconcile(threadId, mark.attemptId, mark.attemptedAt) }
          catch { continue }
          if (status !== mark.status) {
            mark.status = status
            if (status === 'waiting') mark.attemptId = null
            await this.save()
          }
        }
        const waiting = Object.entries(this.marks).filter(([, mark]) => mark.status === 'waiting').slice(0, 8)
        if (!waiting.length || !await this.runtime.available()) return
        for (const [threadId, mark] of waiting) {
          if (this.stopped) break
          let state: ThreadState
          try { state = await this.runtime.inspect(threadId) }
          catch { continue }
          if (state.active) continue
          if (state.turnId !== mark.blockedTurnId && state.status === 'completed') {
            mark.status = 'armed'
            await this.save()
            continue
          }
          mark.status = 'submitted'
          mark.attemptId = createDeliveryId()
          mark.attemptedAt = Date.now()
          delete mark.lastError
          await this.save()
          try { await this.runtime.submit(threadId, mark.attemptId) }
          catch (cause) {
            mark.lastError = cause instanceof Error ? cause.message : '续跑提交失败，结果未确认'
            mark.status = (cause as { retryableQuota?: boolean })?.retryableQuota ? 'waiting' : 'unknown'
            if (mark.status === 'waiting') mark.attemptId = null
            await this.save()
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
