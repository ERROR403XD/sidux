import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { CustomConnectionStore } from './customConnectionStore.js'
import { sanitizeCustomConnectionRequest } from './customConnectionPayload.js'
import { handleResponsesViaProtocolBridge } from './protocolBridgeTransport.js'
import { handleCustomEndpointProxyRequest } from './customEndpointProxy.js'
import { handleZenProxyRequest } from './zenProxy.js'
import { handleOpenRouterProxyRequest } from './openRouterProxy.js'
import { ensureDefaultFreeModeStateForMissingAuthSync } from './appServerRuntimeDependencies.js'
import { FREE_MODE_STATE_FILE } from './freeMode.js'
import { getCodexHomeDir } from './runtimePaths.js'
import { asRecord, readAnyJsonBody } from './httpUtils.js'

type ProxyFailure = { status: number; error: string }
type LegacyProvider = 'zen' | 'openrouter' | 'custom'

function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false
  const normalized = remoteAddress.startsWith('::ffff:')
    ? remoteAddress.slice('::ffff:'.length)
    : remoteAddress
  return normalized === '127.0.0.1' || normalized === '::1'
}

export function createProviderProxyService(connections: () => Pick<CustomConnectionStore, 'get'>) {
  return {
    async forwardRuntime(req: IncomingMessage, res: ServerResponse, storageId: string, revision: number): Promise<ProxyFailure | undefined> {
      const connection = connections().get(storageId)
      if (!isLoopbackRemoteAddress(req.socket.remoteAddress) || !connection || connection.revision !== revision || req.headers.authorization !== `Bearer ${connection.runtimeToken}`) {
        return { status: 409, error: '连接配置已变化，请重新发送' }
      }
      const sanitize = (payload: Record<string, unknown>) => sanitizeCustomConnectionRequest(payload, connection)
      if (connection.wireApi === 'chat') {
        if (!connection.protocolBridge) {
          return { status: 409, error: '该连接仅支持 Chat Completions，可在账号设置中开启协议转换' }
        }
        // The native caller speaks Responses; conversion omits namespace tools.
        const payload = sanitize(asRecord(await readAnyJsonBody(req)) || {})
        await handleResponsesViaProtocolBridge(
          res,
          { baseUrl: connection.baseUrl, apiKey: connection.apiKey, compatOptions: { unsupportedTools: 'omit' } },
          payload,
        )
        return
      }
      handleCustomEndpointProxyRequest(req, res, {
        baseUrl: connection.baseUrl, bearerToken: connection.apiKey, wireApi: connection.wireApi, sanitizeRequest: sanitize,
      })
    },

    forwardLegacy(req: IncomingMessage, res: ServerResponse, provider: LegacyProvider): ProxyFailure | undefined {
      if (provider === 'zen' && !isLoopbackRemoteAddress(req.socket.remoteAddress)) {
        return { status: 403, error: 'Zen proxy is only available from localhost' }
      }
      const statePath = join(getCodexHomeDir(), FREE_MODE_STATE_FILE)
      let bearerToken = ''
      let wireApi: 'responses' | 'chat' = 'responses'
      let baseUrl = ''
      try {
        const state = ensureDefaultFreeModeStateForMissingAuthSync(statePath)
        bearerToken = state?.apiKey ?? ''
        if (provider === 'zen') {
          if (state) wireApi = state.wireApi === 'responses' ? 'responses' : 'chat'
        } else {
          wireApi = state?.wireApi === 'chat' ? 'chat' : 'responses'
        }
        baseUrl = state?.customBaseUrl ?? ''
      } catch { /* use empty */ }
      if (provider === 'zen') {
        handleZenProxyRequest(req, res, bearerToken, wireApi)
      } else if (provider === 'openrouter') {
        handleOpenRouterProxyRequest(req, res, bearerToken, wireApi)
      } else {
        handleCustomEndpointProxyRequest(req, res, { baseUrl, bearerToken, wireApi })
      }
    },
  }
}
