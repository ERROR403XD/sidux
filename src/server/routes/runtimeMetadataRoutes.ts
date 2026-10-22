import type { IncomingMessage, ServerResponse } from 'node:http'
import { setJson, type RouteRequestContext } from '../httpUtils.js'
import type { createRuntimeMetadataService } from '../runtimeMetadataService.js'

export function createRuntimeMetadataRoutes(service: ReturnType<typeof createRuntimeMetadataService>) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL, context: RouteRequestContext): Promise<boolean> => {
    if (req.method === 'POST' && url.pathname === '/codex-api/server-requests/respond') {
      await service.respondToServerRequest(await context.readJsonBody(req))
      setJson(res, 200, { ok: true })
      return true
    }
    if (req.method !== 'GET') return false
    switch (url.pathname) {
      case '/codex-api/server-requests/pending':
        setJson(res, 200, service.readPendingRequests())
        return true
      case '/codex-api/meta/capabilities':
        setJson(res, 200, { data: await service.readCapabilities() })
        return true
      case '/codex-api/meta/methods':
        setJson(res, 200, { data: await service.readMethods() })
        return true
      case '/codex-api/meta/notifications':
        setJson(res, 200, { data: await service.readNotificationMethods() })
        return true
      case '/codex-api/worker-pools':
        setJson(res, 200, { data: service.readWorkerPools() })
        return true
      case '/codex-api/home-directory':
        setJson(res, 200, { data: service.readHomeDirectory() })
        return true
      default:
        return false
    }
  }
}
