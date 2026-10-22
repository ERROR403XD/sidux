import type { IncomingMessage, ServerResponse } from 'node:http'
import type { createCustomConnectionService } from '../customConnectionService.js'
import { asRecord, getErrorMessage, setJson, type RouteRequestContext } from '../httpUtils.js'

export function createCustomConnectionRoutes(
  service: ReturnType<typeof createCustomConnectionService>,
  switchAccount: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>,
) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL, context: RouteRequestContext): Promise<boolean> => {
    if (url.pathname === '/codex-api/custom-connections' && req.method === 'GET') {
      setJson(res, 200, { data: await service.snapshot() })
      return true
    }
    if (url.pathname.startsWith('/codex-api/custom-connections') && req.method === 'POST') {
      const input = asRecord(await context.readJsonBody(req)) || {}
      const action = url.pathname.endsWith('/test') ? 'test'
        : url.pathname.endsWith('/select') ? 'select'
          : url.pathname.endsWith('/remove') ? 'remove'
            : url.pathname === '/codex-api/custom-connections' ? 'create' : 'save'
      try {
        setJson(res, 200, { data: await service.mutate(action, input) })
      } catch (error) {
        setJson(res, 400, { error: getErrorMessage(error, '连接配置无效') })
      }
      return true
    }
    if (url.pathname === '/codex-api/accounts/switch' && req.method === 'POST' && service.hasActive()) {
      await service.switchToAccount(() => switchAccount(req, res, url))
      return true
    }
    return false
  }
}
