import { createHash } from 'node:crypto'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAutomationFileAtomic } from './automationDefinition.js'
import type { AutomationRun } from './automationStore.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const nameOf = (run: Pick<AutomationRun, 'createdAt' | 'runId'>) => `${String(run.createdAt).padStart(16, '0')}_${encodeURIComponent(run.runId)}.json`
const validName = (name: string) => /^\d{16}_[\w%.-]+\.json$/.test(name)
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const segmentOf = (run: Pick<AutomationRun, 'createdAt'>) => new Date(run.createdAt).toISOString().slice(0, 10).replaceAll('-', '')
function firstAfter(names: string[], before: string): number {
  let low = 0, high = names.length
  while (low < high) { const mid = (low + high) >>> 1; if (names[mid]! >= before) low = mid + 1; else high = mid }
  return low
}
function validate(value: unknown): AutomationRun {
  const run = value as AutomationRun
  if (!run || typeof run.runId !== 'string' || !run.runId || typeof run.automationId !== 'string' || !run.automationId
    || typeof run.key !== 'string' || !run.key || !Number.isSafeInteger(run.createdAt) || run.createdAt < 0
    || !validName(nameOf(run)) || !['completed', 'failed', 'interrupted', 'cancelled', 'missed', 'skipped'].includes(run.status)) throw new Error('执行历史文件损坏，请检查日志归档')
  segmentOf(run)
  return run
}
async function namesAt(path: string): Promise<string[]> {
  return readdir(path).catch(error => { if (missing(error)) return []; throw error })
}
export type AutomationHistoryPage = { data: AutomationRun[]; nextCursor: string | null }

/** Version 2: permanent request facts, daily display indexes, resumable archive commits.
 * Legacy files stay untouched. Scheduling state is pruned only after archive() succeeds.
 */
export class AutomationHistory {
  private ready?: Promise<void>
  private writes: Promise<unknown> = Promise.resolve()
  private names = new Map<string, string[]>()
  private revisions = new Map<string, number>()
  constructor(private directory: string) {}
  private root(...parts: string[]) { return join(this.directory, 'history-v2', ...parts) }
  private fact(kind: 'records' | 'keys' | 'ids', digest: string) { return this.root(kind, digest.slice(0, 2), `${digest}.json`) }
  private timeline(id: string, segment: string) { return this.root('timeline', hash(id), segment) }
  private ensureReady(): Promise<void> { return this.ready ??= this.recover() }

  private async readFact(digest: string): Promise<AutomationRun | undefined> {
    let damaged: unknown
    // Both files contain the permanent fact. Losing a lookup/index copy must not
    // turn an old request into permission to submit it again.
    for (const path of [this.fact('records', digest), this.fact('keys', digest), this.root('pending', `${digest}.json`)]) {
      try {
        const run = validate(JSON.parse(await readFile(path, 'utf8')))
        if (hash(run.key) !== digest) throw new Error('执行历史索引不匹配')
        return run
      } catch (error) { if (!missing(error)) damaged = error }
    }
    if (damaged) throw damaged
    return undefined
  }

  private async persistRun(input: AutomationRun): Promise<void> {
    const requested = validate(input)
    const digest = hash(requested.key)
    const existing = await this.readFact(digest)
    if (existing && (existing.runId !== requested.runId || existing.automationId !== requested.automationId)) throw new Error('执行历史防重记录冲突')
    const run = existing || requested
    const name = nameOf(run), segment = segmentOf(run), body = JSON.stringify(run)
    const pending = this.root('pending', `${digest}.json`)
    await writeAutomationFileAtomic(pending, body)
    await writeAutomationFileAtomic(this.fact('records', digest), body)
    await writeAutomationFileAtomic(this.fact('keys', digest), body)
    await writeAutomationFileAtomic(join(this.timeline(run.automationId, segment), name), JSON.stringify({ key: digest }))
    await writeAutomationFileAtomic(this.fact('ids', hash(JSON.stringify([run.automationId, run.runId]))), JSON.stringify({ key: digest }))
    await rm(pending)
    const cacheKey = `${hash(run.automationId)}/${segment}`
    this.names.delete(cacheKey)
    this.revisions.set(cacheKey, (this.revisions.get(cacheKey) || 0) + 1)
  }

  private async recover(): Promise<void> {
    for (const name of await namesAt(this.root('pending'))) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      const run = validate(JSON.parse(await readFile(this.root('pending', name), 'utf8')))
      if (`${hash(run.key)}.json` !== name) throw new Error('执行历史恢复记录损坏')
      await this.persistRun(run)
    }
    // Reconcile the old flat layout once per catalog change. Keep its original
    // bytes for recovery; subsequent boots compare directory metadata, not bodies.
    const legacyRoot = join(this.directory, 'history')
    const folders = (await namesAt(legacyRoot)).filter(validHash).sort()
    if (!folders.length) return
    const stamps: [string, number][] = []
    for (let offset = 0; offset < folders.length; offset += 8) {
      stamps.push(...await Promise.all(folders.slice(offset, offset + 8).map(async folder => [folder, (await stat(join(legacyRoot, folder))).mtimeMs] as [string, number])))
    }
    const signature = hash(JSON.stringify(stamps))
    const marker = this.root('legacy-index.json')
    try { if (JSON.parse(await readFile(marker, 'utf8')).signature === signature) return }
    catch (error) { if (!missing(error) && !(error instanceof SyntaxError)) throw error }
    for (const folder of folders) {
      for (const name of (await namesAt(join(legacyRoot, folder))).filter(validName)) {
        const run = validate(JSON.parse(await readFile(join(legacyRoot, folder, name), 'utf8')))
        if (hash(run.automationId) !== folder || nameOf(run) !== name) throw new Error('旧执行历史文件不匹配')
        await this.persistRun(run)
      }
    }
    await writeAutomationFileAtomic(marker, JSON.stringify({ signature }))
  }

  archive(runs: AutomationRun[]): Promise<void> {
    const next = this.writes.then(async () => {
      await this.ensureReady()
      for (const run of runs) await this.persistRun(run)
    })
    this.writes = next.catch(() => {})
    return next
  }

  /** Explicit maintenance; never removes facts. Also prepares old-layout copies
   * before an operator intentionally rolls back to a pre-v2 application binary. */
  repairIndexes(options: { exportLegacy?: boolean } = {}): Promise<{ records: number; exportedLegacy: boolean }> {
    const next = this.writes.then(async () => {
      await this.ensureReady()
      let records = 0
      for (let prefix = 0; prefix < 256; prefix++) {
        const shard = prefix.toString(16).padStart(2, '0')
        const files = new Set([...(await namesAt(this.root('records', shard))), ...(await namesAt(this.root('keys', shard)))])
        for (const name of files) {
          const digest = name.slice(0, -5)
          if (!name.endsWith('.json') || !validHash(digest)) continue
          const run = await this.readFact(digest)
          if (!run) throw new Error('执行历史防重记录缺失')
          await this.persistRun(run)
          if (options.exportLegacy) {
            await writeAutomationFileAtomic(join(this.directory, 'history', hash(run.automationId), nameOf(run)), JSON.stringify(run))
            await writeAutomationFileAtomic(join(this.directory, 'history-keys', `${digest}.json`), JSON.stringify({ automationId: run.automationId, name: nameOf(run) }))
          }
          records++
        }
      }
      return { records, exportedLegacy: options.exportLegacy === true }
    })
    this.writes = next.catch(() => {})
    return next
  }

  private async list(id: string, segment: string): Promise<string[]> {
    const key = `${hash(id)}/${segment}`
    const cached = this.names.get(key)
    if (cached) { this.names.delete(key); this.names.set(key, cached); return cached }
    const revision = this.revisions.get(key) || 0
    const names = (await namesAt(this.timeline(id, segment))).filter(validName).sort().reverse()
    if (revision !== (this.revisions.get(key) || 0)) return this.list(id, segment)
    // Only a bounded set of day indexes stays in memory; no lifetime-wide name array.
    this.names.set(key, names)
    if (this.names.size > 32) this.names.delete(this.names.keys().next().value!)
    return names
  }

  private async read(id: string, name: string): Promise<AutomationRun> {
    const createdAt = Number(name.slice(0, 16))
    const pointer = JSON.parse(await readFile(join(this.timeline(id, segmentOf({ createdAt })), name), 'utf8'))
    if (!validHash(pointer?.key)) throw new Error('执行历史索引损坏')
    const run = await this.readFact(pointer.key)
    if (!run || run.automationId !== id || nameOf(run) !== name) throw new Error('执行历史记录缺失或不匹配，禁止重新提交旧请求')
    return run
  }

  async findByKey(key: string): Promise<AutomationRun | undefined> {
    await this.ensureReady()
    const run = await this.readFact(hash(key))
    if (run) return run
    // An old index whose body was lost is evidence of a previous run, not absence.
    let index: { automationId?: unknown; name?: unknown }
    try { index = JSON.parse(await readFile(join(this.directory, 'history-keys', `${hash(key)}.json`), 'utf8')) }
    catch (error) { if (missing(error)) return undefined; throw error }
    if (typeof index.automationId !== 'string' || typeof index.name !== 'string' || !validName(index.name)) throw new Error('执行历史索引损坏')
    try {
      const legacy = validate(JSON.parse(await readFile(join(this.directory, 'history', hash(index.automationId), index.name), 'utf8')))
      if (legacy.key !== key || legacy.automationId !== index.automationId || nameOf(legacy) !== index.name) throw new Error('执行历史索引不匹配')
      return legacy
    } catch { throw new Error('旧执行历史记录缺失或损坏，禁止重新提交旧请求') }
  }

  async findById(id: string, runId: string): Promise<AutomationRun | undefined> {
    await this.ensureReady()
    try {
      const pointer = JSON.parse(await readFile(this.fact('ids', hash(JSON.stringify([id, runId]))), 'utf8'))
      if (!validHash(pointer?.key)) throw new Error('执行历史索引损坏')
      const run = await this.readFact(pointer.key)
      if (!run || run.automationId !== id || run.runId !== runId) throw new Error('执行历史记录缺失或不匹配')
      return run
    } catch (error) { if (!missing(error)) throw error }
    // Missing display lookup: bounded-memory traversal can still recover by ID.
    for (const segment of (await namesAt(this.root('timeline', hash(id)))).filter(name => /^\d{8}$/.test(name)).sort().reverse()) {
      const name = (await this.list(id, segment)).find(name => name.endsWith(`_${encodeURIComponent(runId)}.json`))
      if (name) return this.read(id, name)
    }
    return undefined
  }

  async page(id: string, live: AutomationRun[], cursor: string | null, limit: number): Promise<AutomationHistoryPage> {
    await this.ensureReady()
    if (!id) throw new Error('需要指定自动化任务')
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('每页数量必须为 1 至 100')
    const before = cursor ? Buffer.from(cursor, 'base64url').toString('utf8') : null
    if (before && !validName(before)) throw new Error('无效的历史分页游标')
    const hot = new Map(live.filter(run => run.automationId === id).map(run => [nameOf(run), { ...run }]))
    const recent = [...hot.keys()].filter(name => !before || name < before).sort().reverse()
    const segments = (await namesAt(this.root('timeline', hash(id)))).filter(name => /^\d{8}$/.test(name) && (!before || name <= segmentOf({ createdAt: Number(before.slice(0, 16)) }))).sort().reverse()
    const selected = new Set(recent.slice(0, limit + 1))
    for (const segment of segments) {
      const names = await this.list(id, segment)
      let index = before ? firstAfter(names, before) : 0
      while (index < names.length) {
        const name = names[index++]!
        const sorted = [...selected].sort().reverse()
        if (sorted.length > limit && name < sorted[limit]!) break
        selected.add(name)
        if (selected.size > limit + 1) selected.delete([...selected].sort()[0]!)
      }
      const boundary = [...selected].sort().reverse()[limit]
      if (boundary && segment <= segmentOf({ createdAt: Number(boundary.slice(0, 16)) })) break
    }
    const ordered = [...selected].sort().reverse(), more = ordered.length > limit
    const names = ordered.slice(0, limit), data: AutomationRun[] = []
    for (let offset = 0; offset < names.length; offset += 8) {
      data.push(...await Promise.all(names.slice(offset, offset + 8).map(name => hot.get(name) ?? this.read(id, name))))
    }
    return { data, nextCursor: more && names.length ? Buffer.from(names.at(-1)!).toString('base64url') : null }
  }
}
