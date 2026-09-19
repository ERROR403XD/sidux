/**
 * Mock Chat Completions upstream for trying the demo without a real provider.
 * Streams: role chunk → reasoning_content → text (5 deltas) → tool call
 * (arguments across 3 chunks) → finish_reason=tool_calls → trailing usage.
 * Non-streaming probes (stream:false) get a plain JSON chat completion, and
 * /models is matched by suffix so <baseUrl>/v1/models works.
 *
 * Run:  node protocol-bridge/demo/mock-upstream.mjs   (port 4398)
 * Then in the demo page use Base URL http://127.0.0.1:4398/v1, any key/model.
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT) || 4398
const frame = payload => `data: ${JSON.stringify(payload)}\n\n`
const chunk = (delta, finish = null) => frame({
  id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1726000000, model: 'mock-model',
  choices: [{ index: 0, delta, finish_reason: finish }],
})

createServer((req, res) => {
  let body = ''
  req.on('data', data => { body += data })
  req.on('end', () => {
    if ((req.url || '').endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model' }] }))
      return
    }
    let parsed = {}
    let asked = ''
    let toolRequested = false
    try {
      parsed = JSON.parse(body)
      const messages = Array.isArray(parsed.messages) ? parsed.messages : []
      const lastUser = [...messages].reverse().find(message => message && message.role === 'user')
      const lastUserText = typeof lastUser?.content === 'string'
        ? lastUser.content
        : Array.isArray(lastUser?.content)
          ? lastUser.content.map(part => part?.text || '').join('')
          : ''
      asked = lastUserText || parsed.input || ''
      // Offer a tool call only on the first round: once a tool output exists
      // in the conversation, finish normally so the agent loop terminates.
      toolRequested = !messages.some(message => message && message.role === 'tool') && /工具|tool|shell/i.test(asked)
    } catch {}
    if (parsed.stream === false) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-mock', object: 'chat.completion', created: 1726000000, model: 'mock-model',
        choices: [{ index: 0, message: { role: 'assistant', content: '你好！这是 protocol-bridge 演示回复。' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
      }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    res.write(chunk({ role: 'assistant', content: '' }))
    res.write(chunk({ reasoning_content: `收到「${asked}」，先思考一下。` }))
    const words = ['你好！', '这是 ', 'protocol-bridge ', '演示回复，', '来自 mock 上游。']
    for (const word of words) res.write(chunk({ content: word }))
    if (toolRequested) {
      res.write(chunk({ tool_calls: [{ index: 0, id: 'call_mock', type: 'function', function: { name: 'shell', arguments: '' } }] }))
      res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"command":' } }] }))
      res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: '"echo hi"}' } }] }))
      res.write(chunk({}, 'tool_calls'))
    } else {
      res.write(chunk({}, 'stop'))
    }
    res.write(frame({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1726000000, model: 'mock-model', choices: [], usage: { prompt_tokens: 21, completion_tokens: 18, total_tokens: 39 } }))
    res.end('data: [DONE]\n\n')
  })
}).listen(PORT, '127.0.0.1', () => console.log(`[mock chat upstream] http://127.0.0.1:${PORT}/v1`))
