import { appendFile, mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { activationClock, activationRunTimezone, type ActivationHistoryPage, type ActivationHistorySlot, type ActivationRun } from '../accountActivation.js'
import { privateJson } from './apiProxy/store.js'

export function activationHistoryCutoff(now: number): string {
  const date = new Date(now)
  const day = date.getUTCDate()
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() - 3)
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
  date.setUTCDate(Math.min(day, lastDay))
  return date.toISOString().slice(0, 10)
}

export function activationRunDate(run: ActivationRun): string {
  try {
    const key = JSON.parse(run.key)
    if (Array.isArray(key) && typeof key[2] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(key[2])) return key[2]
    if (Array.isArray(key) && typeof key[1] === 'string') return activationClock(key[1])(run.scheduledAt).date
  } catch { /* Legacy records may not carry a schedule timezone. */ }
  return new Date(run.scheduledAt).toISOString().slice(0, 10)
}

type HistoryIndex = { version: 1; bytes: number; mtimeMs: number; slots: ActivationHistorySlot[] }

export class AccountActivationHistory {
  private static readonly pageSize = 5
  private lastPrunedDay = ''
  private indexes = new Map<string, HistoryIndex>()
  private operations: Promise<unknown> = Promise.resolve()
  constructor(private directory: string, private now = Date.now) {}

  async initialize(legacy: ActivationRun[]): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await this.prune()
    const cutoff = activationHistoryCutoff(this.now())
    const days = new Map<string, ActivationRun[]>()
    for (const run of legacy) {
      const date = activationRunDate(run)
      if (date < cutoff) continue
      const rows = days.get(date) || []
      rows.push(run)
      days.set(date, rows)
    }
    for (const [date, runs] of days) {
      const existing = new Map((await this.readDay(date)).map(run => [run.key, run]))
      for (const run of runs) {
        if (JSON.stringify(existing.get(run.key)) !== JSON.stringify(run)) await this.record(run)
      }
    }
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.operations.then(action)
    this.operations = next.catch(() => {})
    return next
  }

  record(run: ActivationRun): Promise<void> {
    return this.serial(() => this.recordNow(run))
  }

  private async recordNow(run: ActivationRun): Promise<void> {
    const date = activationRunDate(run)
    if (date < activationHistoryCutoff(this.now())) return
    const slots = [...await this.readIndex(date)]
    // A separator also isolates any incomplete final line left by an interrupted append.
    await appendFile(join(this.directory, `${date}.jsonl`), `\n${JSON.stringify(run)}\n`, { encoding: 'utf8', mode: 0o600 })
    const timezone = activationRunTimezone(run)
    if (!slots.some(slot => slot.scheduledAt === run.scheduledAt && slot.timezone === timezone)) {
      slots.push({ date, scheduledAt: run.scheduledAt, timezone })
    }
    await this.writeIndex(date, slots, await this.sourceStamp(date))
  }

  prune(): Promise<void> {
    return this.serial(() => this.pruneNow())
  }

  private async pruneNow(): Promise<void> {
    const today = new Date(this.now()).toISOString().slice(0, 10)
    if (today === this.lastPrunedDay) return
    const cutoff = activationHistoryCutoff(this.now())
    for (const name of await readdir(this.directory)) {
      if (/^\d{4}-\d{2}-\d{2}\.(jsonl|index\.json)$/.test(name) && name.slice(0, 10) < cutoff) {
        await unlink(join(this.directory, name))
        this.indexes.delete(name.slice(0, 10))
      }
    }
    this.lastPrunedDay = today
  }

  private async sourceStamp(date: string): Promise<{ bytes: number; mtimeMs: number }> {
    try {
      const source = await stat(join(this.directory, `${date}.jsonl`))
      return { bytes: source.size, mtimeMs: source.mtimeMs }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { bytes: 0, mtimeMs: 0 }
    }
  }

  private async writeIndex(date: string, slots: ActivationHistorySlot[], stamp: { bytes: number; mtimeMs: number }): Promise<void> {
    const index: HistoryIndex = { version: 1, ...stamp, slots }
    await privateJson(join(this.directory, `${date}.index.json`), index)
    this.indexes.set(date, index)
  }

  private async readIndex(date: string): Promise<ActivationHistorySlot[]> {
    const stamp = await this.sourceStamp(date)
    const matches = (index: HistoryIndex) => index.version === 1 && index.bytes === stamp.bytes && index.mtimeMs === stamp.mtimeMs && Array.isArray(index.slots)
    const cached = this.indexes.get(date)
    if (cached && matches(cached)) return cached.slots
    try {
      const index = JSON.parse(await readFile(join(this.directory, `${date}.index.json`), 'utf8')) as HistoryIndex
      if (index && matches(index)) {
        this.indexes.set(date, index)
        return index.slots
      }
    } catch (error) {
      // The index is derived data. Old array indexes and truncated files can be rebuilt.
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const unique = new Map<string, ActivationHistorySlot>()
    for (const run of await this.readDay(date)) {
      const timezone = activationRunTimezone(run)
      unique.set(`${run.scheduledAt}:${timezone}`, { date, scheduledAt: run.scheduledAt, timezone })
    }
    const slots = [...unique.values()]
    await this.writeIndex(date, slots, stamp)
    return slots
  }

  private async readDay(date: string): Promise<ActivationRun[]> {
    let text: string
    try {
      text = await readFile(join(this.directory, `${date}.jsonl`), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const runs = new Map<string, ActivationRun>()
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const run = JSON.parse(line) as ActivationRun
        if (typeof run.key === 'string' && Number.isFinite(run.scheduledAt)) runs.set(run.key, run)
      } catch { /* An interrupted final append must not hide earlier complete records. */ }
    }
    return [...runs.values()].sort((a, b) => b.scheduledAt - a.scheduledAt || a.accountId.localeCompare(b.accountId))
  }

  page(requestedPage = 1): Promise<ActivationHistoryPage> {
    return this.serial(() => this.pageNow(requestedPage))
  }

  private async pageNow(requestedPage: number): Promise<ActivationHistoryPage> {
    const cutoff = activationHistoryCutoff(this.now())
    const dates = (await readdir(this.directory))
      .filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) >= cutoff)
      .map(name => name.slice(0, 10)).sort().reverse()
    const slots: ActivationHistorySlot[] = []
    for (const date of dates) slots.push(...await this.readIndex(date))
    slots.sort((a, b) => b.scheduledAt - a.scheduledAt || a.timezone.localeCompare(b.timezone))
    const pageCount = Math.max(1, Math.ceil(slots.length / AccountActivationHistory.pageSize))
    const page = Math.max(1, Math.min(Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 1, pageCount))
    const selected = slots.slice((page - 1) * AccountActivationHistory.pageSize, page * AccountActivationHistory.pageSize)
    const days = new Map(selected.map(slot => [slot.date, [] as ActivationRun[]]))
    await Promise.all([...days.keys()].map(async date => {
      days.set(date, (await this.readDay(date)).filter(run => selected.some(slot => slot.date === date && slot.scheduledAt === run.scheduledAt && slot.timezone === activationRunTimezone(run))))
    }))
    const runs = [...days.values()].flat().sort((a, b) => b.scheduledAt - a.scheduledAt || a.accountId.localeCompare(b.accountId))
    return { slots: structuredClone(selected), page, pageCount, runs: structuredClone(runs) }
  }
}
