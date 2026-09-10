import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { privateJson } from './apiProxy/store.js'

type PluginCatalog = { marketplaces: unknown[]; marketplaceLoadErrors?: unknown[] }
type Entry = { version: 1; cwds: string[]; updatedAt: number; catalog: PluginCatalog }
const MAX_SCOPES = 12

export function nextLocalPluginRefresh(after: number): number {
  const next = new Date(after)
  next.setHours(2, 0, 0, 0)
  if (next.getTime() <= after) next.setDate(next.getDate() + 1)
  return next.getTime()
}

/** Disk-backed catalogs survive page and server restarts; upstream reads are single-flight. */
export class DirectoryPluginCache {
  private entries = new Map<string, Entry>()
  private pending = new Map<string, Promise<PluginCatalog>>()
  private writes: Promise<unknown> = Promise.resolve()
  private retryAt = new Map<string, number>()
  private timer: NodeJS.Timeout | undefined
  private closed = false
  private readonly ready: Promise<void>

  constructor(private directory: string, private rpc: (params: unknown) => Promise<unknown>, private now = Date.now, schedule = true) {
    this.ready = this.restore()
    if (schedule) {
      this.schedule()
      void this.ready.then(() => this.entries.size ? undefined : this.refresh([])).catch(() => {})
    }
  }

  private key(cwds: string[]): string {
    return createHash('sha256').update(JSON.stringify(cwds)).digest('hex')
  }

  private async restore(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const files = (await readdir(this.directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
    for (const file of files.slice(0, MAX_SCOPES)) {
      try {
        const entry = JSON.parse(await readFile(join(this.directory, file), 'utf8')) as Entry
        if (entry.version === 1 && Array.isArray(entry.cwds) && entry.cwds.every(cwd => typeof cwd === 'string') && Number.isFinite(entry.updatedAt) && Array.isArray(entry.catalog?.marketplaces)) {
          this.entries.set(this.key(entry.cwds), entry)
        }
      } catch { /* A corrupt cache is rebuilt on demand. */ }
    }
    for (const file of files.slice(MAX_SCOPES)) await rm(join(this.directory, file), { force: true })
  }

  async read(params: Record<string, unknown> = {}): Promise<PluginCatalog> {
    await this.ready
    const cwds = Array.isArray(params.cwds) ? [...new Set(params.cwds.filter((cwd): cwd is string => typeof cwd === 'string' && !!cwd.trim()))].sort() : []
    const key = this.key(cwds)
    const saved = this.entries.get(key)
    if (saved && params.forceRefetch !== true) {
      if (this.now() >= nextLocalPluginRefresh(saved.updatedAt) && this.now() >= (this.retryAt.get(key) || 0)) void this.refresh(cwds).catch(() => {})
      return saved.catalog
    }
    return this.refresh(cwds)
  }

  private refresh(cwds: string[]): Promise<PluginCatalog> {
    const key = this.key(cwds)
    const pending = this.pending.get(key)
    if (pending) return pending
    if (this.closed || this.pending.size >= MAX_SCOPES) return Promise.reject(new Error('插件目录暂不可用'))
    if (this.retryAt.size >= MAX_SCOPES && !this.retryAt.has(key)) this.retryAt.delete(this.retryAt.keys().next().value!)
    this.retryAt.set(key, this.now() + 60000)
    const work = (async () => {
      const catalog = await this.rpc({ ...(cwds.length ? { cwds } : {}), forceRefetch: true }) as PluginCatalog
      if (!Array.isArray(catalog?.marketplaces)) throw new Error('插件目录响应无效')
      // Partial marketplace failures must not replace the last complete disk snapshot.
      if (catalog.marketplaceLoadErrors?.length) {
        const saved = this.entries.get(key)
        return saved ? { ...saved.catalog, marketplaceLoadErrors: catalog.marketplaceLoadErrors } : catalog
      }
      const entry: Entry = { version: 1, cwds, updatedAt: this.now(), catalog }
      const write = this.writes.then(async () => {
        if (this.closed) return
        if (!this.entries.has(key) && this.entries.size >= MAX_SCOPES) {
          const oldest = [...this.entries].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0]![0]
          this.entries.delete(oldest)
          await rm(join(this.directory, `${oldest}.json`), { force: true })
        }
        await privateJson(join(this.directory, `${key}.json`), entry)
        this.entries.set(key, entry)
      })
      this.writes = write.catch(() => {})
      await write
      return catalog
    })().finally(() => this.pending.delete(key))
    this.pending.set(key, work)
    return work
  }

  async refreshKnown(): Promise<void> {
    await this.ready
    const scopes = this.entries.size ? [...this.entries.values()].map(entry => entry.cwds) : [[]]
    for (const cwds of scopes) {
      if (this.closed) break
      await this.refresh(cwds).catch(() => {})
    }
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      void this.refreshKnown().finally(() => { if (!this.closed) this.schedule() })
    }, Math.max(1, nextLocalPluginRefresh(this.now()) - this.now()))
    this.timer.unref()
  }

  dispose(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
  }
}
