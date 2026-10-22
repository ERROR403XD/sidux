import type { IncomingMessage, ServerResponse } from 'node:http'
import { getErrorMessage, setJson, type RouteRequestContext } from '../httpUtils.js'

type DeliveryRouteDependencies = {
  backendQueueProcessor: {
    deliveryContext: () => Promise<string>
    readDeliveryStatuses: (threadId: string, ids: string[]) => Promise<unknown>
    submit: (input: unknown) => Promise<Record<string, unknown>>
    mutate: (input: unknown) => Promise<unknown>
  }
}

export function createDeliveryRoutes(
  dependencies: DeliveryRouteDependencies,
): (req: IncomingMessage, res: ServerResponse, url: URL, context: RouteRequestContext) => Promise<boolean> {
  const { backendQueueProcessor } = dependencies

  return async (req, res, url, context) => {
    if (req.method === 'GET' && url.pathname === '/codex-api/delivery-context') {
      setJson(res, 200, { data: { contextId: await backendQueueProcessor.deliveryContext() } })
      return true
    }

    if (req.method === 'GET' && url.pathname === '/codex-api/delivery-status') {
      setJson(res, 200, {
        data: await backendQueueProcessor.readDeliveryStatuses(
          url.searchParams.get('threadId') || '',
          (url.searchParams.get('ids') || '').split(',').filter(Boolean),
        ),
      })
      return true
    }

    if (req.method === 'POST' && url.pathname === '/codex-api/delivery') {
      try {
        const result = await backendQueueProcessor.submit(await context.readJsonBody(req))
        setJson(res, 200, { data: result })
      } catch (error) {
        setJson(res, 409, { error: getErrorMessage(error, '提交消息失败') })
      }
      return true
    }

    if (req.method === 'PUT' && url.pathname === '/codex-api/thread-queue-state') {
      setJson(res, 409, { error: '队列接口已更新，请刷新页面后重试' })
      return true
    }

    if (req.method === 'POST' && url.pathname === '/codex-api/thread-queue-state') {
      const operation = await context.readJsonBody(req)
      try {
        const result = await backendQueueProcessor.mutate(operation)
        setJson(res, 200, { data: result })
      } catch (error) {
        setJson(res, 409, { error: error instanceof Error ? error.message : '队列保存失败' })
      }
      return true
    }

    return false
  }
}
