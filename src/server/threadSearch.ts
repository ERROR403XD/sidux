import { createThreadMatcher, type ThreadSearchMode } from '../threadSearchMatch.js'

type ThreadRow = Record<string, unknown> & { id: string }
type Body = { text: string; truncated: boolean }
type Metadata = { rows: ThreadRow[]; complete: boolean; expires: number }
export type ThreadSearchResult = {
  threadIds: string[]
  threads: ThreadRow[]
  indexedThreadCount: number
  titleScopeComplete: boolean
  bodyThreadCount: number
  bodyTurnLimit: number
  bodyThreadLimit: number
  partialBodyCount: number
  failedBodyCount: number
}

export const SEARCH_THREAD_LIMIT = 1000
export const SEARCH_BODY_THREAD_LIMIT = 100
export const SEARCH_BODY_TURN_LIMIT = 50
const BODY_CHAR_LIMIT = 200_000
const BODY_CACHE_BYTE_LIMIT = 32 * 1024 * 1024

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Search cancelled')
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** At most one scan and four body reads run across all clients. Cancelled scans drain their current batch. */
export class ThreadSearch {
  private metadata: Metadata | null = null
  private revision = 0
  private queue: Promise<void> = Promise.resolve()
  private readonly bodies = new Map<string, { key: string; body: Body; bytes: number; expires: number }>()
  private readonly bodyRequests = new Map<string, symbol>()
  private bodyBytes = 0

  constructor(private readonly dependencies: {
    list: (cursor: string | null) => Promise<{ data: unknown[]; nextCursor?: string | null }>
    body: (thread: ThreadRow) => Promise<Body>
    titles: () => Promise<Record<string, string>>
    version?: (thread: ThreadRow) => Promise<string>
  }) {}

  invalidate(threadId?: string): void {
    this.revision += 1
    this.metadata = null
    if (threadId) {
      this.dropBody(threadId)
      this.bodyRequests.delete(threadId)
    } else {
      this.bodies.clear()
      this.bodyRequests.clear()
      this.bodyBytes = 0
    }
  }

  private dropBody(id: string): void {
    const entry = this.bodies.get(id)
    if (entry) this.bodyBytes -= entry.bytes
    this.bodies.delete(id)
  }

  private async list(signal: AbortSignal): Promise<Metadata> {
    if (this.metadata && this.metadata.expires > Date.now()) return this.metadata
    const revision = this.revision
    const rows: ThreadRow[] = []
    const ids = new Set<string>()
    const cursors = new Set<string>()
    let cursor: string | null = null
    for (let page = 0; page < 10; page += 1) {
      abortIfNeeded(signal)
      const result = await this.dependencies.list(cursor)
      abortIfNeeded(signal)
      for (const item of result.data) {
        const row = item as ThreadRow
        if (!row || typeof row.id !== 'string' || ids.has(row.id) || rows.length >= SEARCH_THREAD_LIMIT) continue
        ids.add(row.id)
        rows.push(row)
      }
      cursor = result.nextCursor || null
      if (!cursor || rows.length >= SEARCH_THREAD_LIMIT) break
      if (cursors.has(cursor)) throw new Error('会话列表游标重复，请重试搜索。')
      cursors.add(cursor)
    }
    const result = { rows, complete: !cursor, expires: Date.now() + 5000 }
    if (revision === this.revision) {
      this.metadata = result
      const bodyIds = new Set(rows.slice(0, SEARCH_BODY_THREAD_LIMIT).map(row => row.id))
      for (const id of this.bodies.keys()) if (!bodyIds.has(id)) this.dropBody(id)
    }
    return result
  }

  private async body(row: ThreadRow): Promise<Body> {
    const version = await this.dependencies.version?.(row)
    const key = JSON.stringify([row.updatedAt, row.preview, row.path, version])
    const cached = this.bodies.get(row.id)
    if (cached?.key === key && cached.expires > Date.now()) return cached.body
    const token = Symbol(row.id)
    this.bodyRequests.set(row.id, token)
    let loaded: Body
    try {
      loaded = await this.dependencies.body(row)
    } catch (cause) {
      if (this.bodyRequests.get(row.id) === token) this.bodyRequests.delete(row.id)
      throw cause
    }
    const body = { text: loaded.text.slice(-BODY_CHAR_LIMIT), truncated: loaded.truncated || loaded.text.length > BODY_CHAR_LIMIT }
    const bytes = Buffer.byteLength(body.text)
    if (this.bodyRequests.get(row.id) === token) {
      this.bodyRequests.delete(row.id)
      this.dropBody(row.id)
      while (this.bodies.size >= SEARCH_BODY_THREAD_LIMIT || this.bodyBytes + bytes > BODY_CACHE_BYTE_LIMIT) {
        const oldest = this.bodies.keys().next().value
        if (!oldest) break
        this.dropBody(oldest)
      }
      this.bodies.set(row.id, { key, body, bytes, expires: version ? Infinity : Date.now() + 5000 })
      this.bodyBytes += bytes
    }
    return body
  }

  private async scan(query: string, limit: number, signal: AbortSignal, mode: ThreadSearchMode): Promise<ThreadSearchResult> {
    const metadata = await this.list(signal)
    const titles = await this.dependencies.titles()
    abortIfNeeded(signal)
    const matching = new Map<string, number>()
    const match = createThreadMatcher(query)
    const titleOf = (row: ThreadRow): string => titles[row.id] || text(row.name) || text(row.title) || text(row.preview) || 'Untitled thread'
    for (const row of metadata.rows) {
      const score = match(titleOf(row))
      if (score) matching.set(row.id, score + 4)
    }
    const rows = mode === 'body' ? metadata.rows.slice(0, SEARCH_BODY_THREAD_LIMIT) : []
    let offset = 0
    let bodyThreadCount = 0
    let partialBodyCount = 0
    let failedBodyCount = 0
    const workers = Array.from({ length: Math.min(4, rows.length) }, async () => {
      while (!signal.aborted && offset < rows.length) {
        const row = rows[offset++]
        try {
          const body = await this.body(row)
          if (signal.aborted) return
          bodyThreadCount += 1
          if (body.truncated) partialBodyCount += 1
          const score = match(body.text)
          if (score && !matching.has(row.id)) matching.set(row.id, score)
        } catch {
          failedBodyCount += 1
        }
      }
    })
    // Do not release the next query while abandoned reads are still in flight.
    await Promise.allSettled(workers)
    abortIfNeeded(signal)
    const matchedRows = metadata.rows
      .filter(row => matching.has(row.id))
      .sort((first, second) => matching.get(second.id)! - matching.get(first.id)!)
      .slice(0, limit)
    return {
      threadIds: matchedRows.map(row => row.id),
      // Search can find threads before sidebar pagination reaches them. Never send turns or full previews.
      threads: matchedRows.map(row => ({
        id: row.id,
        name: titleOf(row).slice(0, 500),
        preview: '',
        cwd: text(row.cwd),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        status: row.status,
        source: row.source,
        isWorktree: row.isWorktree,
      })),
      indexedThreadCount: metadata.rows.length,
      titleScopeComplete: metadata.complete,
      bodyThreadCount,
      bodyTurnLimit: SEARCH_BODY_TURN_LIMIT,
      bodyThreadLimit: SEARCH_BODY_THREAD_LIMIT,
      partialBodyCount,
      failedBodyCount,
    }
  }

  async search(query: string, limit: number, signal: AbortSignal, mode: ThreadSearchMode = 'title'): Promise<ThreadSearchResult> {
    const previous = this.queue
    let release: () => void = () => {}
    const done = new Promise<void>(resolve => { release = resolve })
    this.queue = previous.then(() => done)
    try {
      await previous
      abortIfNeeded(signal)
      const normalized = query.trim()
      if (normalized.length > 500) throw new Error('搜索内容不能超过 500 个字符。')
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const revision = this.revision
        const result = await this.scan(normalized, Math.max(1, Math.min(1000, limit)), signal, mode)
        if (revision === this.revision) return result
      }
      throw new Error('会话仍在更新，请重试搜索。')
    } finally {
      release()
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function extractThreadSearchText(threadReadPayload: unknown): string {
  const payload = asRecord(threadReadPayload)
  const thread = asRecord(payload?.thread)
  const turns = Array.isArray(thread?.turns) ? thread.turns : []
  const parts: string[] = []
  const limit = 200_002
  let length = 0
  const append = (value: string): void => {
    const tail = value.slice(-limit)
    parts.push(tail)
    length += tail.length + 1
    while (parts.length > 1 && length - parts[0].length - 1 >= limit) {
      length -= parts.shift()!.length + 1
    }
    if (length > limit && parts.length) {
      parts[0] = parts[0].slice(length - limit)
      length = limit
    }
  }

  for (const turn of turns) {
    const turnRecord = asRecord(turn)
    const items = Array.isArray(turnRecord?.items) ? turnRecord.items : []
    for (const item of items) {
      const itemRecord = asRecord(item)
      const type = typeof itemRecord?.type === 'string' ? itemRecord.type : ''
      if (type === 'agentMessage' && itemRecord?.phase !== 'commentary' && typeof itemRecord?.text === 'string' && itemRecord.text.trim().length > 0) {
        append(itemRecord.text.trim())
        continue
      }
      if (type === 'userMessage') {
        const content = Array.isArray(itemRecord?.content) ? itemRecord.content : []
        for (const block of content) {
          const blockRecord = asRecord(block)
          if (blockRecord?.type === 'text' && typeof blockRecord.text === 'string' && blockRecord.text.trim().length > 0) {
            append(blockRecord.text.trim())
          }
        }
        continue
      }

    }
  }

  return parts.join('\n').trim()
}
