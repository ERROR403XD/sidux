import type { IncomingMessage, ServerResponse } from 'node:http'
import { asRecord, setJson, type RouteRequestContext } from '../httpUtils.js'
import type { WebUiBrandingStore } from '../webUiBrandingStore.js'

export function createBrandingRoutes(store: () => Pick<WebUiBrandingStore, 'save'>) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL, context: RouteRequestContext): Promise<boolean> => {
    if (req.method !== 'POST' || url.pathname !== '/codex-api/webui-branding') return false
    try {
      const input = asRecord(await context.readJsonBody(req)) || {}
      setJson(res, 200, { data: await store().save(input) })
    } catch (error) {
      setJson(res, 400, { error: error instanceof Error ? error.message : '保存失败' })
    }
    return true
  }
}
