import type { IncomingMessage, ServerResponse } from 'node:http'
import { setJson, type RouteRequestContext } from '../httpUtils.js'
import type { createProjectRootService } from '../projectRootService.js'

export function createProjectRootRoutes(service: ReturnType<typeof createProjectRootService>) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL, context: RouteRequestContext): Promise<boolean> => {
    if (url.pathname !== '/codex-api/project-root') return false
    if (req.method === 'DELETE') {
      const removed = await service.removeRoot(url.searchParams.get('id') ?? '')
      setJson(res, removed ? 200 : 400, removed ? { ok: true } : { error: 'Invalid project' })
      return true
    }
    if (req.method !== 'POST') return false
    const result = await service.saveRoot(await context.readJsonBody(req))
    setJson(res, result.status, result.status === 200 ? { data: { path: result.path } } : { error: result.error })
    return true
  }
}
