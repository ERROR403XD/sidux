import { readTaskIdentity, type TaskIdentity } from '../subtasks'
import type { TaskExcerpt } from '../taskExcerpt'
export type TaskPage = { rows: Array<TaskIdentity & { snippet?: string }>; nextCursor: string | null }
const sources = ['cli', 'vscode', 'exec', 'appServer', 'subAgentThreadSpawn']
async function rpc(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  const response = await fetch('/codex-api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }), signal })
  const data = await response.json()
  if (!response.ok || !data.result) throw new Error(data.error || '任务读取失败，请重试。')
  return data.result
}
export async function listTaskPage(options: { query?: string; mode?: 'title' | 'body'; parentId?: string; cursor?: string | null; signal?: AbortSignal }): Promise<TaskPage> {
  const query = options.query?.trim().slice(0, 200) || ''
  const bodySearch = !options.parentId && !!query && options.mode === 'body'
  const params = { limit: 20, archived: false, sortKey: 'updated_at', cursor: options.cursor || null, sourceKinds: options.parentId ? ['subAgentThreadSpawn'] : sources,
    ...(options.parentId ? { parentThreadId: options.parentId } : query ? { searchTerm: query } : {}) }
  const result = await rpc(bodySearch ? 'thread/search' : 'thread/list', params, options.signal)
  if (!Array.isArray(result.data)) throw new Error('任务列表格式不可用，请刷新后重试。')
  const rows = result.data.slice(0, 20).flatMap((value: any) => {
    const identity = readTaskIdentity(bodySearch ? value.thread : value)
    if (!identity) return []
    if (options.parentId && identity.parentThreadId !== options.parentId) throw new Error('原生列表未返回匹配的父任务关系。')
    return [{ ...identity, ...(bodySearch && typeof value.snippet === 'string' ? { snippet: value.snippet.slice(0, 2000) } : {}) }]
  })
  return { rows, nextCursor: typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null }
}
export async function getTaskExcerpt(threadId: string, signal?: AbortSignal): Promise<TaskExcerpt> {
  const response = await fetch('/codex-api/task-excerpt?' + new URLSearchParams({ threadId }), { signal })
  const payload = await response.json()
  if (!response.ok || !payload.data) throw new Error(payload.error || '任务摘录读取失败。')
  return payload.data
}
