import type { IncomingMessage, ServerResponse } from 'node:http'
import { setJson } from '../httpUtils.js'
import type { createProviderModelService } from '../providerModelService.js'

export function createProviderModelRoutes(service: ReturnType<typeof createProviderModelService>) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (req.method !== 'GET') return false
    if (url.pathname === '/codex-api/accounts/models') {
      const result = await service.readAccountModels(url.searchParams.get('storageId'))
      if (!result) return false
      setJson(res, 200, result)
      return true
    }
    if (url.pathname !== '/codex-api/provider-models') return false
    setJson(res, 200, await service.readModels(url.searchParams.get('provider')?.trim() ?? ''))
    return true
  }
}
