import type { IncomingMessage, ServerResponse } from 'node:http'
import { asRecord, setJson, type RouteRequestContext } from '../httpUtils.js'
import type { createRpcService } from '../rpcService.js'

export type RpcRouteRequestContext = RouteRequestContext & {
  recordRpcRequest?: (payload: unknown) => void
}

export function createRpcRoutes(service: ReturnType<typeof createRpcService>) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL, context: RpcRouteRequestContext): Promise<boolean> => {
    if (req.method !== 'POST' || url.pathname !== '/codex-api/rpc') return false
    const payload = await context.readJsonBody(req)
    context.recordRpcRequest?.(payload)
    const body = asRecord(payload)
    if (!body || typeof body.method !== 'string' || body.method.length === 0) {
      setJson(res, 400, { error: 'Invalid body: expected { method, params? }' })
      return true
    }
    setJson(res, 200, { result: await service.execute(body.method, body.params) })
    return true
  }
}
