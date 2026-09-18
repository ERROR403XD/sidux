/**
 * Mock Chat Completions upstream for trying the demo without a real provider.
 * Streams: role chunk → reasoning_content → text (5 deltas) → tool call
 * (arguments across 3 chunks) → finish_reason=tool_calls → trailing usage.
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
    let asked = ''
    try { asked = JSON.parse(body).messages?.at(-1)?.content ?? '' } catch {}
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    res.write(chunk({ role: 'assistant', content: '' }))
    res.write(chunk({ reasoning_content: `收到「${asked}」，先思考一下。` }))
    const words = ['你好！', '这是 ', 'protocol-bridge ', '演示回复，', '来自 mock 上游。']
    for (const word of words) res.write(chunk({ content: word }))
    if (/工具|tool|shell/i.test(asked)) {
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
