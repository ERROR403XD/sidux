import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { privateJson } from './apiProxy/store.js'

/** Per-turn UI acknowledgements for quota and other failures. The legacy filename stays compatible; no execution or scheduling changes. */
export class IgnoredQuotaErrors {
  private marks: Record<string, string[]> = Object.create(null)
  private ready: Promise<void>
  private writes: Promise<unknown> = Promise.resolve()
  private path: string

  constructor(home: string) {
    this.path = join(home, 'ignored-quota-errors.json')
    this.ready = readFile(this.path, 'utf8').then(raw => {
      const value = JSON.parse(raw)
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(ids => !Array.isArray(ids) || ids.some(id => typeof id !== 'string'))) throw new Error('忽略标记读取失败')
      this.marks = Object.assign(Object.create(null), value)
    }).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
    void this.ready.catch(() => {})
  }

  async list(threadId: string): Promise<string[]> {
    await this.ready
    return [...(this.marks[threadId] || [])]
  }

  async has(threadId: string, turnId: string): Promise<boolean> {
    await this.ready
    return this.marks[threadId]?.includes(turnId) || false
  }

  set(threadId: string, turnId: string, ignored: boolean): Promise<void> {
    const write = this.writes.then(async () => {
      await this.ready
      if (![threadId, turnId].every(id => /^[a-zA-Z0-9-]{1,200}$/.test(id))) throw new Error('会话或回合 ID 无效')
      const ids = new Set(this.marks[threadId] || [])
      if (ignored) ids.add(turnId)
      else ids.delete(turnId)
      const next = Object.assign(Object.create(null), this.marks)
      if (ids.size) next[threadId] = [...ids]
      else delete next[threadId]
      await privateJson(this.path, next)
      this.marks = next
    })
    this.writes = write.catch(() => {})
    return write
  }
}
