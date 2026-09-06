type Rpc = (method: string, params: unknown) => Promise<unknown>
type Entry = { turnId?: string; dispatching: boolean }
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' ? value as Record<string, any> : {}

// Prevent concurrent manual requests from different tabs. Native history remains
// the authority for the outcome; this gate never retries a compaction itself.
export class ThreadCompactionGate {
  private pending = new Map<string, Entry>()
  constructor(private rpc: Rpc, private blocked: (threadId: string) => boolean | Promise<boolean> = () => false) {}

  observe(notification: { method: string; params: unknown }) {
    const params = record(notification.params)
    const current = this.pending.get(params.threadId)
    if (!current) return
    if (notification.method === 'item/started' && record(params.item).type === 'contextCompaction') {
      current.turnId = params.turnId
    }
    if (notification.method === 'turn/completed' && record(params.turn).id === current.turnId) this.pending.delete(params.threadId)
  }

  async start(threadId: string, repeatUnknown = false): Promise<unknown> {
    if (!threadId) throw new Error('缺少会话 ID')
    const previous = this.pending.get(threadId)
    if (previous?.dispatching) throw new Error('压缩请求正在提交，请先检查结果。')
    if (previous && !repeatUnknown) throw new Error('已有压缩请求，请先检查结果。')
    if (!previous && this.pending.size >= 100) throw new Error('待确认的压缩请求过多，请先检查已有请求。')
    const entry: Entry = { dispatching: true }
    this.pending.set(threadId, entry)
    let submitted = false
    try {
      if (await this.blocked(threadId)) throw new Error('账号操作或待发送队列尚未结束，请稍后压缩。')
      const metadata = record(await this.rpc('thread/read', { threadId, includeTurns: false }))
      const status = record(record(metadata.thread).status).type
      if (status !== 'idle' && status !== 'systemError') throw new Error('会话尚未空闲或未载入，请刷新会话后再压缩。')
      if (await this.blocked(threadId)) throw new Error('账号操作或待发送队列尚未结束，请稍后压缩。')
      submitted = true
      return await this.rpc('thread/compact/start', { threadId })
    } finally {
      entry.dispatching = false
      if (!submitted && this.pending.get(threadId) === entry) {
        if (previous) this.pending.set(threadId, previous)
        else this.pending.delete(threadId)
      }
    }
  }
}
