import { randomUUID } from 'node:crypto'
import { ProxyError } from './store.js'

export type Activity = {
  id: string
  storageId?: string
  keyId: string
  transport: 'http' | 'sse' | 'ws'
  busy: boolean
  startedAt: string
  model: string | null
  status: string
  abort: () => void
}
export class ProxyActivity {
  draining = false
  readonly entries = new Map<string, Activity>()
  readonly recent: Omit<Activity, 'abort' | 'busy'>[] = []
  snapshot() {
    return {
      draining: this.draining,
      activeRequests: [...this.entries.values()].filter(entry => entry.busy).length,
      connections: this.entries.size,
      idleWebSockets: [...this.entries.values()].filter(entry => entry.transport === 'ws' && !entry.busy).length,
      entries: [...this.entries.values()].map(({ abort: _abort, ...entry }) => entry),
      recent: this.recent.slice(0, 100),
    }
  }
  admit(keyId: string, transport: Activity['transport'], limits: { globalConcurrency: number; keyConcurrency: number }): Activity {
    if (this.draining) throw new ProxyError('draining', '出口正在等待活动请求结束，请稍后重试。', 503)
    if (this.entries.size >= 128 || [...this.entries.values()].filter(entry => entry.keyId === keyId).length >= 32) {
      throw new ProxyError('connection_limit', '连接数已达上限。', 429)
    }
    const entry: Activity = { id: randomUUID(), keyId, transport, busy: false, startedAt: new Date().toISOString(), model: null, status: 'preparing', abort: () => undefined }
    this.begin(entry, limits)
    this.entries.set(entry.id, entry)
    return entry
  }
  begin(entry: Activity, limits: { globalConcurrency: number; keyConcurrency: number }): void {
    if (this.draining) throw new ProxyError('draining', '出口正在等待活动请求结束。', 503)
    const active = [...this.entries.values()].filter(item => item.busy && item.id !== entry.id)
    if (active.length >= limits.globalConcurrency || active.filter(item => item.keyId === entry.keyId).length >= limits.keyConcurrency) {
      throw new ProxyError('concurrency_limit', '并发请求已达上限。', 429)
    }
    entry.busy = true
    entry.status = 'running'
  }
  finish(id: string, status = 'closed'): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    const { abort: _abort, busy: _busy, ...row } = entry
    this.recent.unshift({ ...row, status })
    while (this.recent.length > 500 || (this.recent.at(-1) && Date.now() - Date.parse(this.recent.at(-1)!.startedAt) > 7 * 86400_000)) this.recent.pop()
  }
  abortKey(keyId: string): void {
    for (const entry of this.entries.values()) if (entry.keyId === keyId) entry.abort()
  }
  async drainMatching(matches: (entry: Activity) => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    const closing = new Set<string>()
    while ([...this.entries.values()].some(matches)) {
      for (const entry of this.entries.values()) {
        if (matches(entry) && !entry.busy && !closing.has(entry.id)) {
          closing.add(entry.id)
          entry.abort()
        }
      }
      if (![...this.entries.values()].some(matches)) return
      if (Date.now() >= deadline) throw new ProxyError('drain_timeout', '所选账号仍有活动请求，已保留原路由。', 409)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  async drain(timeoutMs: number, force = false): Promise<void> {
    this.draining = true
    const deadline = Date.now() + timeoutMs
    const closing = new Set<string>()
    try {
      for (;;) {
        for (const entry of this.entries.values()) {
          if ((force || !entry.busy) && !closing.has(entry.id)) {
            closing.add(entry.id)
            entry.abort()
          }
        }
        if (this.entries.size === 0) return
        if (Date.now() >= deadline) throw new ProxyError('drain_timeout', '仍有活动请求，已保留原路由并恢复接入。', 409)
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    } catch (error) {
      this.draining = false
      throw error
    }
  }
}
