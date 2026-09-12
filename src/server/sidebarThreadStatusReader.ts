import { classifyThreadInterruption } from '../threadInterruption.js'

type Rpc = (method: string, params: Record<string, unknown>) => Promise<unknown>
type Entry = { at: number; interrupted: boolean; version: string }

/** Read-only metadata, on demand; never uses the task admission queue. */
export class SidebarThreadStatusReader {
  private cache = new Map<string, Entry>()
  private pending = new Map<string, Promise<boolean | null>>()
  private pendingVersions = new Map<string, string>()
  private revisions = new Map<string, number>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private rpc: Rpc, private now = Date.now, private timeoutMs = 8000, private ignored: (threadId: string, turnId: string) => Promise<boolean> = async () => false) {}

  invalidate(id: string): void {
    this.cache.delete(id)
    if (this.revisions.has(id)) this.revisions.set(id, this.revisions.get(id)! + 1)
  }

  private async read(id: string, version: string): Promise<boolean | null> {
    const cached = this.cache.get(id)
    if (cached && cached.version === version && this.now() - cached.at < 30_000) return cached.interrupted
    let work = this.pending.get(id)
    if (work && this.pendingVersions.get(id) !== version) this.invalidate(id)
    if (!work) {
      // A timeout ends the caller's wait, not the native RPC. Keep its slot
      // until settlement so repeated UI requests cannot create unbounded work.
      if (this.pending.size >= 4) return null
      this.revisions.set(id, 0)
      this.pendingVersions.set(id, version)
      work = Promise.resolve().then(async () => {
        const response = await this.rpc('thread/turns/list', {
          threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded',
        }) as { data?: unknown[] }
        if (!Array.isArray(response.data) || response.data.length > 1) throw new Error('Invalid final turn metadata')
        const turn = response.data[0] as { id?: string; status?: string } | undefined
        if (turn && (!turn.id || !['inProgress', 'completed', 'failed', 'interrupted'].includes(turn.status || ''))) throw new Error('Unknown final turn status')
        const interrupted = Boolean(classifyThreadInterruption(turn)) && !(await this.ignored(id, turn!.id!))
        if (this.revisions.get(id) !== 0) return null
        this.cache.delete(id)
        this.cache.set(id, { at: this.now(), interrupted, version })
        if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value!)
        return interrupted
      }).catch(error => {
        if (this.revisions.get(id) === 0 && /not materialized yet.*before first user message/i.test(String(error?.message))) return false
        return null
      }).finally(() => {
        this.pending.delete(id)
        this.pendingVersions.delete(id)
        this.revisions.delete(id)
      })
      this.pending.set(id, work)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([work, new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), this.timeoutMs)
      })])
    } finally {
      clearTimeout(timer)
    }
  }

  snapshot(ids: string[], versions: Record<string, string> = {}): Promise<Record<string, boolean | null>> {
    if (ids.length > 100 || ids.some(id => typeof id !== 'string' || !id || id.length > 200)) {
      return Promise.reject(new Error('每次最多读取 100 个会话状态'))
    }
    const execute = async () => {
      const result: Record<string, boolean | null> = Object.create(null)
      const unique = [...new Set(ids)]
      for (let offset = 0; offset < unique.length; offset += 4) {
        await Promise.all(unique.slice(offset, offset + 4).map(async id => {
          result[id] = await this.read(id, versions[id] || '')
        }))
      }
      return result
    }
    const next = this.queue.then(execute)
    this.queue = next.catch(() => {})
    return next
  }
}
