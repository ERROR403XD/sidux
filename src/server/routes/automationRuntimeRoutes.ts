import type { IncomingMessage, ServerResponse } from 'node:http'
import { asRecord, setJson, type RouteRequestContext } from '../httpUtils.js'
import type { AutomationRun } from '../automationStore.js'
import type { AutomationExecuteOutcome } from '../automationExecute.js'

type AutomationRuntimeRouteDependencies = {
  appServer: { liveActivity: () => unknown }
  automationEngine: {
    readyPromise: Promise<void>
    snapshot: () => unknown
    historyPage: (automationId: string, cursor: string | null, limit: number) => Promise<unknown>
    drain: (draining?: boolean) => Promise<unknown>
    manual: (automationId: string, target: string, requestId: string, retryOf?: string) => Promise<AutomationRun>
    tick: () => Promise<void>
  }
  scheduledResume?: { drain(value: boolean): Promise<void> }
  executeAutomation: (payload: unknown) => Promise<AutomationExecuteOutcome>
}

function readRunTarget(payload: Record<string, unknown> | null): string {
  return String(payload?.threadId ?? payload?.projectName ?? payload?.target ?? '')
}

export function createAutomationRuntimeRoutes(
  dependencies: AutomationRuntimeRouteDependencies,
): (req: IncomingMessage, res: ServerResponse, url: URL, context: RouteRequestContext) => Promise<boolean> {
  const { appServer, automationEngine, executeAutomation } = dependencies

  return async (req, res, url, context) => {
    if (req.method === 'GET' && url.pathname === '/codex-api/runtime/activity') {
      setJson(res, 200, { data: appServer.liveActivity() })
      return true
    }

    if (req.method === 'GET' && url.pathname === '/codex-api/automation-runtime') {
      await automationEngine.readyPromise
      setJson(res, 200, { data: automationEngine.snapshot() })
      return true
    }

    if (req.method === 'POST' && url.pathname === '/automation/execute') {
      let payload: unknown = null
      try {
        payload = await context.readJsonBody(req)
      } catch {
        setJson(res, 400, { error: '请求体不是有效的 JSON' })
        return true
      }
      const outcome = await executeAutomation(payload)
      setJson(res, outcome.status, outcome.body)
      if (outcome.status === 200) void automationEngine.tick()
      return true
    }

    if (req.method === 'GET' && url.pathname === '/codex-api/automation-runs') {
      setJson(res, 200, await automationEngine.historyPage(
        url.searchParams.get('automationId') ?? '',
        url.searchParams.get('cursor'),
        Number(url.searchParams.get('limit') || 5),
      ))
      return true
    }

    if (req.method === 'POST' && url.pathname === '/codex-api/automation-runtime/drain') {
      const payload = asRecord(await context.readJsonBody(req))
      const draining = payload?.draining !== false
      // The handoff gate also pauses ordinary scheduled continuations.
      await dependencies.scheduledResume?.drain(draining)
      try {
        setJson(res, 200, { data: await automationEngine.drain(draining) })
      } catch (cause) {
        await dependencies.scheduledResume?.drain(false)
        throw cause
      }
      return true
    }

    if (req.method === 'POST' && ['/codex-api/thread-automation/run', '/codex-api/project-automation/run', '/codex-api/automation-run/retry'].includes(url.pathname)) {
      const payload = asRecord(await context.readJsonBody(req))
      const run = await automationEngine.manual(
        String(payload?.automationId ?? ''),
        readRunTarget(payload),
        String(payload?.requestId ?? ''),
        typeof payload?.retryOf === 'string' ? payload.retryOf : undefined,
      )
      setJson(res, 200, { data: { queued: run.status === 'queued', run } })
      void automationEngine.tick()
      return true
    }

    return false
  }
}
