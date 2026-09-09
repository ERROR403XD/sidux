import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAutomationFileAtomic } from './automationDefinition.js'

export type AutomationRunStatus = 'queued' | 'starting' | 'running' | 'waiting_input' | 'completed' | 'failed' | 'interrupted' | 'missed' | 'skipped' | 'cancelled'
export type AutomationRun = {
  runId: string; automationId: string; target: string; kind: 'heartbeat' | 'cron'
  key: string; revision: string; trigger: 'schedule' | 'manual' | 'retry'; scheduledAt: number; timezone: string
  status: AutomationRunStatus; attempt: number; retryOf?: string; retryAfter?: number
  createdAt: number; startedAt: number | null; finishedAt: number | null
  threadId: string | null; turnId: string | null; model: string | null
  serviceTier?: string | null
  reasoningEffort?: string | null
  executionAccountStorageId?: string | null
  errorCode: string | null; error: string | null; submittedAt?: number
}
export type AutomationMetadata = { revision: string; timezone: string; anchor: number; cursor: number; nextRunAtMs: number | null }
export type AutomationState = { version: 1; definitions: Record<string, AutomationMetadata>; runs: AutomationRun[] }
export const isActiveAutomationRun = (run: AutomationRun) => ['starting', 'running', 'waiting_input'].includes(run.status)
export const isPendingAutomationRun = (run: AutomationRun) => run.status === 'queued' || isActiveAutomationRun(run)

async function processIdentity(pid: number): Promise<string | null> {
  try { const text = await readFile(`/proc/${pid}/stat`, 'utf8'); return text.slice(text.lastIndexOf(')') + 2).split(' ')[19] ?? null } catch { return null }
}

// This is a CODEX_HOME lease, not a distributed transaction lock. A reaper mutex
// prevents two recovering processes from removing one another's newly acquired lease.
export class AutomationStore {
  private token = randomUUID()
  private lock: string
  private owned = false
  constructor(readonly directory: string) { this.lock = join(directory, 'scheduler.lock') }
  async acquire(now: number): Promise<boolean> {
    await mkdir(this.directory, { recursive: true })
    const reaper = join(this.directory, 'scheduler.recovery')
    try { await mkdir(reaper) } catch {
      // Recover an interrupted lease acquisition only after a conservative expiry.
      try { if (now - (await stat(reaper)).mtimeMs > 120000) await rm(reaper, { recursive: true, force: true }) } catch { /* another contender recovered it */ }
      return false
    }
    try {
      try {
        const owner = JSON.parse(await readFile(join(this.lock, 'owner.json'), 'utf8'))
        let alive = owner.hostname !== hostname()
        if (!alive) { try { process.kill(owner.pid, 0); alive = !owner.processStart || owner.processStart === await processIdentity(owner.pid) } catch { /* exited */ } }
        const age = now - (await stat(this.lock)).mtimeMs
        if ((owner.hostname === hostname() && !alive) || (owner.hostname !== hostname() && age > 120000)) {
          await rm(this.lock, { recursive: true, force: true })
        } else return false
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        // An incomplete lease belongs to another process until it expires.
        try {
          if (now - (await stat(this.lock)).mtimeMs < 120000) return false
          await rm(this.lock, { recursive: true, force: true })
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      await mkdir(this.lock)
      await writeAutomationFileAtomic(join(this.lock, 'owner.json'), JSON.stringify({ token: this.token, pid: process.pid, processStart: await processIdentity(process.pid), hostname: hostname() }))
      this.owned = true
      return true
    } finally { await rm(reaper, { recursive: true, force: true }) }
  }
  async assertOwnership(): Promise<void> {
    if (!this.owned || JSON.parse(await readFile(join(this.lock, 'owner.json'), 'utf8')).token !== this.token) throw new Error('自动化调度锁已失效')
  }
  async renew(): Promise<void> {
    await this.assertOwnership()
    const { utimes } = await import('node:fs/promises')
    const now = new Date()
    await utimes(this.lock, now, now)
  }
  async read(): Promise<AutomationState> {
    try {
      const value = JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8'))
      const validDefinitions = value?.definitions && typeof value.definitions === 'object' && !Array.isArray(value.definitions)
        && Object.values(value.definitions).every((row: any) => row && typeof row.revision === 'string' && typeof row.timezone === 'string' && Number.isFinite(row.anchor) && Number.isFinite(row.cursor) && (row.nextRunAtMs === null || Number.isFinite(row.nextRunAtMs)))
      const validRuns = Array.isArray(value?.runs) && value.runs.every((row: any) => row && typeof row.runId === 'string' && typeof row.automationId === 'string' && typeof row.target === 'string' && Number.isFinite(row.createdAt) && Number.isFinite(row.scheduledAt) && ['queued', 'starting', 'running', 'waiting_input', 'completed', 'failed', 'interrupted', 'missed', 'skipped', 'cancelled'].includes(row.status))
      if (value?.version !== 1 || !validDefinitions || !validRuns) throw new Error('自动化运行状态文件损坏，请检查 state.json；调度已停止以避免重复执行')
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, definitions: {}, runs: [] }
      throw error
    }
  }
  async write(state: AutomationState): Promise<void> {
    await this.assertOwnership()
    await writeAutomationFileAtomic(join(this.directory, 'state.json'), JSON.stringify(state))
  }
  async release(): Promise<void> {
    if (!this.owned) return
    try { await this.assertOwnership(); await rm(this.lock, { recursive: true, force: true }) } finally { this.owned = false }
  }
}

export function pruneAutomationRuns(runs: AutomationRun[], now: number): AutomationRun[] {
  const counts = new Map<string, number>()
  return [...runs].sort((a, b) => b.createdAt - a.createdAt).filter((run) => {
    if (isPendingAutomationRun(run)) return true
    const count = (counts.get(run.automationId) ?? 0) + 1
    counts.set(run.automationId, count)
    return count <= 100 && now - (run.finishedAt ?? run.createdAt) <= 30 * 86400000
  }).reverse()
}
