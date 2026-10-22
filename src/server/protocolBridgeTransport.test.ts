import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { handleChatViaProtocolBridge, handleResponsesViaProtocolBridge } from './protocolBridgeTransport'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
})

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return (server.address() as { port: number }).port
}

function bridgeServer(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Server {
  const server = createServer(handler)
  servers.push(server)
  return server
}

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

async function postResponses(port: number, body: unknown): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value })
  return { status: response.status, headers, text: await response.text() }
}

describe('protocol bridge transport', () => {
  it('converts a streamed chat reply into Responses SSE events', async () => {
    const upstreamCapture: { body: Record<string, unknown> | null } = { body: null }
    const upstreamPort = await listen(bridgeServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        upstreamCapture.body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(sseFrame({ id: 'chatcmpl-x', model: 'up-model', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }))
        res.write(sseFrame({ id: 'chatcmpl-x', model: 'up-model', choices: [{ index: 0, delta: { reasoning_content: 'think' }, finish_reason: null }] }))
        res.write(sseFrame({ id: 'chatcmpl-x', model: 'up-model', choices: [{ index: 0, delta: { content: 'Hi ' }, finish_reason: null }] }))
        res.write(sseFrame({ id: 'chatcmpl-x', model: 'up-model', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'shell', arguments: '{"cmd":' } }] }, finish_reason: null }] }))
        res.write(sseFrame({ id: 'chatcmpl-x', model: 'up-model', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }, finish_reason: null }] }))
        res.write(sseFrame({ id: 'chatcmpl-x', model: 'up-model', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }))
        res.write(sseFrame({ id: 'chatcmpl-x', model: 'up-model', choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }))
        res.end('data: [DONE]\n\n')
      })
    }))
    const usages: Array<Record<string, unknown> | null> = []
    const appPort = await listen(bridgeServer((req, res) => {
      void readJson(req).then(payload => handleResponsesViaProtocolBridge(res, {
        baseUrl: `http://127.0.0.1:${upstreamPort}`,
        apiKey: 'fixture-key',
      }, payload, { onUsage: usage => { usages.push(usage as unknown as Record<string, unknown>) } }))
    }))

    const result = await postResponses(appPort, {
      model: 'up-model',
      stream: true,
      instructions: 'Be brief.',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }],
    })

    expect(result.status).toBe(200)
    expect(result.headers['content-type']).toContain('text/event-stream')
    const events = result.text.split('\n\n').filter(Boolean).map(row => JSON.parse(row.slice(6)) as Record<string, unknown>)
    expect(events.map(event => event.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.reasoning_summary_part.added',
      'response.reasoning_summary_text.delta',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.delta',
      'response.reasoning_summary_text.done',
      'response.reasoning_summary_part.done',
      'response.output_item.done',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed',
    ])
    const completed = events.at(-1)!
    const response = completed.response as Record<string, unknown>
    expect(response.usage).toMatchObject({ input_tokens: 7, output_tokens: 3, total_tokens: 10 })
    expect((response.output as Array<Record<string, unknown>>).map(item => item.type)).toEqual(['reasoning', 'message', 'function_call'])
    expect(usages.at(-1)).toMatchObject({ input: 7, output: 3, total: 10 })

    // The upstream received a Chat Completions request, not a Responses one.
    expect(upstreamCapture.body).toMatchObject({
      model: 'up-model',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'hi' },
      ],
      stream: true,
      stream_options: { include_usage: true },
    })
    expect(Array.isArray((upstreamCapture.body as Record<string, unknown>).tools)).toBe(true)
  }, 15000)

  it('synthesizes a streaming completion from a non-streaming upstream reply', async () => {
    const upstreamPort = await listen(bridgeServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'chatcmpl-y',
          created: 1726000000,
          model: 'up-model',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }))
      })
    }))
    const appPort = await listen(bridgeServer((req, res) => {
      void readJson(req).then(payload => handleResponsesViaProtocolBridge(res, { baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: 'k' }, payload))
    }))

    const result = await postResponses(appPort, { model: 'up-model', stream: true, input: 'hi' })
    expect(result.status).toBe(200)
    const events = result.text.split('\n\n').filter(Boolean).map(row => JSON.parse(row.slice(6)) as Record<string, unknown>)
    expect(events[0]!.type).toBe('response.created')
    expect(events.at(-1)!.type).toBe('response.completed')
    expect((events.at(-1)!.response as Record<string, unknown>).output).toEqual([
      { type: 'message', id: expect.stringMatching(/^msg_/), status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'done', annotations: [] }] },
    ])
  }, 15000)

  it('forwards upstream HTTP errors with their original status and body', async () => {
    const upstreamPort = await listen(bridgeServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(429, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'rate limited by provider', code: 'rate_limit' } }))
      })
    }))
    const appPort = await listen(bridgeServer((req, res) => {
      void readJson(req).then(payload => handleResponsesViaProtocolBridge(res, { baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: 'k' }, payload))
    }))

    const result = await postResponses(appPort, { model: 'up-model', stream: true, input: 'hi' })
    expect(result.status).toBe(429)
    expect(JSON.parse(result.text)).toEqual({ error: { message: 'rate limited by provider', code: 'rate_limit' } })
  }, 15000)

  it('rejects unconvertible requests with a 400 bridge error before contacting upstream', async () => {
    let upstreamTouched = false
    const upstreamPort = await listen(bridgeServer((req, res) => { upstreamTouched = true; res.destroy() }))
    const appPort = await listen(bridgeServer((req, res) => {
      void readJson(req).then(payload => handleResponsesViaProtocolBridge(res, { baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: 'k' }, payload))
    }))

    const result = await postResponses(appPort, {
      model: 'up-model',
      input: 'hi',
      tools: [{ type: 'web_search' }],
    })
    expect(result.status).toBe(400)
    expect(JSON.parse(result.text)).toMatchObject({ error: { type: 'unsupported_feature' } })
    expect(upstreamTouched).toBe(false)
  }, 15000)

  it('aborts the upstream request when the client disconnects mid-stream', async () => {
    let upstreamAborted = false
    const upstreamPort = await listen(bridgeServer((req, res) => {
      req.on('close', () => { upstreamAborted = true })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(sseFrame({ id: 'c', model: 'm', choices: [{ index: 0, delta: { content: 'first' }, finish_reason: null }] }))
      // Never finishes on its own; the client disconnect must end it.
    }))
    const appPort = await listen(bridgeServer((req, res) => {
      void readJson(req).then(payload => handleResponsesViaProtocolBridge(res, { baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: 'k', idleTimeoutMs: 60_000 }, payload))
    }))

    const response = await fetch(`http://127.0.0.1:${appPort}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm', stream: true, input: 'hi' }),
      signal: AbortSignal.timeout(10_000),
    })
    expect(response.status).toBe(200)
    // Read a little, then abort the client side.
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()
    for (let index = 0; index < 100 && !upstreamAborted; index++) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    expect(upstreamAborted).toBe(true)
  }, 15000)

  it('serves a chat request from a Responses-native upstream in the reverse direction', async () => {
    let upstreamRequest: Record<string, unknown> | null = null
    let upstreamPath = ''
    const upstreamPort = await listen(bridgeServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        upstreamPath = req.url || ''
        upstreamRequest = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(sseFrame({ type: 'response.created', response: { id: 'resp_1', model: 'gpt-5' } }))
        res.write(sseFrame({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, delta: 'Hello ' }))
        res.write(sseFrame({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, delta: 'from responses' }))
        res.write(sseFrame({ type: 'response.completed', response: { id: 'resp_1', model: 'gpt-5', output: [], usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } }))
        res.end()
      })
    }))
    const usages: Array<Record<string, unknown> | null> = []
    const appPort = await listen(bridgeServer((req, res) => {
      void readJson(req).then(payload => handleChatViaProtocolBridge(res, { baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: 'k' }, payload, { onUsage: usage => { usages.push(usage as unknown as Record<string, unknown>) } }))
    }))

    const response = await fetch(`http://127.0.0.1:${appPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5', stream: true, messages: [{ role: 'user', content: 'hi' }], max_tokens: 64 }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const text = await response.text()
    const frames = text.split('\n\n').filter(Boolean).map(row => row.slice(6))
    expect(frames.at(-1)).toBe('[DONE]')
    const chunks = frames.slice(0, -1).map(row => JSON.parse(row) as Record<string, unknown>)
    const finish = chunks.find(chunk => (chunk.choices as Array<{ finish_reason?: unknown }> | undefined)?.[0]?.finish_reason)
    expect((finish!.choices as Array<{ finish_reason: string }>)[0]!.finish_reason).toBe('stop')
    const usageChunk = chunks.find(chunk => Array.isArray(chunk.choices) && (chunk.choices as unknown[]).length === 0)
    expect(usageChunk).toMatchObject({ usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })
    const content = chunks
      .map(chunk => (chunk.choices as Array<{ delta: Record<string, unknown> }> | undefined)?.[0]?.delta)
      .filter(delta => delta && typeof delta.content === 'string' && delta.content)
      .map(delta => delta!.content as string)
      .join('')
    expect(content).toBe('Hello from responses')
    expect(usages.at(-1)).toMatchObject({ input: 4, output: 2, total: 6 })
    // The upstream received a Responses request converted from the chat one.
    expect(upstreamPath).toBe('/responses')
    expect(upstreamRequest).toMatchObject({ model: 'gpt-5', max_output_tokens: 64, stream: true })
  }, 15000)
})

async function readJson(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}
