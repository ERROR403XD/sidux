import { createHash } from 'node:crypto'
import { opendir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { DeliveryMode, DeliveryReceipt, DeliveryRecord } from '../delivery.js'
import { normalizeStoredQueuedMessage, type StoredQueuedMessage, type ThreadQueueState } from '../threadQueue.js'
import { writeAutomationFileAtomic } from './automationDefinition.js'
import { AutomationStore } from './automationStore.js'

const ID_LIFETIME_MS = 7 * 86400000
const MAX_PENDING = 500
const MAX_PENDING_BYTES = 32 * 1024 * 1024
type State = { version: 2; migratedLegacy: boolean; records: DeliveryRecord[] }
type Submission = { threadId: string; message: StoredQueuedMessage; mode: DeliveryMode; contextId: string; params?: Record<string, unknown> }
type Edit = { text: string; imageUrls: string[]; skills: StoredQueuedMessage['skills']; fileAttachments: StoredQueuedMessage['fileAttachments'] }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}'
  }
  return JSON.stringify(value) ?? 'null'
}

function fingerprint(input: Submission): string {
  return createHash('sha256').update(canonical({ threadId: input.threadId, message: input.message, mode: input.mode, params: input.params })).digest('hex')
}

function validId(id: string): void {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error('无效的发送 ID')
}

function validateState(value: unknown): State {
  const state = value as State
  if (!state || state.version !== 2 || typeof state.migratedLegacy !== 'boolean' || !Array.isArray(state.records)) throw new Error('发送记录文件损坏，已停止投递')
  const ids = new Set<string>()
  for (const row of state.records) {
    if (!row || !normalizeStoredQueuedMessage(row.message) || typeof row.threadId !== 'string' || !row.threadId
      || !['queued', 'editing', 'sending', 'unknown', 'failed'].includes(row.status)
      || !['queue', 'immediate', 'steer'].includes(row.mode) || !Number.isInteger(row.revision) || row.revision < 1
      || !Number.isFinite(row.createdAt) || !Number.isFinite(row.updatedAt) || typeof row.contextId !== 'string'
      || !/^[a-f0-9]{64}$/.test(row.fingerprint) || ids.has(row.message.id)) throw new Error('发送记录内容无效，已停止投递')
    validId(row.message.id)
    ids.add(row.message.id)
  }
  return state
}

/** One CODEX_HOME writer; pending records and immutable receipts are published atomically. */
export class DeliveryStore {
  private readonly lease: AutomationStore
  private state: State | null = null
  private starting: Promise<void> | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private renewal: ReturnType<typeof setInterval> | null = null
  private failure = ''
  private disposed = false

  constructor(readonly directory: string, private readonly options: {
    now?: () => number
    readLegacy?: () => Promise<ThreadQueueState>
    clearLegacy?: () => Promise<void>
    previousRuntimeStopped?: Promise<void>
  } = {}) {
    this.lease = new AutomationStore(join(directory, 'writer'))
  }

  private now(): number { return this.options.now?.() ?? Date.now() }

  async init(): Promise<void> {
    if (this.disposed) throw new Error('发送服务已停止')
    if (this.failure) throw new Error(this.failure)
    if (this.state) return
    if (this.starting) return this.starting
    this.starting = (async () => {
      await this.options.previousRuntimeStopped
      if (this.disposed) throw new Error('发送服务已停止')
      if (!await this.lease.acquire(this.now())) throw new Error('另一个进程正在管理此 CODEX_HOME 的发送记录')
      try {
        let state: State
        try { state = validateState(JSON.parse(await readFile(join(this.directory, 'pending.json'), 'utf8'))) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          state = { version: 2, migratedLegacy: false, records: [] }
        }
        if (!state.migratedLegacy) {
          const legacy = await this.options.readLegacy?.() ?? {}
          for (const [threadId, rows] of Object.entries(legacy)) {
            for (const message of rows) {
              const imported = this.makeRecord({ threadId, message, mode: 'queue', contextId: '' })
              const existing = state.records.find(row => row.message.id === message.id)
              if (existing && existing.fingerprint !== imported.fingerprint) throw new Error('旧队列包含冲突的发送 ID，迁移已停止')
              if (!existing) state.records.push(imported)
            }
          }
          // On a crash between these writes, migration repeats with ID deduplication.
          await this.publish(state)
          await this.options.clearLegacy?.()
          state.migratedLegacy = true
        }
        const records: DeliveryRecord[] = []
        for (const row of state.records) {
          const receipt = await this.readReceipt(row.message.id)
          if (receipt) {
            if (receipt.fingerprint !== row.fingerprint || receipt.threadId !== row.threadId) throw new Error('发送确认记录与待发送内容冲突')
            continue
          }
          records.push(row.status === 'sending' ? { ...row, status: 'unknown', revision: row.revision + 1, updatedAt: this.now(), error: '服务曾在发送期间中断，需核对是否送达。' } : row)
        }
        state.records = records
        await this.publish(state)
        this.state = state
        if (this.disposed) throw new Error('发送服务已停止')
        this.renewal = setInterval(() => { void this.lease.renew().catch(() => { this.failure = '发送记录写入租约已失效，已停止投递' }) }, 30000)
        this.renewal.unref?.()
      } catch (error) {
        this.state = null
        await this.lease.release().catch(() => {})
        throw error
      }
    })().finally(() => { this.starting = null })
    return this.starting
  }

  private async publish(state: State): Promise<void> {
    await this.lease.assertOwnership()
    if (state.records.length > MAX_PENDING) throw new Error('尚未处理的发送记录超过 500 条，请先处理现有记录')
    const raw = JSON.stringify(state)
    if (Buffer.byteLength(raw) > MAX_PENDING_BYTES) throw new Error('尚未处理的发送内容超过 32 MB，请先处理现有记录')
    await writeAutomationFileAtomic(join(this.directory, 'pending.json'), raw)
  }

  private async serial<T>(action: (state: State) => Promise<T>): Promise<T> {
    const pending = this.chain.then(async () => {
      await this.init()
      await this.lease.assertOwnership()
      const state = structuredClone(this.state!)
      try {
        const result = await action(state)
        await this.publish(state)
        this.state = state
        return structuredClone(result)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code) this.failure = '发送记录保存失败，已停止投递；请检查存储后重启服务核对。'
        throw error
      }
    })
    this.chain = pending.catch(() => {})
    return pending
  }

  async records(threadId?: string): Promise<DeliveryRecord[]> {
    await this.init()
    await this.chain
    return structuredClone(this.state!.records.filter(row => !threadId || row.threadId === threadId))
  }

  async readReceipt(id: string): Promise<DeliveryReceipt | null> {
    validId(id)
    try {
      const receipt = JSON.parse(await readFile(join(this.directory, 'receipts', id + '.json'), 'utf8')) as DeliveryReceipt
      if (!receipt || receipt.id !== id || !['accepted', 'cancelled'].includes(receipt.status) || typeof receipt.threadId !== 'string'
        || !Number.isFinite(receipt.createdAt) || !Number.isFinite(receipt.updatedAt)
        || (receipt.status === 'accepted' && (typeof receipt.turnId !== 'string' || !receipt.turnId.trim()))
        || !/^[a-f0-9]{64}$/.test(receipt.fingerprint)) throw new Error('发送确认记录损坏，已停止投递')
      return receipt
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private makeRecord(input: Submission): DeliveryRecord {
    const normalized = normalizeStoredQueuedMessage(input.message)
    if (!normalized || !input.threadId.trim()) throw new Error('无效的发送内容')
    const { delivery: _clientState, ...message } = normalized
    if (!['queue', 'immediate', 'steer'].includes(input.mode)) throw new Error('无效的发送方式')
    validId(message.id)
    const now = this.now()
    return { ...input, message, fingerprint: fingerprint({ ...input, message }), status: 'queued', revision: 1, createdAt: now, updatedAt: now }
  }

  async add(input: Submission, beforeId?: string): Promise<DeliveryRecord | DeliveryReceipt> {
    return this.serial(async state => {
      const row = this.makeRecord(input)
      const existing = state.records.find(record => record.message.id === row.message.id) ?? await this.readReceipt(row.message.id)
      if (existing) {
        if (existing.threadId !== row.threadId || existing.fingerprint !== row.fingerprint) throw new Error('同一发送 ID 的内容已变化，请刷新状态')
        return existing
      }
      const timestamp = Number(row.message.id.match(/^[dq]-(\d{13})-/)?.[1])
      if (!Number.isFinite(timestamp) || timestamp > this.now() + 300000 || this.now() - timestamp > ID_LIFETIME_MS) throw new Error('发送 ID 已过期或无效，请先核对历史，不能自动重发')
      const before = state.records.findIndex(record => record.threadId === row.threadId && record.message.id === beforeId)
      state.records.splice(before < 0 ? state.records.length : before, 0, row)
      return row
    })
  }

  private pending(state: State, id: string, revision?: number): DeliveryRecord {
    const row = state.records.find(record => record.message.id === id)
    if (!row) throw new Error('该消息已送达或已被移除，请刷新状态')
    if (revision !== undefined && row.revision !== revision) throw new Error('消息状态已变化，请刷新后重试')
    return row
  }

  private update(row: DeliveryRecord, changes: Partial<DeliveryRecord>): DeliveryRecord {
    Object.assign(row, changes, { revision: row.revision + 1, updatedAt: this.now() })
    return row
  }

  async sending(id: string, revision: number, params: Record<string, unknown>, contextId: string): Promise<DeliveryRecord> {
    return this.serial(async state => {
      const row = this.pending(state, id, revision)
      if (row.status !== 'queued') throw new Error('该消息当前不能发送')
      if (row.contextId && row.contextId !== contextId) throw new Error('账号或供应方已变化，请核对后重新提交')
      return this.update(row, { status: 'sending', params, contextId, submittedAt: this.now(), error: undefined })
    })
  }

  async failed(id: string, revision: number, error: string): Promise<void> {
    await this.serial(async state => {
      const row = this.pending(state, id, revision)
      if (row.status === 'queued') this.update(row, { status: 'failed', error: error.slice(0, 2000) })
    })
  }

  async unknown(id: string, error: string): Promise<void> {
    await this.serial(async state => {
      const row = this.pending(state, id)
      if (row.status === 'sending' || row.status === 'unknown') this.update(row, { status: 'unknown', error: error.slice(0, 2000) })
    })
  }

  async rejectedBeforeSend(id: string, error: string): Promise<void> {
    await this.serial(async state => {
      const row = this.pending(state, id)
      if (row.status === 'sending') this.update(row, { status: 'failed', error: error.slice(0, 2000) })
    })
  }

  async confirm(id: string, turnId: string): Promise<DeliveryReceipt> {
    if (!turnId.trim()) throw new Error('缺少回合 ID，无法确认送达')
    return this.serial(async state => {
      const existing = await this.readReceipt(id)
      if (existing) {
        state.records = state.records.filter(record => record.message.id !== id)
        return existing
      }
      const row = this.pending(state, id)
      if (!['sending', 'unknown'].includes(row.status)) throw new Error('该消息尚未开始发送')
      const receipt: DeliveryReceipt = { id, threadId: row.threadId, fingerprint: row.fingerprint, status: 'accepted', turnId, createdAt: row.createdAt, updatedAt: this.now() }
      await writeAutomationFileAtomic(join(this.directory, 'receipts', id + '.json'), JSON.stringify(receipt))
      state.records = state.records.filter(record => record.message.id !== id)
      return receipt
    })
  }

  async edit(id: string, revision: number, token: string, contents?: Edit): Promise<DeliveryRecord> {
    return this.serial(async state => {
      const row = this.pending(state, id, revision)
      if (!token) throw new Error('缺少编辑标识')
      if (contents) {
        if (row.status !== 'editing' || row.editToken !== token) throw new Error('此消息的编辑状态已变化')
        const message = normalizeStoredQueuedMessage({ ...row.message, ...contents, id })!
        const next = { ...row, message, params: undefined }
        return this.update(row, { message, params: undefined, fingerprint: fingerprint(next), status: 'queued', error: undefined, editToken: undefined })
      }
      if (!['queued', 'failed'].includes(row.status)) throw new Error('该消息当前不能编辑')
      return this.update(row, { status: 'editing', editToken: token, error: undefined })
    })
  }

  async resume(id: string, revision: number): Promise<void> {
    await this.serial(async state => {
      const row = this.pending(state, id, revision)
      if (!['failed', 'editing'].includes(row.status)) throw new Error('结果不明的消息只能先核对，不能重新排队')
      this.update(row, { status: 'queued', error: undefined, editToken: undefined })
    })
  }

  async requestSteer(id: string, revision: number): Promise<void> {
    await this.serial(async state => {
      const row = this.pending(state, id, revision)
      if (row.status !== 'queued' || state.records.some(other => other.threadId === row.threadId && ['sending', 'unknown'].includes(other.status))) throw new Error('请先处理正在发送或等待确认的消息')
      const mode = 'steer' as const
      this.update(row, { mode, fingerprint: fingerprint({ ...row, mode }) })
    })
  }

  async remove(id: string, revision: number, abandon = false): Promise<StoredQueuedMessage> {
    return this.serial(async state => {
      const row = this.pending(state, id, revision)
      if (row.status === 'sending') throw new Error('正在发送，请等待结果后再操作')
      if (row.status === 'unknown' && !abandon) throw new Error('可能已经送达；停止跟踪不会中止已执行的任务')
      const receipt: DeliveryReceipt = { id, threadId: row.threadId, fingerprint: row.fingerprint, status: 'cancelled', createdAt: row.createdAt, updatedAt: this.now() }
      await writeAutomationFileAtomic(join(this.directory, 'receipts', id + '.json'), JSON.stringify(receipt))
      state.records = state.records.filter(record => record.message.id !== id)
      return row.message
    })
  }

  async move(id: string, revision: number, targetId: string): Promise<void> {
    await this.serial(async state => {
      const row = this.pending(state, id, revision)
      const target = this.pending(state, targetId)
      if (row.threadId !== target.threadId || row.status !== 'queued' || target.status !== 'queued') throw new Error('只能重排同一会话中的待发送消息')
      const from = state.records.indexOf(row)
      const to = state.records.indexOf(target)
      state.records.splice(from, 1)
      state.records.splice(to, 0, row)
      this.update(row, {})
    })
  }

  async pruneReceipts(): Promise<number> {
    await this.init()
    await this.lease.assertOwnership()
    let directory
    try { directory = await opendir(join(this.directory, 'receipts')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
    let removed = 0
    let visited = 0
    for await (const entry of directory) {
      if (this.disposed || this.failure) break
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const id = entry.name.slice(0, -5)
      const timestamp = Number(id.match(/^[dq]-(\d{13})-/)?.[1])
      if (Number.isFinite(timestamp) && this.now() - timestamp <= ID_LIFETIME_MS) continue
      const receipt = await this.readReceipt(id)
      if (receipt && this.now() - receipt.updatedAt > ID_LIFETIME_MS) {
        await this.lease.assertOwnership()
        await rm(join(this.directory, 'receipts', entry.name))
        removed += 1
      }
      if (++visited % 100 === 0) await new Promise<void>(resolve => setImmediate(resolve))
    }
    return removed
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.renewal) clearInterval(this.renewal)
    await this.starting?.catch(() => {})
    await this.chain
    await this.lease.release()
  }
}
