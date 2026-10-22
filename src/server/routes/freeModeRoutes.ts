import type { IncomingMessage, ServerResponse } from 'node:http'
import { createFreeModeService, type FreeModeAction, type FreeModeServiceDependencies } from '../freeModeService.js'
import { setJson, type RouteRequestContext } from '../httpUtils.js'

const actions: Record<string, FreeModeAction> = {
  '/codex-api/free-mode': 'toggle',
  '/codex-api/free-mode/rotate-key': 'rotate',
  '/codex-api/free-mode/custom-key': 'key',
  '/codex-api/free-mode/custom-provider': 'provider',
}

export function createFreeModeRoutes(
  dependencies: FreeModeServiceDependencies,
): (req: IncomingMessage, res: ServerResponse, url: URL, context: RouteRequestContext) => Promise<boolean> {
  const service = createFreeModeService(dependencies)
  return async (req, res, url, context) => {
    if (!url.pathname.startsWith('/codex-api/free-mode')) return false
    if (req.method === 'POST') {
      const result = await service.change(actions[url.pathname] ?? 'unknown', () => context.readJsonBody(req))
      if (!result) return false
      setJson(res, result.statusCode, result.body)
      return true
    }
    if (req.method === 'GET' && url.pathname === '/codex-api/free-mode/status') {
      const result = await service.status()
      setJson(res, result.statusCode, result.body)
      return true
    }
    return false
  }
}
