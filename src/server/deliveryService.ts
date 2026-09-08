import type { DeliveryReceipt, DeliveryRecord } from '../delivery.js'
import { DeliveryStore } from './deliveryStore.js'

type Submission = Parameters<DeliveryStore['add']>[0]
type Result = DeliveryRecord | DeliveryReceipt | null
type Notification = { method: string; params: unknown }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}

/** Delivery IDs correlate native evidence; only the local durable claim controls replay. */
export class DeliveryService {
  private readonly active = new Map<string, Promise<void>>()
  private readonly checking = new Map<string, Promise<Result>>()
  private disposed = false

  constructor(readonly store: DeliveryStore, private readonly dependencies: {
    accountBusy: () => boolean
    submissionBlocked?: () => boolean
    context: () => Promise<string>
    canStart: (threadId: string) => Promise<boolean>
    prepare: (delivery: DeliveryRecord) => Promise<Record<string, unknown>>
    start: (params: Record<string, unknown>) => Promise<{ turnId: string }>
    inspect: (delivery: DeliveryRecord) => Promise<{ turnId?: string }>
    changed: (threadId: string) => void
  }) {}

  private changed(threadId: string): void {
    try { this.dependencies.changed(threadId) } catch { /* Clients can also refresh persisted state. */ }
  }

  async result(id: string): Promise<Result> {
    return await this.store.readReceipt(id) ?? (await this.store.records()).find(row => row.message.id === id) ?? null
  }

  async submit(input: Omit<Submission, 'contextId'> & { expectedContextId?: string }, beforeId?: string): Promise<Result> {
    if (this.disposed || (this.dependencies.submissionBlocked?.() ?? this.dependencies.accountBusy())) throw new Error('账号操作期间暂不能提交消息')
    const { expectedContextId, ...submission } = input
    const contextId = expectedContextId || await this.dependencies.context()
    const row = await this.store.add({ ...submission, contextId }, beforeId)
    this.changed(input.threadId)
    if (!('message' in row)) return row
    if (row.status === 'unknown') return this.reconcile(row.message.id)
    if (row.status === 'queued' && row.mode !== 'queue') await this.process(row.threadId, row.mode === 'steer' ? row.message.id : undefined)
    return this.result(row.message.id)
  }

  async process(threadId: string, steerId?: string): Promise<void> {
    const existing = this.active.get(threadId)
    if (existing) return existing
    if (this.disposed || this.active.size + this.checking.size >= 4 || this.dependencies.accountBusy()) return
    const work = this.dispatch(threadId, steerId).finally(() => { this.active.delete(threadId) })
    this.active.set(threadId, work)
    return work
  }

  private async dispatch(threadId: string, steerId?: string): Promise<void> {
    const rows = await this.store.records(threadId)
    if (rows.some(row => row.status === 'sending' || row.status === 'unknown')) return
    const row = steerId ? rows.find(row => row.message.id === steerId) : rows[0]
    if (!row || row.status !== 'queued') return
    let sending: DeliveryRecord
    try {
      if (row.mode !== 'steer' && !await this.dependencies.canStart(threadId)) return
      if (this.disposed || this.dependencies.accountBusy()) return
      const params = { ...await this.dependencies.prepare(row), clientUserMessageId: row.message.id }
      const contextId = await this.dependencies.context()
      if (this.disposed || this.dependencies.accountBusy()) return
      sending = await this.store.sending(row.message.id, row.revision, params, contextId)
    } catch (cause) {
      // A stale edit/delete must not be overwritten by a preparation failure.
      await this.store.failed(row.message.id, row.revision, cause instanceof Error ? cause.message : '发送准备失败').catch(() => {})
      this.changed(threadId)
      return
    }
    this.changed(threadId)
    try {
      const result = await this.dependencies.start(sending.params!)
      await this.store.confirm(row.message.id, result.turnId)
    } catch (cause) {
      const receipt = await this.store.readReceipt(row.message.id)
      if (!receipt) {
        if ((cause as { submissionNotSent?: boolean })?.submissionNotSent) {
          await this.store.rejectedBeforeSend(row.message.id, cause instanceof Error ? cause.message : '发送前已拒绝')
        } else {
          await this.store.unknown(row.message.id, cause instanceof Error ? cause.message : '未收到发送结果')
          await this.reconcile(row.message.id)
        }
      }
    }
    this.changed(threadId)
  }

  async reconcile(id: string): Promise<Result> {
    const previous = this.checking.get(id)
    if (previous) return previous
    const current = await this.result(id)
    if (!current || !('message' in current) || !['sending', 'unknown'].includes(current.status)) return current
    const concurrent = this.checking.get(id)
    if (concurrent) return concurrent
    if (this.disposed || this.active.size + this.checking.size >= 4 || this.dependencies.accountBusy()) return current
    const check = (async () => {
      try {
        const evidence = await this.dependencies.inspect(current)
        if (evidence.turnId) await this.store.confirm(id, evidence.turnId)
      } catch {
        // A failed or bounded lookup is not evidence that the submission was rejected.
      }
      this.changed(current.threadId)
      return this.result(id)
    })().finally(() => { this.checking.delete(id) })
    this.checking.set(id, check)
    return check
  }

  async observe(notification: Notification): Promise<void> {
    if (!['item/started', 'item/completed'].includes(notification.method)) return
    const params = record(notification.params)
    const item = record(params.item)
    if (item.type !== 'userMessage' || typeof item.clientId !== 'string' || typeof params.turnId !== 'string') return
    const current = await this.result(item.clientId)
    if (!current || !('message' in current) || current.threadId !== params.threadId || !['sending', 'unknown'].includes(current.status)) return
    await this.store.confirm(item.clientId, params.turnId)
    this.changed(current.threadId)
  }

  async steer(id: string, revision: number): Promise<Result> {
    if (this.disposed || this.dependencies.accountBusy()) throw new Error('账号操作期间暂不能引导消息')
    const current = await this.result(id)
    if (!current) throw new Error('找不到该消息，请刷新状态')
    if (!('message' in current)) return current
    await this.store.requestSteer(id, revision)
    this.changed(current.threadId)
    await this.process(current.threadId, id)
    return this.result(id)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.allSettled(this.active.values())
    await Promise.allSettled(this.checking.values())
    await this.store.dispose()
  }
}
