import { describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { handleUnifiedResponsesProxyRequest } from './unifiedResponsesProxy.js'

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
function proxyFor(port: number, wireApi: 'chat' | 'responses') {
  return createServer((req, res) => handleUnifiedResponsesProxyRequest(req, res, {
    bearerToken: 'fixture-only', wireApi, missingKeyMessage: 'fixture', allowToolFallbackToResponses: false,
    responsesEndpoint: `http://127.0.0.1:${port}/responses`,
    chatCompletionsEndpoint: `http://127.0.0.1:${port}/chat/completions`,
  }))
}
function request(port: number, stream = false) {
  return fetch(`http://127.0.0.1:${port}`, {
    method: 'POST', body: JSON.stringify({ model: 'fixture', input: 'fixture', stream }),
    signal: AbortSignal.timeout(3000),
  })
}

describe('unified provider proxy transport boundaries', () => {
  it.each([1, 2, 3, 4])('preserves Chinese and emoji split into %i-byte network writes', async width => {
    const expected = '你好🌍：const 文件 = "✓"'
    const payload = Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: expected } }] }) + '\r\n\r\ndata: [DONE]\r\n\r\n')
    const upstream = createServer((req, res) => {
      req.resume()
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      void (async () => {
        for (let offset = 0; offset < payload.length; offset += width) {
          res.write(payload.subarray(offset, offset + width))
          await pause(1)
        }
        res.end()
      })()
    })
    const proxy = proxyFor(await listen(upstream), 'chat')
    try {
      const response = await request(await listen(proxy), true)
      expect(response.status).toBe(200)
      const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
      expect(events.filter(event => event.type === 'response.completed')).toHaveLength(1)
      expect(events.find(event => event.type === 'response.completed').response.output[0].content[0].text).toBe(expected)
      expect(events.filter(event => event.type === 'response.output_text.delta').map(event => event.delta).join('')).toBe(expected)
    } finally { await close(proxy); await close(upstream) }
  })

  it.each(['responses', 'chat'] as const)('ends a truncated non-streaming %s response with 502 instead of hanging', async wire => {
    const upstream = createServer((req, res) => {
      req.resume()
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' })
      res.write('{"output":[')
      setTimeout(() => res.destroy(), 20)
    })
    const proxy = proxyFor(await listen(upstream), wire)
    try {
      const port = await listen(proxy)
      // A second request also completes: one failed body must not hold resources.
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await request(port)
        expect(response.status).toBe(502)
        expect(await response.json()).toEqual({ error: { message: 'Upstream response ended before completion' } })
      }
    } finally { await close(proxy); await close(upstream) }
  })
})
