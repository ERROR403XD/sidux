import { readBackgroundTerminal, type BackgroundTerminal } from '../processActivity.js'

/** Only loaded threads can own live commands. Presence is enough to block an identity change. */
export async function threadsWithBackgroundTerminals(rpc: (method: string, params: unknown) => Promise<unknown>): Promise<string[]> {
  const deadline = Date.now() + 30000
  async function read(method: string, params: unknown) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('后台终端核对超时，请稍后重试')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const response = await Promise.race([
        rpc(method, params),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('后台终端核对超时，请稍后重试')), remaining) }),
      ]) as { data?: unknown[]; nextCursor?: string | null }
      if (!Array.isArray(response?.data)) throw new Error('后台终端核对响应无效')
      return response as { data: unknown[]; nextCursor?: string | null }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  const ids = new Set<string>()
  const cursors = new Set<string>()
  let cursor: string | null = null
  do {
    const page = await read('thread/loaded/list', { limit: 100, cursor })
    if (page.data.length > 100 || page.data.some(id => typeof id !== 'string' || !id || id.length > 200)) throw new Error('已加载会话列表无效')
    for (const id of page.data) ids.add(id as string)
    cursor = page.nextCursor || null
    if (cursor && (typeof cursor !== 'string' || cursors.has(cursor))) throw new Error('已加载会话分页未前进')
    if (cursor) cursors.add(cursor)
    if (ids.size > 200 || (cursor && cursors.size >= 2)) throw new Error('已加载会话超过核对范围，请先处理后台任务')
  } while (cursor)
  const threads = [...ids]
  const active: string[] = []
  let next = 0
  const reads = await Promise.allSettled(Array.from({ length: Math.min(4, threads.length) }, async () => {
    while (next < threads.length) {
      const threadId = threads[next++]!
      const page = await read('thread/backgroundTerminals/list', { threadId, limit: 1 })
      if (page.data.length > 1 || (!page.data.length && page.nextCursor)) throw new Error('后台终端列表无效')
      if (page.data.length) active.push(threadId)
    }
  }))
  const failed = reads.find(row => row.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
  return active
}

export class BackgroundTerminalReader {
  private pending = new Map<string, Promise<BackgroundTerminal[]>>()
  private stopping = new Set<string>()

  constructor(private rpc: (method: string, params: unknown) => Promise<unknown>, private identityChanging = () => false) {}

  private async read(threadId: string): Promise<BackgroundTerminal[]> {
    const rows = new Map<string, BackgroundTerminal>()
    const cursors = new Set<string>()
    let cursor: string | null = null
    for (let page = 0; page < 10; page++) {
      const result = await this.rpc('thread/backgroundTerminals/list', { threadId, limit: 20, cursor }) as { data?: unknown[]; nextCursor?: string | null }
      if (!Array.isArray(result?.data) || result.data.length > 20) throw new Error('后台终端分页响应无效')
      for (const item of result.data) {
        const row = readBackgroundTerminal(item)
        rows.set(row.processId, row)
      }
      if (!result.nextCursor) return [...rows.values()]
      if (typeof result.nextCursor !== 'string' || cursors.has(result.nextCursor)) throw new Error('后台终端分页未前进，请重试')
      cursor = result.nextCursor
      cursors.add(cursor)
    }
    throw new Error('后台终端超过 200 项，当前无法完整核对列表')
  }

  list(threadId: string): Promise<BackgroundTerminal[]> {
    const previous = this.pending.get(threadId)
    if (previous) return previous
    if (this.pending.size >= 20) return Promise.reject(new Error('后台终端查询繁忙，请稍后重试'))
    const task = this.read(threadId).finally(() => { if (this.pending.get(threadId) === task) this.pending.delete(threadId) })
    this.pending.set(threadId, task)
    return task
  }

  async terminate(threadId: string, processId: string, itemId: string): Promise<{ terminated: boolean; absent: boolean }> {
    const key = JSON.stringify([threadId, processId])
    if (this.stopping.has(key) || this.stopping.size >= 20) throw new Error('停止操作正在处理，请先刷新状态')
    this.stopping.add(key)
    try {
      if (this.identityChanging()) throw new Error('账号或供应方正在切换，请稍后重试')
      const row = (await this.read(threadId)).find(row => row.processId === processId)
      if (!row) return { terminated: false, absent: true }
      if (row.itemId !== itemId) throw new Error('进程已对应另一条命令，请刷新后重新选择')
      if (this.identityChanging()) throw new Error('账号或供应方正在切换，请稍后重试')
      const response = await this.rpc('thread/backgroundTerminals/terminate', { threadId, processId }) as { terminated?: boolean }
      if (typeof response?.terminated !== 'boolean') throw new Error('停止结果无法确认，请刷新状态')
      return { terminated: response.terminated, absent: false }
    } finally {
      this.stopping.delete(key)
    }
  }
}
