import { readThreadGoal, type ThreadGoal } from '../threadGoal.js'

// Native goal/get has no list equivalent. Query bounded batches after threads
// render; share results across tabs and invalidate them through native events.
export class ThreadGoalReader {
  private cache = new Map<string, { goal: ThreadGoal | null; at: number }>()
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private rpc: (method: string, params: unknown) => Promise<unknown>, private now = Date.now) {}
  observe(notification: { method: string; params: unknown }) {
    const params = notification.params as { threadId?: string; goal?: ThreadGoal }
    if (!params?.threadId) return
    if (notification.method === 'thread/goal/updated' && params.goal) {
      try { this.put(params.threadId, readThreadGoal(params.goal, params.threadId)) } catch { this.cache.delete(params.threadId) }
    }
    if (notification.method === 'thread/goal/cleared') this.put(params.threadId, null)
  }
  private put(id: string, goal: ThreadGoal | null) {
    this.cache.delete(id)
    this.cache.set(id, { goal, at: this.now() })
    if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value!)
  }
  snapshot(ids: string[], refreshId = ''): Promise<Record<string, ThreadGoal | null>> {
    if (ids.length > 100 || ids.some(id => typeof id !== 'string' || !id || id.length > 100)) return Promise.reject(new Error('每次最多读取 100 个会话目标'))
    const execute = async () => {
      const result: Record<string, ThreadGoal | null> = {}
      const unique = [...new Set(ids)]
      for (let offset = 0; offset < unique.length; offset += 4) {
        const reads = await Promise.allSettled(unique.slice(offset, offset + 4).map(async id => {
          const cached = this.cache.get(id)
          if (id !== refreshId && cached && this.now() - cached.at < 30000) { result[id] = cached.goal; return }
          const response = await this.rpc('thread/goal/get', { threadId: id }) as { goal: ThreadGoal | null }
          // A notification received while RPC was in flight is newer than its response.
          if (this.cache.get(id) === cached) this.put(id, readThreadGoal(response.goal, id))
          result[id] = this.cache.get(id)!.goal
        }))
        const failed = reads.find(result => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
      }
      return result
    }
    const next = this.queue.then(execute)
    this.queue = next.catch(() => {})
    return next
  }
}
