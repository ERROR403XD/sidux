import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAutomationFileAtomic } from './automationDefinition.js'
import type { AutomationRun } from './automationStore.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const nameOf = (run: Pick<AutomationRun, 'createdAt' | 'runId'>) => `${String(run.createdAt).padStart(16, '0')}_${encodeURIComponent(run.runId)}.json`
function firstAfter(names: string[], before: string): number {
  let low = 0, high = names.length
  while (low < high) { const mid = (low + high) >>> 1; if (names[mid]! >= before) low = mid + 1; else high = mid }
  return low
}
const validName = (name: string) => /^\d{16}_[\w%.-]+\.json$/.test(name)
export type AutomationHistoryPage = { data: AutomationRun[]; nextCursor: string | null }

// Terminal records leave the small scheduling state only after this archive is
// durable. A crash between archive and state writes is safe: reads deduplicate.
export class AutomationHistory {
  private names = new Map<string, string[]>()
  private revisions = new Map<string, number>()
  constructor(private directory: string) {}
  private folder(id: string) { return join(this.directory, 'history', hash(id)) }
  async archive(runs: AutomationRun[]) {
    for (const run of runs) {
      const name = nameOf(run)
      await writeAutomationFileAtomic(join(this.folder(run.automationId), name), JSON.stringify(run))
      await writeAutomationFileAtomic(join(this.directory, 'history-keys', `${hash(run.key)}.json`), JSON.stringify({ automationId: run.automationId, name }))
      const cached = this.names.get(run.automationId)
      if (cached) {
        const index = firstAfter(cached, name)
        if (cached[index - 1] !== name) cached.splice(index, 0, name)
      }
      this.revisions.set(run.automationId, (this.revisions.get(run.automationId) ?? 0) + 1)
    }
  }
  private async list(id: string): Promise<string[]> {
    const cached = this.names.get(id)
    if (cached) return cached
    const revision = this.revisions.get(id) ?? 0
    const names = (await readdir(this.folder(id)).catch(error => { if (error.code === 'ENOENT') return []; throw error })).filter(validName).sort().reverse()
    if (revision !== (this.revisions.get(id) ?? 0)) return this.list(id)
    this.names.set(id, names)
    return names
  }
  private async read(id: string, name: string): Promise<AutomationRun> {
    const run = JSON.parse(await readFile(join(this.folder(id), name), 'utf8')) as AutomationRun
    if (run.automationId !== id || nameOf(run) !== name) throw new Error('执行历史文件损坏，请检查日志归档')
    return run
  }
  async findByKey(key: string): Promise<AutomationRun | undefined> {
    try {
      const index = JSON.parse(await readFile(join(this.directory, 'history-keys', `${hash(key)}.json`), 'utf8'))
      if (typeof index.automationId !== 'string' || !validName(index.name)) throw new Error('执行历史索引损坏')
      const run = await this.read(index.automationId, index.name)
      if (run.key !== key) throw new Error('执行历史索引不匹配')
      return run
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  async findById(id: string, runId: string): Promise<AutomationRun | undefined> {
    const suffix = `_${encodeURIComponent(runId)}.json`
    const name = (await this.list(id)).find(name => name.endsWith(suffix))
    return name ? this.read(id, name) : undefined
  }
  async page(id: string, live: AutomationRun[], cursor: string | null, limit: number): Promise<AutomationHistoryPage> {
    if (!id) throw new Error('需要指定自动化任务')
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('每页数量必须为 1 至 100')
    const before = cursor ? Buffer.from(cursor, 'base64url').toString('utf8') : null
    if (before && !validName(before)) throw new Error('无效的历史分页游标')
    const hot = new Map(live.filter(run => run.automationId === id).map(run => [nameOf(run), { ...run }]))
    const archived = await this.list(id), recent = [...hot.keys()].sort().reverse()
    let a = before ? firstAfter(archived, before) : 0, h = before ? firstAfter(recent, before) : 0
    const selected: string[] = []
    while (selected.length <= limit && (a < archived.length || h < recent.length)) {
      const left = archived[a], right = recent[h]
      if (left !== undefined && (right === undefined || left > right)) { selected.push(left); a++ }
      else if (right !== undefined && (left === undefined || right > left)) { selected.push(right); h++ }
      else { selected.push(left!); a++; h++ }
    }
    const more = selected.length > limit
    if (more) selected.pop()
    const data: AutomationRun[] = []
    // At most eight filesystem reads at once; the UI never requests all bodies.
    for (let offset = 0; offset < selected.length; offset += 8) {
      data.push(...await Promise.all(selected.slice(offset, offset + 8).map(name => hot.get(name) ?? this.read(id, name))))
    }
    return { data, nextCursor: more && selected.length ? Buffer.from(selected.at(-1)!).toString('base64url') : null }
  }
}
