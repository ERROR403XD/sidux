import type { IncomingMessage, ServerResponse } from 'node:http'
import { setJson, type RouteRequestContext } from '../httpUtils.js'
import type { createProjectDiscoveryService } from '../projectDiscoveryService.js'

export function createProjectDiscoveryRoutes(
  service: ReturnType<typeof createProjectDiscoveryService>,
): (req: IncomingMessage, res: ServerResponse, url: URL, context: RouteRequestContext) => Promise<boolean> {
  return async (req, res, url, context) => {
    if (req.method === 'GET' && url.pathname === '/codex-api/project-root-suggestion') {
      const result = await service.suggestRoot(url.searchParams.get('basePath')?.trim() ?? '')
      setJson(res, result.status, 'error' in result ? { error: result.error } : { data: result.data })
      return true
    }

    if (req.method === 'POST' && url.pathname === '/codex-api/composer-file-search') {
      const result = await service.searchFiles(await context.readJsonBody(req))
      setJson(res, result.status, 'error' in result ? { error: result.error } : { data: result.data })
      return true
    }

    return false
  }
}
