import type { IncomingMessage, ServerResponse } from 'node:http'
import { asRecord, setJson, type RouteRequestContext } from '../httpUtils.js'
import type { createWorkspaceService } from '../workspaceStateService.js'

export function createWorkspaceRoutes(
  service: ReturnType<typeof createWorkspaceService>,
): (req: IncomingMessage, res: ServerResponse, url: URL, context: RouteRequestContext) => Promise<boolean> {

  return async (req, res, url, context) => {
    if (req.method === 'GET' && url.pathname === '/codex-api/workspace-roots-state') {
      setJson(res, 200, { data: await service.readState() })
      return true
    }

    if (req.method === 'PUT' && url.pathname === '/codex-api/workspace-roots-state') {
      const record = asRecord(await context.readJsonBody(req))
      if (!record) {
        setJson(res, 400, { error: 'Invalid body: expected object' })
        return true
      }
      await service.saveState(record)
      setJson(res, 200, { ok: true })
      return true
    }

    return false
  }
}
