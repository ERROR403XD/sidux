import type { IncomingMessage, ServerResponse } from 'node:http'
import { setJson, type RouteRequestContext } from '../httpUtils.js'
import type { createProjectAccessService } from '../projectAccessService.js'

export function createProjectRoutes(
  service: ReturnType<typeof createProjectAccessService>,
): (req: IncomingMessage, res: ServerResponse, url: URL, context: RouteRequestContext) => Promise<boolean> {
  return async (req, res, url, context) => {
    if (req.method === 'GET' && url.pathname === '/codex-api/project-files') {
      const render = await service.prepareFilesListing(url.searchParams.get('id') ?? '')
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(await render())
      return true
    }

    if (req.method === 'GET' && url.pathname === '/codex-api/project-directories') {
      const result = await service.directories(url.searchParams.get('path') ?? '')
      setJson(res, result.status, 'error' in result ? { error: result.error } : { data: result.data })
      return true
    }

    if (req.method === 'POST' && url.pathname === '/codex-api/project-membership') {
      await service.assignMembership(await context.readJsonBody(req))
      setJson(res, 200, { ok: true })
      return true
    }

    return false
  }
}
