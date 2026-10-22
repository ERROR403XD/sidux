import type { AutomationRun } from '../server/automationStore'
import type { UiThreadAutomation, UiThreadAutomationStatus } from '../types/codex'
import { extractErrorMessage } from './codexErrors'
import { subscribeRpcNotifications } from './codexRpcClient'

export const subscribeCodexNotifications = subscribeRpcNotifications
export type AutomationRuntimeStatus = {
  ready: boolean; draining: boolean; error: string | null; timezone: string; activeCount: number; queuedCount: number
  definitions: { id: string; error: string | null; timezone?: string; nextRunAtMs?: number | null }[]
}
async function request(path: string, init?: RequestInit) {
  const response = await fetch(path, init)
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error ?? '自动化请求失败')
  return payload
}
export async function getAutomationRuntime(): Promise<AutomationRuntimeStatus> { return (await request('/codex-api/automation-runtime')).data }
export async function getAutomationRuns(id: string, cursor: string | null = null, limit = 5): Promise<{ data: AutomationRun[]; nextCursor: string | null }> {
  const query = new URLSearchParams({ automationId: id, limit: String(limit) })
  if (cursor) query.set('cursor', cursor)
  return request(`/codex-api/automation-runs?${query}`)
}
export async function runAutomationNow(input: { automationId: string; target: string; kind: 'heartbeat' | 'cron'; requestId: string; retryOf?: string }) {
  return request(input.retryOf ? '/codex-api/automation-run/retry' : `/codex-api/${input.kind === 'heartbeat' ? 'thread' : 'project'}-automation/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
}

export function createAutomationRequestId() { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}` }

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asAutomation(record: unknown): UiThreadAutomation | null {
  const row = asRecord(record)
  if (!row) return null
  const id = readString(row.id)
  const kind = readString(row.kind)
  const name = readString(row.name)
  const prompt = readString(row.prompt)
  const rrule = readString(row.rrule)
  const status = readString(row.status)
  if (!id || !name || !prompt || !rrule) return null
  if (kind !== 'heartbeat' && kind !== 'cron') return null
  if (status !== 'ACTIVE' && status !== 'PAUSED') return null
  return {
    id,
    kind,
    name,
    prompt,
    rrule,
    status,
    targetThreadId: readString(row.targetThreadId),
    cwds: Array.isArray(row.cwds) ? row.cwds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [],
    createdAtMs: readNumber(row.createdAtMs),
    updatedAtMs: readNumber(row.updatedAtMs),
    nextRunAtMs: readNumber(row.nextRunAtMs),
    timezone: readString(row.timezone) ?? undefined,
    model: readString(row.model) ?? undefined,
    reasoningEffort: readString(row.reasoningEffort) as UiThreadAutomation['reasoningEffort'],
    serviceTier: readString(row.serviceTier) || undefined,
    accountStorageId: readString(row.accountStorageId) || null,
    protected: row.protected === true,
  }
}

function asAutomationArray(value: unknown): UiThreadAutomation[] {
  if (Array.isArray(value)) return value.flatMap((item) => {
    const automation = asAutomation(item)
    return automation ? [automation] : []
  })
  const automation = asAutomation(value)
  return automation ? [automation] : []
}

export async function getThreadAutomationMap(): Promise<Record<string, UiThreadAutomation[]>> {
  const response = await fetch('/codex-api/thread-automations')
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, 'Failed to load thread automations'))
  }
  const data = asRecord(asRecord(payload)?.data)
  const next: Record<string, UiThreadAutomation[]> = {}
  if (!data) return next
  for (const [threadId, value] of Object.entries(data)) {
    const automations = asAutomationArray(value)
    if (automations.length > 0) next[threadId] = automations
  }
  return next
}

export async function getProjectAutomationMap(): Promise<Record<string, UiThreadAutomation[]>> {
  const response = await fetch('/codex-api/project-automations')
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, 'Failed to load project automations'))
  }
  const data = asRecord(asRecord(payload)?.data)
  const next: Record<string, UiThreadAutomation[]> = {}
  if (!data) return next
  for (const [projectName, value] of Object.entries(data)) {
    const automations = asAutomationArray(value)
    if (automations.length > 0) next[projectName] = automations
  }
  return next
}

export async function getThreadAutomation(threadId: string, automationId?: string): Promise<UiThreadAutomation | null> {
  const query = new URLSearchParams({ threadId })
  if (automationId) query.set('automationId', automationId)
  const response = await fetch(`/codex-api/thread-automation?${query.toString()}`)
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, 'Failed to load thread automation'))
  }
  const data = asRecord(payload)?.data
  if (automationId) return asAutomation(data)
  return asAutomationArray(data)[0] ?? null
}

export async function upsertThreadAutomation(input: {
  threadId: string
  id?: string
  name: string
  prompt: string
  rrule: string
  status: UiThreadAutomationStatus
  accountStorageId?: string | null
  protected?: boolean
  timezone?: string
  model?: string | null
  serviceTier?: string | null
  reasoningEffort?: string | null
}): Promise<UiThreadAutomation> {
  const response = await fetch('/codex-api/thread-automation', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, 'Failed to save thread automation'))
  }
  const automation = asAutomation(asRecord(payload)?.data)
  if (!automation) throw new Error('Thread automation response was malformed')
  return automation
}

export async function upsertProjectAutomation(input: {
  projectName: string
  id?: string
  name: string
  prompt: string
  rrule: string
  status: UiThreadAutomationStatus
  accountStorageId?: string | null
  protected?: boolean
  timezone?: string
  model?: string | null
  serviceTier?: string | null
  reasoningEffort?: string | null
}): Promise<UiThreadAutomation> {
  const response = await fetch('/codex-api/project-automation', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, 'Failed to save project automation'))
  }
  const automation = asAutomation(asRecord(payload)?.data)
  if (!automation) throw new Error('Project automation response was malformed')
  return automation
}

export async function deleteThreadAutomation(threadId: string, automationId?: string): Promise<void> {
  const query = new URLSearchParams({ threadId })
  if (automationId) query.set('automationId', automationId)
  const response = await fetch(`/codex-api/thread-automation?${query.toString()}`, {
    method: 'DELETE',
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, 'Failed to delete thread automation'))
  }
}

export async function deleteProjectAutomation(projectName: string, automationId?: string): Promise<void> {
  const query = new URLSearchParams({ projectName })
  if (automationId) query.set('automationId', automationId)
  const response = await fetch(`/codex-api/project-automation?${query.toString()}`, {
    method: 'DELETE',
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, 'Failed to delete project automation'))
  }
}

export async function runThreadAutomationNow(threadId: string, automationId: string): Promise<void> {
  const response = await fetch('/codex-api/thread-automation/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId, automationId, requestId: createAutomationRequestId() }),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, 'Failed to run thread automation'))
  }
}
