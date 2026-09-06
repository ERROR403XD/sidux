import type { AutomationRun } from '../server/automationStore'
export { subscribeCodexNotifications } from './codexGateway'
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
