import { compactMcpStatus, readDirectoryPages, type DirectoryMcpSnapshot } from '../directory.js'

/** Share only pending reads. Completed state is never cached across config/account changes. */
export class DirectoryMcpReader {
  private pending = new Map<string, Promise<DirectoryMcpSnapshot[]>>()

  constructor(private rpc: (method: string, params: unknown) => Promise<unknown>) {}

  invalidate(): void {
    this.pending.clear()
  }

  read(threadId: string, full: boolean): Promise<DirectoryMcpSnapshot[]> {
    const key = JSON.stringify([threadId, full])
    const existing = this.pending.get(key)
    if (existing) return existing
    if (this.pending.size >= 20) return Promise.reject(new Error('MCP 查询繁忙，请稍后重试'))
    const task = readDirectoryPages(async cursor => {
      const result = await this.rpc('mcpServerStatus/list', {
        limit: 25, detail: full ? 'full' : 'toolsAndAuthOnly', ...(cursor ? { cursor } : {}), ...(threadId ? { threadId } : {}),
      }) as { data?: unknown[]; nextCursor?: string | null }
      if (!Array.isArray(result?.data) || result.data.length > 25) throw new Error('MCP 分页响应无效')
      return { data: result.data.map(item => compactMcpStatus(item, full)), nextCursor: result.nextCursor }
    }).finally(() => {
      if (this.pending.get(key) === task) this.pending.delete(key)
    })
    this.pending.set(key, task)
    return task
  }
}
