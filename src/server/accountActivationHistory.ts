import { appendFile, mkdir, readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { activationClock, type ActivationHistoryPage, type ActivationHistorySlot, type ActivationRun } from '../accountActivation.js'
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

function runTimezone(run: ActivationRun): string {
  try {
    const key = JSON.parse(run.key)
    if (Array.isArray(key) && typeof key[1] === 'string') return key[1]
  } catch { /* Use UTC for legacy records without a schedule key. */ }
  return 'UTC'
}

export class AccountActivationHistory {
  private lastPrunedDay = ''
  private indexes = new Map<string, ActivationHistorySlot[]>()
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

  async record(run: ActivationRun): Promise<void> {
    const date = activationRunDate(run)
    if (date < activationHistoryCutoff(this.now())) return
    // Append only the changed record; never rewrite three months of history per activation.
    await appendFile(join(this.directory, `${date}.jsonl`), `${JSON.stringify(run)}\n`, { encoding: 'utf8', mode: 0o600 })
    const slots = await this.readIndex(date)
    const timezone = runTimezone(run)
    if (!slots.some(slot => slot.scheduledAt === run.scheduledAt && slot.timezone === timezone)) {
      slots.push({ date, scheduledAt: run.scheduledAt, timezone })
      await privateJson(join(this.directory, `${date}.index.json`), slots)
    }
  }

  async prune(): Promise<void> {
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

  private async readIndex(date: string): Promise<ActivationHistorySlot[]> {
    const cached = this.indexes.get(date)
    if (cached) return cached
    let slots: ActivationHistorySlot[]
    try {
      slots = JSON.parse(await readFile(join(this.directory, `${date}.index.json`), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const unique = new Map<string, ActivationHistorySlot>()
      for (const run of await this.readDay(date)) {
        const timezone = runTimezone(run)
        unique.set(`${run.scheduledAt}:${timezone}`, { date, scheduledAt: run.scheduledAt, timezone })
      }
      slots = [...unique.values()]
      await privateJson(join(this.directory, `${date}.index.json`), slots)
    }
    this.indexes.set(date, slots)
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

  async page(requestedPage = 1): Promise<ActivationHistoryPage> {
    const cutoff = activationHistoryCutoff(this.now())
    const dates = (await readdir(this.directory))
      .filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) >= cutoff)
      .map(name => name.slice(0, 10)).sort().reverse()
    const slots: ActivationHistorySlot[] = []
    for (const date of dates) slots.push(...await this.readIndex(date))
    slots.sort((a, b) => b.scheduledAt - a.scheduledAt || a.timezone.localeCompare(b.timezone))
    const page = Math.max(1, Math.min(Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 1, slots.length || 1))
    const slot = slots[page - 1]
    const runs = slot ? (await this.readDay(slot.date)).filter(run => run.scheduledAt === slot.scheduledAt && runTimezone(run) === slot.timezone) : []
    return { slots: structuredClone(slots), page, runs }
  }
}
