import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { once } from 'node:events'
import { customConnectionModels, customConnectionEndpoints } from '../customConnections.js'
import type { CustomConnectionStore } from './customConnectionStore.js'
import { handleUnifiedResponsesProxyRequest } from './unifiedResponsesProxy.js'
import { extractUsage } from './apiProxy/usage.js'
import type { TokenUsage } from '../api/proxyUsageTypes.js'

type Connection = NonNullable<ReturnType<CustomConnectionStore['get']>>
export async function forwardCustomConnection(req: IncomingMessage, res: ServerResponse, connection: Connection, path: string, input: Record<string, unknown> | undefined, onUsage: (usage: TokenUsage | null) => void): Promise<void> {
  if (!customConnectionEndpoints(connection).includes(path as any)) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'unsupported_endpoint', message: 'This endpoint is not supported by the selected connection' } }))
    return
  }
  if (path === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ object: 'list', data: customConnectionModels({ ...connection, hasApiKey: true }) }))
    return
  }
  const payload: Record<string, unknown> = { ...input, model: input?.model || connection.model }
  const model = connection.models.find(row => row.id === payload.model)
  if (!model?.efforts?.length) { delete payload.reasoning; delete payload.reasoning_effort }
  if (!model?.serviceTiers?.length) delete payload.service_tier
  if (path === '/v1/responses') {
    const finished = Promise.race([once(res, 'finish'), once(res, 'close')]).catch(() => {})
    handleUnifiedResponsesProxyRequest(req, res, {
      bearerToken: connection.apiKey, wireApi: 'responses',
      responsesEndpoint: `${connection.baseUrl}/responses`, chatCompletionsEndpoint: `${connection.baseUrl}/chat/completions`,
      missingKeyMessage: 'Custom connection API key is missing', allowToolFallbackToResponses: false,
      requestBody: Buffer.from(JSON.stringify(payload)), onPayload: value => { const usage = extractUsage(value); if (usage) onUsage(usage) },
    })
    await finished
    return
  }
  const controller = new AbortController()
  res.once('close', () => { if (!res.writableFinished) controller.abort() })
  const response = await fetch(`${connection.baseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${connection.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60000)]) })
  res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' })
  if (!response.body) { res.end(); return }
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const stream = Readable.fromWeb(response.body as any)
    let pending = ''
    stream.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8')
      let index: number
      while ((index = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, index).trim()
        pending = pending.slice(index + 1)
        if (line.startsWith('data: ')) { try { const usage = extractUsage(JSON.parse(line.slice(6))); if (usage) onUsage(usage) } catch {} }
      }
      if (pending.length > 4 * 1024 * 1024) pending = ''
    })
    stream.on('error', () => res.destroy())
    const finished = Promise.race([once(res, 'finish'), once(res, 'close')]).catch(() => {})
    stream.pipe(res)
    await finished
  } else {
    const text = await response.text()
    try { onUsage(extractUsage(JSON.parse(text))) } catch {}
    res.end(text)
  }
}
