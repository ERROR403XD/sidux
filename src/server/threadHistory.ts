import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

type RecordValue = Record<string, unknown>
type Rpc = (method: string, params: RecordValue) => Promise<unknown>
type Features = { historyPaging: boolean; resumeInitialPage: boolean; exactFork: boolean }
export type HistoryPage = {
  result: RecordValue
  nextCursor: string | null
  hasMoreOlder: boolean
  source: 'native' | 'legacy'
}

export const HISTORY_PAGE_SIZE = 10
export const LEGACY_HISTORY_BYTE_LIMIT = 8 * 1024 * 1024
const CACHE_BYTE_LIMIT = 32 * 1024 * 1024
const CACHE_ENTRY_LIMIT = 10

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
}

function cursor(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function isHistoryPagingUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /method not found|unknown (?:method|variant).*thread\/(?:turns|items)\/list|(?:pagination|paginated history|history pagination).*(?:not supported|unavailable)|(?:not supported|unavailable).*(?:pagination|paginated history)/i.test(message)
}

/** Native cursors remain opaque. The legacy path has explicit memory and file limits. */
export class ThreadHistory {
  private readonly cache = new Map<string, { value: RecordValue; bytes: number; expires: number }>()
  private readonly revisions = new Map<string, number>()
  private readonly inFlight = new Map<string, Promise<RecordValue>>()
  private cacheBytes = 0

  constructor(private readonly rpc: Rpc, private readonly features: () => Promise<Features>) {}

  invalidate(threadId: string): void {
    const entry = this.cache.get(threadId)
    if (entry) this.cacheBytes -= entry.bytes
    this.cache.delete(threadId)
    // Revisions only exist while a legacy read is in flight.
    if (this.inFlight.has(threadId)) this.revisions.set(threadId, (this.revisions.get(threadId) ?? 0) + 1)
  }

  clear(): void {
    for (const id of this.inFlight.keys()) this.invalidate(id)
    this.cache.clear()
    this.cacheBytes = 0
  }

  private async checkLegacyFile(metadata: RecordValue): Promise<boolean> {
    const thread = record(metadata.thread)
    const path = typeof thread.path === 'string' ? thread.path : ''
    if (!path || !isAbsolute(path)) {
      if (thread.ephemeral === true || !thread.preview) return false
      throw new Error('旧会话缺少可核对的历史文件，无法加载全文回退。')
    }
    if ((await stat(path)).size > LEGACY_HISTORY_BYTE_LIMIT) throw new Error('旧会话超过 8 MB 回退上限，请使用支持原生分页的 Codex CLI。')
    return true
  }

  private async legacyRead(threadId: string, metadata: RecordValue): Promise<RecordValue> {
    const cached = this.cache.get(threadId)
    if (cached && cached.expires > Date.now()) return cached.value
    if (cached) this.invalidate(threadId)
    const pending = this.inFlight.get(threadId)
    if (pending) return pending
    const revision = this.revisions.get(threadId) ?? 0
    const promise = (async () => {
      if (!await this.checkLegacyFile(metadata)) return { ...metadata, thread: { ...record(metadata.thread), turns: [] } }
      const value = record(await this.rpc('thread/read', { threadId, includeTurns: true }))
      const bytes = Buffer.byteLength(JSON.stringify(value))
      if (bytes > LEGACY_HISTORY_BYTE_LIMIT) throw new Error('旧会话响应超过 8 MB 回退上限。')
      if ((this.revisions.get(threadId) ?? 0) === revision) {
        while (this.cache.size >= CACHE_ENTRY_LIMIT || this.cacheBytes + bytes > CACHE_BYTE_LIMIT) {
          const oldest = this.cache.keys().next().value
          if (!oldest) break
          this.invalidate(oldest)
        }
        this.cache.set(threadId, { value, bytes, expires: Date.now() + 30_000 })
        this.cacheBytes += bytes
      }
      return value
    })().finally(() => {
      this.inFlight.delete(threadId)
      this.revisions.delete(threadId)
    })
    this.inFlight.set(threadId, promise)
    return promise
  }

  private nativePage(metadata: RecordValue, payload: unknown): HistoryPage {
    const page = record(payload)
    if (!Array.isArray(page.data)) throw new Error('原生历史分页返回无效数据。')
    if (page.data.some(turn => record(turn).itemsView && record(turn).itemsView !== 'full')) throw new Error('原生历史没有返回完整回合内容。')
    const nextCursor = cursor(page.nextCursor)
    return {
      result: { ...metadata, thread: { ...record(metadata.thread), turns: [...page.data].reverse() } },
      nextCursor,
      hasMoreOlder: nextCursor !== null,
      source: 'native',
    }
  }

  private async legacyPage(threadId: string, metadata: RecordValue, beforeTurnId: string, limit: number): Promise<HistoryPage> {
    const value = await this.legacyRead(threadId, metadata)
    const thread = record(value.thread)
    const turns = Array.isArray(thread.turns) ? thread.turns : []
    const end = beforeTurnId ? turns.findIndex(turn => record(turn).id === beforeTurnId) : turns.length
    if (end < 0) throw new Error('历史位置已变化，请刷新会话后重试。')
    const start = Math.max(0, end - limit)
    return {
      result: { ...value, thread: { ...thread, turns: turns.slice(start, end) } },
      nextCursor: null,
      hasMoreOlder: start > 0,
      source: 'legacy',
    }
  }

  async initial(method: 'thread/read' | 'thread/resume', params: RecordValue): Promise<RecordValue> {
    const support = await this.features()
    const threadId = String(params.threadId ?? '')
    let metadata: RecordValue
    if (method === 'thread/resume') {
      if (!support.historyPaging) {
        const beforeResume = record(await this.rpc('thread/read', { threadId, includeTurns: false }))
        await this.checkLegacyFile(beforeResume)
      }
      metadata = record(await this.rpc(method, {
        ...params,
        excludeTurns: true,
        ...(support.resumeInitialPage ? { initialTurnsPage: { limit: HISTORY_PAGE_SIZE, sortDirection: 'desc', itemsView: 'full' } } : {}),
      }))
    } else {
      metadata = record(await this.rpc(method, { ...params, includeTurns: false }))
    }
    const initialPage = metadata.initialTurnsPage
    delete metadata.initialTurnsPage
    // A legacy CLI may ignore excludeTurns. Keep that bounded snapshot for this request only.
    if (Array.isArray(record(metadata.thread).turns) && (record(metadata.thread).turns as unknown[]).length > 0 && !initialPage) {
      const bytes = Buffer.byteLength(JSON.stringify(metadata))
      if (bytes > LEGACY_HISTORY_BYTE_LIMIT) throw new Error('旧会话响应超过 8 MB 回退上限。')
    }
    const page = initialPage
      ? this.nativePage(metadata, initialPage)
      : await this.page(threadId, { metadata, limit: HISTORY_PAGE_SIZE })
    return { ...page.result, threadHistory: { nextCursor: page.nextCursor, hasMoreOlder: page.hasMoreOlder, source: page.source } }
  }

  async page(threadId: string, options: { cursor?: string; beforeTurnId?: string; limit?: number; metadata?: RecordValue; source?: string } = {}): Promise<HistoryPage> {
    const limit = Math.max(1, Math.min(50, options.limit ?? HISTORY_PAGE_SIZE))
    const metadata = options.metadata ?? record(await this.rpc('thread/read', { threadId, includeTurns: false }))
    if (options.beforeTurnId && options.source === 'native' && !options.cursor) throw new Error('缺少历史游标，请刷新会话后重试。')
    const legacyClient = options.beforeTurnId && !options.cursor && options.source !== 'native'
    if ((await this.features()).historyPaging && options.source !== 'legacy' && !legacyClient) {
      try {
        const page = this.nativePage(metadata, await this.rpc('thread/turns/list', {
          threadId, limit, sortDirection: 'desc', itemsView: 'full', cursor: options.cursor || null,
        }))
        if (options.cursor && page.nextCursor === options.cursor) throw new Error('历史游标重复，请刷新后重试。')
        return page
      } catch (error) {
        if (options.cursor || !isHistoryPagingUnsupported(error)) throw error
      }
    }
    return this.legacyPage(threadId, metadata, options.beforeTurnId ?? '', limit)
  }

  async turn(threadId: string, turnId: string): Promise<RecordValue> {
    const metadata = record(await this.rpc('thread/read', { threadId, includeTurns: false }))
    const legacyTurn = async (): Promise<RecordValue> => {
      const value = await this.legacyRead(threadId, metadata)
      const allTurns = record(value.thread).turns
      const turns = (Array.isArray(allTurns) ? allTurns : []).filter(turn => record(turn).id === turnId)
      if (!turns.length) throw new Error('找不到对应历史回合。')
      return { ...metadata, thread: { ...record(metadata.thread), turns } }
    }
    if (!(await this.features()).historyPaging) return legacyTurn()
    const items: unknown[] = []
    const seen = new Set<string>()
    let next: string | null = null
    let bytes = 0
    for (let page = 0; page < 20; page += 1) {
      let response: RecordValue
      try {
        response = record(await this.rpc('thread/items/list', { threadId, turnId, limit: 100, sortDirection: 'asc', cursor: next }))
      } catch (error) {
        if (page === 0 && isHistoryPagingUnsupported(error)) return legacyTurn()
        throw error
      }
      if (!Array.isArray(response.data)) throw new Error('历史项目分页返回无效数据。')
      bytes += Buffer.byteLength(JSON.stringify(response.data))
      if (bytes > LEGACY_HISTORY_BYTE_LIMIT) throw new Error('该回合内容超过 8 MB，请在 Codex CLI 中查看。')
      for (const entry of response.data) {
        const row = record(entry)
        if (row.turnId !== turnId) throw new Error('历史项目属于其他回合。')
        items.push(row.item)
      }
      next = cursor(response.nextCursor)
      if (!next) return { ...metadata, thread: { ...record(metadata.thread), turns: [{ id: turnId, items, status: 'completed' }] } }
      if (seen.has(next)) throw new Error('历史项目游标重复，请刷新后重试。')
      seen.add(next)
    }
    throw new Error('该回合超过 2000 个历史项目，请在 Codex CLI 中查看。')
  }

  async fork(threadId: string, lastTurnId: string): Promise<unknown> {
    if (!(await this.features()).exactFork) throw new Error('当前 Codex CLI 不支持按回合分支，请先更新 CLI。')
    return this.rpc('thread/fork', { threadId, lastTurnId, excludeTurns: true, deferGoalContinuation: true })
  }

  async assertRollbackAllowed(threadId: string): Promise<void> {
    const metadata = record(await this.rpc('thread/read', { threadId, includeTurns: false }))
    const thread = record(metadata.thread)
    if (thread.historyMode === 'paginated') {
      throw new Error('此会话不支持撤回历史。可从已完成的回合创建分支。')
    }
    if (record(thread.status).type === 'active') {
      throw new Error('请等待当前回合结束后再撤回历史。')
    }
  }
}
