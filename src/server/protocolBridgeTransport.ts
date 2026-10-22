import type { ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import {
  ChatToResponsesStreamTranslator,
  ResponsesToChatStreamTranslator,
  SSE_DONE_FRAME,
  chatResponseToResponses,
  encodeSseFrame,
  isBridgeError,
  responsesRequestToChatRequest,
  responsesResponseToChatResponse,
  chatRequestToResponsesRequest,
  type ProviderCompatOptions,
} from '../../protocol-bridge/src/index.js'
import { extractUsage } from './apiProxy/usage.js'
import type { TokenUsage } from '../api/proxyUsageTypes.js'

const DEFAULT_TOTAL_TIMEOUT_MS = 30 * 60_000
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000
const MAX_UPSTREAM_BODY_BYTES = 1024 * 1024

export type ProtocolBridgeUpstream = {
  /** Provider base URL ending at the version root, e.g. https://api.example.com/v1 */
  baseUrl: string
  apiKey: string
  extraHeaders?: Record<string, string>
  totalTimeoutMs?: number
  idleTimeoutMs?: number
  compatOptions?: ProviderCompatOptions
}

export type ProtocolBridgeHooks = {
  /** Receives the final usage numbers when the upstream reports any. */
  onUsage?: (usage: TokenUsage | null) => void
  /** Diagnostic sink; messages carry no prompt or tool-argument content. */
  log?: (message: string) => void
}

function readUpstreamBody(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    stream.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_UPSTREAM_BODY_BYTES) {
        stream.destroy()
        reject(new Error('upstream response body exceeded 1 MiB'))
        return
      }
      chunks.push(chunk)
    })
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

function isEventStream(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').includes('text/event-stream')
}

/**
 * Serve one Responses API request by converting it to Chat Completions,
 * forwarding it upstream, and translating the reply back — streaming when
 * the upstream streams.
 *
 * This is the ONLY place where the main app wires the protocol-bridge to a
 * transport. Cancellation, timeouts and backpressure live here; conversion
 * lives in the component. Errors:
 * - bridge conversion errors before any byte is written → HTTP 400 JSON
 * - upstream HTTP errors → forwarded status + body as-is
 * - network failures → HTTP 502 `Proxy error: <message>`
 * - mid-stream failures → `response.failed` SSE event
 */
export async function handleResponsesViaProtocolBridge(
  res: ServerResponse,
  upstream: ProtocolBridgeUpstream,
  responsesPayload: Record<string, unknown>,
  hooks: ProtocolBridgeHooks = {},
): Promise<void> {
  const log = hooks.log ?? (() => {})
  const startedAt = Date.now()

  let chatRequest
  let warnings
  try {
    const decoded = responsesRequestToChatRequest(responsesPayload, upstream.compatOptions)
    chatRequest = decoded.request
    warnings = decoded.warnings
  } catch (error) {
    if (isBridgeError(error)) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { type: error.code, message: error.message } }))
      return
    }
    throw error
  }
  if (warnings.length > 0) log(`request warnings: ${warnings.map(row => `${row.field} (${row.reason})`).join('; ')}`)

  const controller = new AbortController()
  // Client disconnect cancels the upstream immediately.
  res.once('close', () => { if (!res.writableFinished) controller.abort() })
  const idleTimerMs = upstream.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  let idleTimer: NodeJS.Timeout | null = null
  const refreshIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => controller.abort(), idleTimerMs)
    idleTimer.unref()
  }
  refreshIdle()
  const totalTimer = setTimeout(() => controller.abort(), upstream.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS)
  totalTimer.unref()
  try {
    const chatEndpoint = `${upstream.baseUrl.replace(/\/+$/, '')}/chat/completions`
    const response = await fetch(chatEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(upstream.apiKey ? { Authorization: `Bearer ${upstream.apiKey}` } : {}),
        ...upstream.extraHeaders,
      },
      body: JSON.stringify(chatRequest),
      signal: controller.signal,
    })
    if (!response.ok) {
      // Preserve the upstream error for the caller, like the native proxy does.
      const body = await readUpstreamBody(Readable.fromWeb(response.body as never)).catch(() => Buffer.alloc(0))
      const status = response.status
      res.writeHead(status, { 'Content-Type': response.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' })
      res.end(body.length > 0 ? body : JSON.stringify({ error: { message: `Upstream error ${status}` } }))
      log(`upstream error status=${status} bytes=${body.length} durationMs=${Date.now() - startedAt}`)
      return
    }

    if (isEventStream(response)) {
      await pipeChatSseToResponses(res, response, upstream, hooks, refreshIdle, () => Date.now() - startedAt)
      return
    }

    // Non-streaming upstream reply.
    const body = await readUpstreamBody(Readable.fromWeb(response.body as never))
    hooks.onUsage?.(safeExtractUsage(body))
    const parsed = safeJsonParse(body)
    if (!parsed) {
      const detail = body.toString().slice(0, 500).trim()
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: detail || 'Bad gateway: failed to parse upstream response' } }))
      return
    }
    const requestModel = typeof responsesPayload.model === 'string' ? responsesPayload.model : chatRequest.model
    const { response: responsesResponse } = chatResponseToResponses(parsed, requestModel, upstream.compatOptions)
    if (responsesPayload.stream === true) {
      writeSyntheticStreamingCompletion(res, responsesResponse)
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(responsesResponse))
    }
    log(`upstream json status=200 bytes=${body.length} durationMs=${Date.now() - startedAt}`)
  } catch (error) {
    if (!res.headersSent) {
      const message = error instanceof Error ? error.message : 'unknown error'
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `Proxy error: ${message}` } }))
      return
    }
    if (!res.writableEnded) res.destroy()
    log(`transport failure durationMs=${Date.now() - startedAt}`)
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    clearTimeout(totalTimer)
  }
}

/**
 * Reverse direction: serve one Chat Completions request by converting it to
 * a Responses request, forwarding it to a Responses-native upstream, and
 * translating the reply back into Chat chunks (SSE or JSON). Used for
 * custom connections that only speak Responses and have the protocol
 * bridge toggle enabled.
 */
export async function handleChatViaProtocolBridge(
  res: ServerResponse,
  upstream: ProtocolBridgeUpstream,
  chatPayload: Record<string, unknown>,
  hooks: ProtocolBridgeHooks = {},
): Promise<void> {
  const log = hooks.log ?? (() => {})
  const startedAt = Date.now()

  let responsesRequest
  let warnings
  try {
    const encoded = chatRequestToResponsesRequest(chatPayload)
    responsesRequest = encoded.request
    warnings = encoded.warnings
  } catch (error) {
    if (isBridgeError(error)) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { type: error.code, message: error.message } }))
      return
    }
    throw error
  }
  if (warnings.length > 0) log(`reverse request warnings: ${warnings.map(row => `${row.field} (${row.reason})`).join('; ')}`)

  const controller = new AbortController()
  res.once('close', () => { if (!res.writableFinished) controller.abort() })
  const totalTimer = setTimeout(() => controller.abort(), upstream.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS)
  totalTimer.unref()
  try {
    const responsesEndpoint = `${upstream.baseUrl.replace(/\/+$/, '')}/responses`
    const response = await fetch(responsesEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(upstream.apiKey ? { Authorization: `Bearer ${upstream.apiKey}` } : {}),
        ...upstream.extraHeaders,
      },
      body: JSON.stringify(responsesRequest),
      signal: controller.signal,
    })
    if (!response.ok) {
      const body = await readUpstreamBody(Readable.fromWeb(response.body as never)).catch(() => Buffer.alloc(0))
      const status = response.status
      res.writeHead(status, { 'Content-Type': response.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' })
      res.end(body.length > 0 ? body : JSON.stringify({ error: { message: `Upstream error ${status}` } }))
      log(`reverse upstream error status=${status} durationMs=${Date.now() - startedAt}`)
      return
    }

    if (isEventStream(response)) {
      await pipeResponsesSseToChat(res, response, upstream, hooks, () => Date.now() - startedAt)
      return
    }

    const body = await readUpstreamBody(Readable.fromWeb(response.body as never))
    hooks.onUsage?.(safeExtractUsage(body))
    const parsed = safeJsonParse(body)
    if (!parsed) {
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Bad gateway: failed to parse upstream response' } }))
      return
    }
    const { response: chatResponse } = responsesResponseToChatResponse(parsed)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(chatResponse))
    log(`reverse upstream json status=200 bytes=${body.length} durationMs=${Date.now() - startedAt}`)
  } catch (error) {
    if (!res.headersSent) {
      const message = error instanceof Error ? error.message : 'unknown error'
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `Proxy error: ${message}` } }))
      return
    }
    if (!res.writableEnded) res.destroy()
    log(`reverse transport failure durationMs=${Date.now() - startedAt}`)
  } finally {
    clearTimeout(totalTimer)
  }
}

async function pipeResponsesSseToChat(
  res: ServerResponse,
  response: Response,
  upstream: ProtocolBridgeUpstream,
  hooks: ProtocolBridgeHooks,
  elapsedMs: () => number,
): Promise<void> {
  const upstreamStream = Readable.fromWeb(response.body as never)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  })

  let bytesIn = 0
  let bytesOut = 0
  const log = hooks.log ?? (() => {})
  let paused = false
  const translator = new ResponsesToChatStreamTranslator({
    onChunk: chunk => {
      const frame = encodeSseFrame(chunk)
      bytesOut += Buffer.byteLength(frame)
      paused = !res.write(frame)
      if (paused) upstreamStream.pause()
    },
    onFailure: failure => log(`reverse upstream failure code=${failure.code}`),
  })

  const finishStream = () => {
    translator.finish()
    res.write(SSE_DONE_FRAME)
    res.end()
    const usage = translator.getUsage()
    hooks.onUsage?.(usage ? {
      input: usage.inputTokens,
      output: usage.outputTokens,
      total: usage.totalTokens,
      cached: usage.cachedInputTokens,
      reasoning: usage.reasoningTokens,
    } : null)
    log(`reverse upstream sse bytesIn=${bytesIn} bytesOut=${bytesOut} durationMs=${elapsedMs()}`)
  }

  upstreamStream.on('data', (chunk: Buffer) => {
    bytesIn += chunk.length
    try {
      translator.translateChunk(chunk)
    } catch (error) {
      translator.fail(error)
      upstreamStream.destroy()
      return
    }
    if (paused) {
      paused = false
      upstreamStream.resume()
    }
  })
  upstreamStream.on('end', finishStream)
  upstreamStream.on('error', error => {
    translator.fail(error)
    res.write(SSE_DONE_FRAME)
    res.end()
    log(`reverse upstream stream error durationMs=${elapsedMs()}`)
  })

  await new Promise<void>(resolve => {
    res.once('finish', () => resolve())
    res.once('close', () => resolve())
  })
}

async function pipeChatSseToResponses(
  res: ServerResponse,
  response: Response,
  upstream: ProtocolBridgeUpstream,
  hooks: ProtocolBridgeHooks,
  refreshIdle: () => void,
  elapsedMs: () => number,
): Promise<void> {
  const upstreamStream = Readable.fromWeb(response.body as never)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  })

  let bytesIn = 0
  let bytesOut = 0
  let eventCount = 0
  let paused = false
  const log = hooks.log ?? (() => {})
  const translator = new ChatToResponsesStreamTranslator({
    model: 'unknown',
    compatOptions: upstream.compatOptions,
    onEvent: event => {
      const frame = encodeSseFrame(event)
      bytesOut += Buffer.byteLength(frame)
      eventCount++
      paused = !res.write(frame)
      if (paused) upstreamStream.pause()
    },
  })

  const finishStream = () => {
    translator.finish()
    const usage = translator.getUsage()
    hooks.onUsage?.(usage ? {
      input: usage.inputTokens,
      output: usage.outputTokens,
      total: usage.totalTokens,
      cached: usage.cachedInputTokens,
      reasoning: usage.reasoningTokens,
    } : null)
    res.end()
    log(`upstream sse bytesIn=${bytesIn} bytesOut=${bytesOut} events=${eventCount} durationMs=${elapsedMs()}`)
  }

  upstreamStream.on('data', (chunk: Buffer) => {
    bytesIn += chunk.length
    refreshIdle()
    try {
      translator.translateChunk(chunk)
    } catch (error) {
      // A parser failure must not take down the process; end this request
      // with a protocol failure and drop the upstream.
      translator.fail(error)
      upstreamStream.destroy()
      return
    }
    if (paused) {
      paused = false
      upstreamStream.resume()
    }
  })
  upstreamStream.on('end', finishStream)
  upstreamStream.on('error', error => {
    translator.fail(error)
    res.end()
    log(`upstream stream error durationMs=${elapsedMs()}`)
  })

  await new Promise<void>(resolve => {
    res.once('finish', () => resolve())
    res.once('close', () => resolve())
  })
}

function writeSyntheticStreamingCompletion(res: ServerResponse, response: Record<string, unknown>): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  })
  const output = Array.isArray(response.output) ? response.output : []
  res.write(encodeSseFrame({
    type: 'response.created',
    response: { ...response, status: 'in_progress', output: [] },
  }))
  output.forEach((item, index) => {
    res.write(encodeSseFrame({ type: 'response.output_item.added', output_index: index, item }))
    res.write(encodeSseFrame({ type: 'response.output_item.done', output_index: index, item }))
  })
  res.write(encodeSseFrame({ type: 'response.completed', response }))
  res.end()
}

function safeJsonParse(body: Buffer): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function safeExtractUsage(body: Buffer): TokenUsage | null {
  const parsed = safeJsonParse(body)
  return parsed ? extractUsage(parsed) : null
}
