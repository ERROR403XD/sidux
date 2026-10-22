import type { AutomationEngine } from './automationEngine.js'
import { AutomationRequestError } from './automationRequestError.js'

export type AutomationExecuteOutcome = { status: number; body: Record<string, unknown> }

// Maps a POST /automation/execute payload onto the engine's execute entry so the
// HTTP layer stays a thin adapter and the validation rules stay unit-testable.
// The external contract is only { id }: the target and requestId are resolved
// inside the engine, and any extra payload fields are ignored.
export async function executeAutomationByRequest(engine: AutomationEngine, payload: unknown): Promise<AutomationExecuteOutcome> {
  const input = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  // Definitions are addressed by their directory IDs. Do not impose a shorter
  // HTTP-only limit on IDs already accepted by the definition scanner.
  if (!id) return { status: 400, body: { error: '缺少有效的自动化任务 id' } }
  try {
    const run = await engine.execute(id)
    return { status: 200, body: { data: { queued: run.status === 'queued', run } } }
  } catch (error) {
    if (error instanceof AutomationRequestError) {
      return { status: error.status, body: { error: error.message, code: error.code, ...(error.runId ? { runId: error.runId } : {}) } }
    }
    return { status: 500, body: { error: '自动化服务内部错误，请检查服务与存储状态', code: 'internal_error' } }
  }
}
