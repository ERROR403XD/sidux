import { parse, stringify } from 'smol-toml'
import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { normalizeAutomationModelSettings, type AutomationModelSettings } from '../automationOptions.js'

export type ThreadAutomationStatus = 'ACTIVE' | 'PAUSED'
export type ThreadAutomationRecord = AutomationModelSettings & {
  id: string
  kind: 'heartbeat' | 'cron'
  name: string
  prompt: string
  rrule: string
  status: ThreadAutomationStatus
  targetThreadId: string | null
  cwds: string[]
  extraTomlLines: string[]
  createdAtMs: number | null
  updatedAtMs: number | null
  nextRunAtMs: number | null
  timezone?: string
}

const knownKeys = new Set(['version', 'id', 'kind', 'name', 'prompt', 'rrule', 'status', 'target_thread_id', 'cwds', 'created_at', 'updated_at', 'model', 'model_reasoning_effort', 'service_tier', 'timezone', 'account_storage_id', 'protected'])

export function parseAutomationToml(raw: string): ThreadAutomationRecord | null {
  try {
    const value = parse(raw)
    const kind = value.kind ?? (value.cwds ? 'cron' : 'heartbeat')
    const status = value.status ?? 'ACTIVE'
    if (!['id', 'name', 'prompt', 'rrule'].every((key) => typeof value[key] === 'string' && String(value[key]).trim())) return null
    if (kind !== 'heartbeat' && kind !== 'cron') return null
    if (status !== 'ACTIVE' && status !== 'PAUSED') return null
    if (value.cwds !== undefined && (!Array.isArray(value.cwds) || !value.cwds.every((cwd) => typeof cwd === 'string'))) return null
    return {
      ...normalizeAutomationModelSettings({ model: value.model, reasoningEffort: value.model_reasoning_effort, serviceTier: value.service_tier, accountStorageId: value.account_storage_id, protected: value.protected }),
      timezone: typeof value.timezone === 'string' ? value.timezone : undefined,
      id: String(value.id), kind, name: String(value.name), prompt: String(value.prompt), rrule: String(value.rrule), status,
      targetThreadId: typeof value.target_thread_id === 'string' ? value.target_thread_id : null,
      cwds: (value.cwds ?? []) as string[],
      extraTomlLines: stringify(Object.fromEntries(Object.entries(value).filter(([key]) => !knownKeys.has(key)))).trim().split('\n').filter(Boolean),
      createdAtMs: typeof value.created_at === 'number' ? value.created_at : null,
      updatedAtMs: typeof value.updated_at === 'number' ? value.updated_at : null,
      nextRunAtMs: null,
    }
  } catch { return null }
}

export function serializeAutomationToml(record: ThreadAutomationRecord): string {
  const extra = record.extraTomlLines.length ? parse(record.extraTomlLines.join('\n')) : {}
  return stringify({
    ...extra, version: 1, id: record.id, kind: record.kind, name: record.name, prompt: record.prompt,
    status: record.status, rrule: record.rrule,
    ...(record.accountStorageId ? { account_storage_id: record.accountStorageId } : {}),
    ...(record.protected !== undefined ? { protected: record.protected } : {}),
    ...(record.model ? { model: record.model } : {}),
    ...(record.serviceTier ? { service_tier: record.serviceTier } : {}),
    ...(record.reasoningEffort ? { model_reasoning_effort: record.reasoningEffort } : {}),
    ...(record.timezone ? { timezone: record.timezone } : {}),
    ...(record.targetThreadId ? { target_thread_id: record.targetThreadId } : {}),
    ...(record.cwds.length ? { cwds: record.cwds } : {}),
    created_at: record.createdAtMs ?? Date.now(), updated_at: record.updatedAtMs ?? Date.now(),
  }) + '\n'
}

export function toAutomationApiRecord(record: ThreadAutomationRecord): Omit<ThreadAutomationRecord, 'extraTomlLines'> {
  const { extraTomlLines: _extra, ...apiRecord } = record
  return apiRecord
}

export async function writeAutomationFileAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}
