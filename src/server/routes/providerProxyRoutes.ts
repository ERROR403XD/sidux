import type { IncomingMessage, ServerResponse } from 'node:http'
import type { createProviderProxyService } from '../providerProxyService.js'
import { setJson } from '../httpUtils.js'

export function createProviderProxyRoutes(service: ReturnType<typeof createProviderProxyService>) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (req.method !== 'POST') return false
    const runtime = /^\/codex-api\/custom-connections\/runtime\/([a-f0-9]{64})\/(\d+)\/v1\/responses$/.exec(url.pathname)
    const legacy = /^\/codex-api\/(zen|openrouter|custom)-proxy\/v1\/responses$/.exec(url.pathname)
    if (!runtime && !legacy) return false
    const failure = runtime
      ? await service.forwardRuntime(req, res, runtime[1], Number(runtime[2]))
      : service.forwardLegacy(req, res, legacy![1] as 'zen' | 'openrouter' | 'custom')
    if (failure) setJson(res, failure.status, { error: failure.error })
    return true
  }
}
