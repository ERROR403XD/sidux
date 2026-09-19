/**
 * protocol-bridge demo server — manual test harness, NOT part of the shipped app.
 *
 * Serves demo/index.html and one proxy endpoint:
 *
 *   POST /api/chat  { baseUrl, apiKey, model, turns: [{role, content}] }
 *
 * The endpoint builds a Responses API request exactly like a Codex client
 * would, converts it through the protocol bridge to Chat Completions,
 * forwards it to the user-supplied upstream, and streams the bridge's
 * Responses SSE events back to the browser byte-for-byte. Two
 * `bridge.debug.*` events (converted chat request, decode warnings) are
 * prepended for transparency; the browser renders everything it receives.
 *
 * Run from the repo root:  pnpm run bridge:demo   (http://127.0.0.1:4399)
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import {
  ChatToResponsesStreamTranslator,
  chatResponseToResponses,
  encodeSseFrame,
  responsesRequestToChatRequest,
} from '../src/index.js'

const PORT = Number(process.env.PORT) || 4399
const HOST = '127.0.0.1'
const TOTAL_TIMEOUT_MS = 10 * 60_000
const IDLE_TIMEOUT_MS = 2 * 60_000

const here = dirname(fileURLToPath(import.meta.url))
// The bundle runs from demo/dist/, the TS source from demo/ — try both.
const INDEX_CANDIDATES = [join(here, 'index.html'), join(here, '../index.html')]

async function readIndexHtml(): Promise<Buffer> {
  for (const candidate of INDEX_CANDIDATES) {
    const html = await readFile(candidate).catch(() => null)
    if (html) return html
  }
  return Buffer.from('<h1>demo/index.html not found next to the server bundle</h1>')
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

type DemoTurn = { role?: unknown; content?: unknown }

function buildResponsesPayload(model: string, turns: DemoTurn[]): Record<string, unknown> {
  return {
    model,
    stream: true,
    instructions: 'You are a helpful assistant.',
    input: turns.map(turn => ({
      type: 'message',
      role: turn.role === 'assistant' ? 'assistant' : 'user',
      content: [{
        type: turn.role === 'assistant' ? 'output_text' : 'input_text',
        text: String(turn.content ?? ''),
      }],
    })),
  }
}

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { baseUrl?: unknown; apiKey?: unknown; model?: unknown; turns?: unknown }
  try {
    body = JSON.parse(await readBody(req)) as typeof body
  } catch {
    json(res, 400, { error: 'invalid JSON body' })
    return
  }
  const baseUrl = String(body.baseUrl ?? '').trim().replace(/\/+$/, '')
  const apiKey = String(body.apiKey ?? '')
  const model = String(body.model ?? '').trim()
  const turns = Array.isArray(body.turns) ? body.turns as DemoTurn[] : []
  if (!/^https?:\/\//.test(baseUrl) || !model || turns.length === 0) {
    json(res, 400, { error: 'baseUrl、model 和至少一条消息为必填' })
    return
  }

  const responsesPayload = buildResponsesPayload(model, turns)
  let decoded
  try {
    decoded = responsesRequestToChatRequest(responsesPayload)
  } catch (error) {
    json(res, 400, { error: error instanceof Error ? error.message : 'request conversion failed' })
    return
  }

  const controller = new AbortController()
  res.once('close', () => { if (!res.writableFinished) controller.abort() })
  const idleTimer = setInterval(() => controller.abort(), IDLE_TIMEOUT_MS)
  idleTimer.unref()
  const totalTimer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS)
  totalTimer.unref()
  try {
    const upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(decoded.request),
      signal: controller.signal,
    })
    if (!upstream.ok) {
      const detail = (await upstream.text().catch(() => '')).slice(0, 2000)
      json(res, upstream.status, { error: `upstream ${upstream.status}: ${detail || upstream.statusText}` })
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })
    const emit = (payload: unknown) => res.write(encodeSseFrame(payload))
    // Debug frames first: show exactly what the bridge sends upstream.
    emit({ type: 'bridge.debug.chat_request', request: decoded.request })
    if (decoded.warnings.length > 0) emit({ type: 'bridge.debug.warnings', warnings: decoded.warnings })

    const contentType = upstream.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream')) {
      // Non-streaming upstream: convert the final JSON and emit a synthetic
      // Responses completion sequence.
      const text = await upstream.text()
      let parsed: unknown = null
      try { parsed = JSON.parse(text) } catch { /* fall through to error below */ }
      if (!parsed || typeof parsed !== 'object') {
        emit({ type: 'response.failed', response: { status: 'failed', error: { code: 'upstream_error', message: 'upstream returned a non-JSON body' } } })
        res.end()
        return
      }
      const { response } = chatResponseToResponses(parsed, model)
      const output = Array.isArray(response.output) ? response.output as unknown[] : []
      emit({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } })
      output.forEach((item, index) => {
        emit({ type: 'response.output_item.added', output_index: index, item })
        emit({ type: 'response.output_item.done', output_index: index, item })
      })
      emit({ type: 'response.completed', response })
      res.end()
      return
    }

    const upstreamStream = Readable.fromWeb(upstream.body as never)
    const translator = new ChatToResponsesStreamTranslator({
      model,
      onEvent: event => emit(event),
    })
    upstreamStream.on('data', (chunk: Buffer) => {
      try {
        translator.translateChunk(chunk)
      } catch (error) {
        translator.fail(error)
        upstreamStream.destroy()
      }
    })
    upstreamStream.on('end', () => {
      translator.finish()
      res.end()
    })
    upstreamStream.on('error', error => {
      translator.fail(error)
      res.end()
    })
    await new Promise<void>(resolve => {
      res.once('finish', () => resolve())
      res.once('close', () => resolve())
    })
  } finally {
    clearInterval(idleTimer)
    clearTimeout(totalTimer)
  }
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://${HOST}`)
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await readIndexHtml()
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      await handleChat(req, res)
      return
    }
    json(res, 404, { error: 'not found' })
  })().catch(error => {
    if (!res.headersSent) json(res, 500, { error: error instanceof Error ? error.message : 'internal error' })
    else res.destroy()
  })
})

server.listen(PORT, HOST, () => {
  console.log(`[protocol-bridge demo] http://${HOST}:${PORT}`)
  console.log('Open the page, fill in Base URL / API key / Model, and chat.')
  console.log('No provider at hand? Start the bundled mock: node protocol-bridge/demo/mock-upstream.mjs (port 4398).')
})
