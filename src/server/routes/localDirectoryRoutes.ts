import type { IncomingMessage, ServerResponse } from 'node:http'
import { setJson, type RouteRequestContext } from '../httpUtils.js'
import type { createLocalDirectoryService } from '../localDirectoryService.js'

export function createLocalDirectoryRoutes(
  service: ReturnType<typeof createLocalDirectoryService>,
): (req: IncomingMessage, res: ServerResponse, url: URL, context: RouteRequestContext) => Promise<boolean> {
  return async (req, res, url, context) => {
    if (req.method === 'POST' && url.pathname === '/codex-api/local-directory') {
      const result = await service.ensureDirectory(await context.readJsonBody(req))
      setJson(res, result.status, 'error' in result ? { error: result.error } : { data: { path: result.path } })
      return true
    }

    return false
  }
}
