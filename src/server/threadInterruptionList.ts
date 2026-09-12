import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { privateJson } from './apiProxy/store.js'
import { classifyThreadInterruption, type ThreadInterruption, type ThreadInterruptionSnapshot } from '../threadInterruption.js'
import type { IgnoredQuotaErrors } from './ignoredQuotaErrors.js'

/** Unhandled problems in the UI. No account, turn, quota or delivery operations. */
export class ThreadInterruptionList {
  private entries: ThreadInterruptionSnapshot = Object.create(null)
  private errors = new Map<string, { turnId: string; error: unknown }>()
  private turns = new Map<string, string>()
  private ready: Promise<void>
  private writes: Promise<unknown> = Promise.resolve()
  private path: string

  constructor(home: string, private ignored: IgnoredQuotaErrors, private changed: (threadId: string, issues: ThreadInterruption[]) => void = () => {}) {
    this.path = join(home, 'codexapp-thread-interruptions-v1.json')
    this.ready = readFile(this.path, 'utf8').then(raw => {
      const value = JSON.parse(raw)
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.values(value).some(issues => !Array.isArray(issues) || issues.some(issue => !issue || typeof issue.turnId !== 'string' || !['error', 'quota'].includes(issue.kind)))) throw new Error('会话问题记录读取失败')
      this.entries = Object.assign(Object.create(null), value)
    }).catch(error => { if (error.code !== 'ENOENT') throw error })
    void this.ready.catch(() => {})
  }

  private async visible(threadId: string): Promise<ThreadInterruption[]> {
    const ignored = new Set(await this.ignored.list(threadId))
    return (this.entries[threadId] || []).filter(issue => !ignored.has(issue.turnId)).map(issue => ({ ...issue }))
  }

  async snapshot(): Promise<ThreadInterruptionSnapshot> {
    await this.ready
    await this.writes
    const next: ThreadInterruptionSnapshot = Object.create(null)
    for (const id of Object.keys(this.entries)) {
      const issues = await this.visible(id)
      if (issues.length) next[id] = issues
    }
    return next
  }

  async publish(threadId: string): Promise<void> {
    await this.ready
    await this.writes
    this.changed(threadId, await this.visible(threadId))
  }

  record(threadId: string, turn: { id?: string; status?: string; error?: unknown }): Promise<void> {
    const kind = classifyThreadInterruption(turn)
    const turnId = turn.id
    if (!kind || !threadId || !turnId) return Promise.resolve()
    const write = this.writes.then(async () => {
      await this.ready
      const current = this.entries[threadId] || []
      const previous = current.find(issue => issue.turnId === turnId)
      if (previous && (previous.kind === kind || previous.kind === 'quota')) return
      const next = Object.assign(Object.create(null), this.entries, { [threadId]: [...current.filter(issue => issue.turnId !== turnId), { turnId, kind }] })
      await privateJson(this.path, next)
      this.entries = next
      this.changed(threadId, await this.visible(threadId))
    })
    this.writes = write.catch(() => {})
    return write
  }

  observe(method: string, value: unknown): Promise<void> {
    if (!value || typeof value !== 'object') return Promise.resolve()
    const params = value as { threadId?: string; thread_id?: string; turnId?: string; error?: unknown; willRetry?: boolean; status?: string | { type?: string }; turn?: { id?: string; status?: string; error?: unknown } }
    const id = params.threadId || params.thread_id || ''
    if (!id) return Promise.resolve()
    if (method === 'turn/started') {
      this.errors.delete(id)
      const turnId = params.turn?.id || params.turnId
      if (turnId) this.turns.set(id, turnId)
      if (this.turns.size > 2048) this.turns.delete(this.turns.keys().next().value!)
    }
    if (method === 'error') {
      const kind = classifyThreadInterruption({ status: 'failed', error: params.error })
      if (params.error && (params.willRetry !== true || kind === 'quota')) {
        this.errors.set(id, { turnId: params.turnId || '', error: params.error })
        // Only live errors need correlation; durable terminal records are separate.
        if (this.errors.size > 2048) this.errors.delete(this.errors.keys().next().value!)
      }
    }
    if (method === 'thread/status/changed' && (typeof params.status === 'string' ? params.status : params.status?.type) === 'systemError') {
      const earlier = this.errors.get(id)
      const turnId = this.turns.get(id) || earlier?.turnId
      if (turnId) return this.record(id, { id: turnId, status: 'failed', error: earlier && (!earlier.turnId || earlier.turnId === turnId) ? earlier.error : undefined })
    }
    if (method !== 'turn/completed' && method !== 'turn/cancelled') return Promise.resolve()
    const turn = { ...params.turn, id: params.turn?.id || params.turnId, status: params.turn?.status || (method === 'turn/cancelled' ? 'interrupted' : undefined) }
    const earlier = this.errors.get(id)
    if (turn.status !== 'completed' && !turn.error && earlier && (!earlier.turnId || earlier.turnId === turn.id)) turn.error = earlier.error
    this.errors.delete(id)
    if (this.turns.get(id) === turn.id) this.turns.delete(id)
    return this.record(id, turn)
  }
}
