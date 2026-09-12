import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { privateJson } from './store.js'
import { emptyUsage, type UsageCounters, type UsageOutcome, type TokenUsage, type ProxyUsageSummary } from '../../api/proxyUsageTypes.js'

const BUCKET_MS = 15 * 60_000
const RETENTION_MS = 8 * 86400_000
const MAX_BUCKETS = 32768
type Bucket = { at: number; keyId: string; counters: UsageCounters }
type State = { version: 1; startedAt: string; coverageFrom: number; totals: Record<string, UsageCounters>; buckets: Bucket[] }
const number = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
export function extractUsage(payload: any): TokenUsage | null {
  const usage = payload?.response?.usage ?? payload?.usage
  if (!usage || typeof usage !== 'object') return null
  const input = number(usage.input_tokens ?? usage.prompt_tokens)
  const output = number(usage.output_tokens ?? usage.completion_tokens)
  const total = number(usage.total_tokens) ?? (input !== null && output !== null ? input + output : null)
  if (input === null && output === null && total === null) return null
  return { input, output, total, cached: number(usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens),
    reasoning: number(usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens) }
}
function add(target: UsageCounters, delta: UsageCounters): void {
  for (const key of Object.keys(target) as (keyof UsageCounters)[]) target[key] += delta[key]
}
export class ProxyUsageStore {
  private state: State = { version: 1, startedAt: new Date().toISOString(), coverageFrom: Date.now(), totals: {}, buckets: [] }
  private index = new Map<string, Bucket>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> = Promise.resolve()
  private dirty = false
  private blocked = false
  error: string | null = null
  readonly ready: Promise<void>
  constructor(private directory: string) { this.ready = this.load() }
  private async load(): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const file = join(this.directory, 'usage.json')
      const info = await stat(file)
      if (info.size > 32 * 1024 * 1024) throw new Error('oversized')
      const parsed = JSON.parse(await readFile(file, 'utf8')) as State
      if (parsed.version !== 1 || !Array.isArray(parsed.buckets) || parsed.buckets.length > MAX_BUCKETS
        || !Number.isFinite(Date.parse(parsed.startedAt)) || !Number.isFinite(parsed.coverageFrom)
        || !parsed.totals || Object.keys(parsed.totals).length > 256) throw new Error('invalid')
      const validCounters = (row: UsageCounters) => row && Object.keys(emptyUsage()).every(key => number(row[key as keyof UsageCounters]) !== null)
      if (!Object.entries(parsed.totals).every(([key, row]) => /^[a-f0-9]{16}$/.test(key) && validCounters(row))
        || !parsed.buckets.every(row => Number.isFinite(row.at) && /^[a-f0-9]{16}$/.test(row.keyId) && validCounters(row.counters))) throw new Error('invalid')
      this.state = parsed
      this.prune()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      this.error = '统计读取失败，原文件已保留；本次统计暂存于内存。'
      this.blocked = true
    }
  }
  private prune(): void {
    const cutoff = Date.now() - RETENTION_MS
    const sorted = this.state.buckets.filter(row => row.at >= cutoff).sort((a, b) => a.at - b.at)
    // Evict a batch: a full ledger must not sort all buckets for every new row.
    const keep = sorted.length > MAX_BUCKETS ? MAX_BUCKETS - 2048 : MAX_BUCKETS
    const removed = sorted.slice(0, Math.max(0, sorted.length - keep))
    if (removed.length) this.state.coverageFrom = Math.max(this.state.coverageFrom, removed.at(-1)!.at + BUCKET_MS)
    this.state.coverageFrom = Math.max(this.state.coverageFrom, cutoff)
    this.state.buckets = sorted.slice(-keep)
    this.index = new Map(this.state.buckets.map(row => [`${row.at}:${row.keyId}`, row]))
  }
  begin(keyId: string, catalog = false) {
    let settled = false
    return (outcome: UsageOutcome, usage: TokenUsage | null = null) => {
      if (settled) return
      settled = true
      this.record(keyId, catalog, outcome, usage)
    }
  }
  private record(keyId: string, catalog: boolean, outcome: UsageOutcome, usage: TokenUsage | null): void {
    const delta = emptyUsage()
    if (catalog) delta.catalogs = 1
    else {
      delta.requests = 1
      delta[outcome] = 1
      if (outcome !== 'rejected') {
        delta.unknown = usage?.total == null ? 1 : 0
        delta.inputUnknown = usage?.input == null ? 1 : 0
        delta.outputUnknown = usage?.output == null ? 1 : 0
        for (const key of ['input', 'output', 'total', 'cached', 'reasoning'] as const) delta[key] = usage?.[key] ?? 0
      }
    }
    add(this.state.totals[keyId] ??= emptyUsage(), delta)
    const at = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS
    const indexKey = `${at}:${keyId}`
    let bucket = this.index.get(indexKey)
    if (!bucket) {
      bucket = { at, keyId, counters: emptyUsage() }
      this.state.buckets.push(bucket)
      this.index.set(indexKey, bucket)
      if (this.state.buckets.length > MAX_BUCKETS) this.prune()
    }
    add(bucket.counters, delta)
    this.dirty = true
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; void this.flush() }, 2000)
      this.timer.unref()
    }
  }
  summary(timeZone = 'UTC'): ProxyUsageSummary {
    let formatter: Intl.DateTimeFormat
    try { formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }) }
    catch { timeZone = 'UTC'; formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }) }
    const date = (at: number) => {
      const parts = formatter.formatToParts(at)
      return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type)!.value).join('-')
    }
    const today = date(Date.now())
    const weekStart = new Date(Date.parse(today + 'T00:00:00Z') - 6 * 86400_000).toISOString().slice(0, 10)
    const keys: ProxyUsageSummary['keys'] = Object.fromEntries(Object.entries(this.state.totals).map(([key, cumulative]) => [key, { cumulative: { ...cumulative }, today: emptyUsage(), week: emptyUsage() }]))
    const dates = new Map<number, string>()
    for (const bucket of this.state.buckets) {
      const day = dates.get(bucket.at) ?? date(bucket.at)
      dates.set(bucket.at, day)
      const row = keys[bucket.keyId]
      if (!row) continue
      if (day === today) add(row.today, bucket.counters)
      if (day >= weekStart && day <= today) add(row.week, bucket.counters)
    }
    return { startedAt: this.state.startedAt, windowCoverageFrom: new Date(Math.max(this.state.coverageFrom, Date.now() - RETENTION_MS)).toISOString(), error: this.error, timeZone, keys }
  }
  async flush(): Promise<void> {
    this.writing = this.writing.then(async () => {
      await this.ready
      if (!this.dirty || this.blocked) return
      this.prune()
      this.dirty = false
      try {
        await privateJson(join(this.directory, 'usage.json'), this.state, true)
        this.error = null
      } catch {
        this.dirty = true
        this.error = '统计写入失败，本次数据暂存于内存。'
      }
    })
    return this.writing
  }
  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.flush()
  }
}
