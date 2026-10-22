import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDeliveryId } from '../delivery.js'
import type { ScheduledResumeMark, ScheduledResumeChoice } from '../threadScheduledResume.js'
import { privateJson } from './apiProxy/store.js'
import { automaticResumeStartedMethod, type AutomaticResumeStarted } from '../threadAutomaticResume.js'

type Runtime = {
  prepare(threadId: string, choice?: ScheduledResumeChoice): Promise<{ choice: ScheduledResumeChoice; contextId: string }>
  submit(threadId: string, mark: ScheduledResumeMark): Promise<'submitted' | 'started'>
  inspect(threadId: string, mark: ScheduledResumeMark): Promise<{ status: 'submitted' | 'started' | 'unknown' | 'failed'; turnId?: string; error?: string }>
  cancel(attemptId: string): Promise<void>
  changed(): void
}

export class ThreadScheduledResume {
  private marks: Record<string, ScheduledResumeMark> = Object.create(null)
  private serial: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private draining = false
  private ticking = false
  private inspectionRequested = false
  private inspectionOffset = 0
  private readonly requestedInspections = new Set<string>()
  private storageFailure = false
  private readonly path: string
  readonly ready: Promise<void>

  constructor(home: string, private runtime: Runtime, private now = Date.now, private automatic = true, previousRuntimeStopped: Promise<void> = Promise.resolve()) {
    this.path = join(home, 'codexapp-scheduled-resume.json')
    const path = this.path
    this.ready = (async () => {
      await previousRuntimeStopped
      try {
        const data = JSON.parse(await readFile(path, 'utf8'))
        if (data.version !== 1 || !data.marks || Array.isArray(data.marks) || typeof data.marks !== 'object') throw new Error('定时续跑文件格式无效')
        if (Object.keys(data.marks).length > 1000) throw new Error('定时续跑文件格式无效')
        this.marks = Object.assign(Object.create(null), data.marks)
        for (const [threadId, mark] of Object.entries(this.marks)) {
          if (!/^[a-zA-Z0-9-]{1,128}$/.test(threadId) || !mark || !Number.isFinite(mark.at) || typeof mark.attemptId !== 'string'
            || (mark.status !== 'scheduled' && !mark.attemptId)
            || !['scheduled', 'submitted', 'unknown', 'failed'].includes(mark.status)
            || typeof mark.choice?.model !== 'string' || !mark.choice.model
            || typeof mark.choice.effort !== 'string' || typeof mark.choice.tier !== 'string'
            || !['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(mark.choice.effort)
            || typeof mark.contextId !== 'string' || !mark.contextId) throw new Error('定时续跑文件格式无效')
          if (mark.status === 'submitted') mark.status = 'unknown'
          if (mark.status === 'failed') this.requestedInspections.add(threadId)
        }
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
      }
      this.schedule()
    })()
    void this.ready.catch(() => {})
  }

  private operation<T>(work: () => Promise<T>): Promise<T> {
    const next = this.serial.then(async () => {
      await this.ready
      if (this.stopped) throw new Error('定时续跑服务已停止')
      if (this.storageFailure) throw new Error('定时续跑状态保存失败，请检查存储并重启服务。')
      return work()
    })
    this.serial = next.catch(() => {})
    return next
  }

  private async save(threadId: string, mark?: ScheduledResumeMark): Promise<void> {
    const next = { ...this.marks }
    if (mark) {
      next[threadId] = mark
      if (mark.status === 'scheduled') this.requestedInspections.delete(threadId)
    } else {
      delete next[threadId]
      this.requestedInspections.delete(threadId)
    }
    try { await privateJson(this.path, { version: 1, marks: next }) }
    catch (cause) {
      this.storageFailure = true
      clearTimeout(this.timer)
      throw cause
    }
    this.marks = next
    try { this.runtime.changed() } catch { /* Durable state remains authoritative. */ }
    this.schedule()
  }

  private schedule(delay?: number): void {
    clearTimeout(this.timer)
    if (!this.automatic || this.stopped || this.draining || this.storageFailure) return
    const marks = Object.entries(this.marks).filter(([threadId, mark]) => mark.status !== 'failed' || this.requestedInspections.has(threadId))
    if (!marks.length) return
    const wait = delay ?? Math.min(...marks.map(([threadId, mark]) => {
      if (this.requestedInspections.has(threadId)) return 0
      return mark.status === 'scheduled' ? Math.max(0, mark.at - this.now()) : 5000
    }))
    this.timer = setTimeout(() => { void this.tick().catch(() => {}) }, Math.min(2_147_483_647, wait))
    this.timer.unref()
  }

  async snapshot(): Promise<Record<string, ScheduledResumeMark>> {
    await this.ready
    if (this.storageFailure) throw new Error('定时续跑状态保存失败，请检查存储并重启服务。')
    return structuredClone(this.marks)
  }

  async has(threadId: string): Promise<boolean> {
    await this.ready
    if (this.storageFailure) throw new Error('定时续跑状态保存失败，请检查存储并重启服务。')
    return Object.hasOwn(this.marks, threadId)
  }

  set(threadId: string, at: number | null, choice?: ScheduledResumeChoice): Promise<void> {
    return this.operation(async () => {
      if (this.draining && at !== null) throw new Error('运行时正在交接，请稍后设置续跑。')
      if (!/^[a-zA-Z0-9-]{1,128}$/.test(threadId)) throw new Error('会话ID无效')
      if (at !== null && (!Number.isFinite(at) || at <= this.now())) throw new Error('请选择未来的续跑时间')
      const previous = this.marks[threadId]
      if (previous && ['submitted', 'unknown'].includes(previous.status) && at !== null) throw new Error('续跑已提交，请先核对或取消原标记。')
      if (at === null) {
        if (previous?.attemptId) await this.runtime.cancel(previous.attemptId)
        await this.save(threadId)
        return
      }
      if (!previous && Object.keys(this.marks).length >= 1000) throw new Error('定时续跑数量已达上限')
      const settings = await this.runtime.prepare(threadId, choice)
      if (this.stopped) return
      await this.save(threadId, { at, status: 'scheduled', attemptId: '', ...settings })
    })
  }

  async tick(): Promise<void> {
    if (this.stopped || this.draining || this.ticking) return
    this.ticking = true
    this.inspectionRequested = false
    try {
      await this.operation(async () => {
        const rows = Object.entries(this.marks).filter(([threadId, mark]) => mark.status === 'failed'
          ? this.requestedInspections.has(threadId)
          : mark.status !== 'scheduled' || mark.at <= this.now())
        const count = Math.min(4, rows.length)
        for (let index = 0; index < count; index++) {
          if (this.stopped || this.draining) break
          const [threadId, mark] = rows[(this.inspectionOffset + index) % rows.length]!
          if (mark.status === 'scheduled') {
            // Only an unclaimed schedule receives a fresh ID. Recovery keeps the claimed ID.
            const claimed = { ...mark, status: 'submitted' as const, attemptId: createDeliveryId(), attemptedAt: this.now() }
            await this.save(threadId, claimed)
            if (this.stopped || this.draining) break
            let result: 'submitted' | 'started'
            try { result = await this.runtime.submit(threadId, claimed) }
            catch (cause) {
              await this.save(threadId, { ...claimed, status: 'unknown', error: cause instanceof Error ? cause.message : String(cause) })
              continue
            }
            if (result === 'started') await this.save(threadId)
          } else {
            // Failed marks are read once on recovery or a relevant event, never redispatched.
            this.requestedInspections.delete(threadId)
            const result = await this.runtime.inspect(threadId, mark).catch(() => null)
            if (this.stopped || !result) continue
            if (result.status === 'started') await this.save(threadId)
            else if (result.status !== mark.status || result.turnId !== mark.turnId || result.error !== mark.error) {
              await this.save(threadId, { ...mark, ...result, error: result.error, status: result.status as ScheduledResumeMark['status'] })
            }
          }
        }
        this.inspectionOffset = rows.length ? (this.inspectionOffset + count) % rows.length : 0
      })
    } finally {
      this.ticking = false
      this.schedule(this.inspectionRequested ? 0 : undefined)
    }
  }

  observe(notification: { method: string; params: unknown }): void {
    if (this.stopped || this.storageFailure) return
    const params = notification.params as Partial<AutomaticResumeStarted> | null
    if (notification.method !== automaticResumeStartedMethod || params?.source !== 'scheduled'
      || typeof params.threadId !== 'string' || !params.deliveryId) return
    const mark = this.marks[params.threadId]
    if (!mark || mark.status === 'scheduled' || mark.attemptId !== params.deliveryId) return
    this.requestedInspections.add(params.threadId)
    this.inspectionRequested = true
    this.schedule(0)
  }

  async drain(value = true): Promise<void> {
    this.draining = value
    clearTimeout(this.timer)
    await this.serial
    this.schedule()
  }

  async close(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    await this.serial
  }
}
