import type { IncomingMessage, ServerResponse } from 'node:http'
import { asRecord, getErrorMessage, setJson, type RouteRequestContext } from '../httpUtils.js'
import { readNonEmptyString } from '../runtimePaths.js'
import type { createThreadFileRollbackService } from '../threadFileRollbackService.js'

export function createThreadFileRollbackRoutes(service: ReturnType<typeof createThreadFileRollbackService>) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL, context: RouteRequestContext): Promise<boolean> => {
    if (req.method !== 'POST' || url.pathname !== '/codex-api/thread/rollback-files') return false
    try {
      const body = asRecord(await context.readJsonBody(req))
      const threadId = readNonEmptyString(body?.threadId)
      const turnId = readNonEmptyString(body?.turnId)
      const cwd = readNonEmptyString(body?.cwd)
      const action = readNonEmptyString(body?.action) === 'redo' ? 'redo' : 'undo'
      const scope = readNonEmptyString(body?.scope) === 'single_turn' ? 'single_turn' : 'turn_and_later'
      const patchIds = Array.isArray(body?.patchIds)
        ? new Set(body.patchIds.filter((value): value is string => typeof value === 'string' && value.length > 0))
        : undefined
      if (!threadId || !turnId || !cwd) {
        setJson(res, 400, { error: 'Missing threadId, turnId, or cwd' })
        return true
      }
      setJson(res, 200, await service.rollbackFiles({ threadId, turnId, cwd, action, scope, patchIds }))
    } catch (error) {
      setJson(res, 500, { error: getErrorMessage(error, 'Failed to revert file changes') })
    }
    return true
  }
}
