import { describe, it, expect, vi } from 'vitest'
import { sendActivationRequest } from './accountActivationRequest'
const transport = { url: 'http://fixture/responses', headers: { Authorization: 'Bearer fixture' } }
const completed = 'data: {"type":"response.completed","response":{"id":"r","status":"completed"}}\r\n\r\n'
function response(text: string, chunked = false) {
  const bytes = new TextEncoder().encode(text)
  return new Response(new ReadableStream({ start(controller) {
    if (chunked) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
    else controller.enqueue(bytes)
    controller.close()
  } }))
}
describe('minimal activation request', () => {
  it('sends one small stateless request and accepts completion across byte boundaries', async () => {
    const fetcher = vi.fn(async () => response(completed, true))
    await sendActivationRequest(transport, 'gpt-5.6-luna', new AbortController().signal, fetcher)
    expect(fetcher).toHaveBeenCalledOnce()
    const body = JSON.parse((fetcher.mock.calls as any)[0][1].body)
    expect(body).toMatchObject({ store: false, stream: true, tools: [], reasoning: { effort: 'low' } })
    expect(body.input).toEqual([{role:'user',content:[{type:'input_text',text:'hi'}]}])
    expect(JSON.stringify(body).length).toBeLessThan(350)
    expect(body.previous_response_id).toBeUndefined()
  })
  it.each(['data: [DONE]\n\n', 'data: {"type":"response.created"}\n\n', 'data: {"type":"response.failed"}\n\n', 'data: broken\n\n', 'x'.repeat(65537)])('rejects incomplete or oversized streams without retry', async text => {
    const fetcher = vi.fn(async () => response(text))
    await expect(sendActivationRequest(transport, 'model', new AbortController().signal, fetcher)).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('does not surface upstream credential-bearing bodies', async () => {
    const fetcher = vi.fn(async () => new Response('SECRET SENTINEL', {status:401}))
    await expect(sendActivationRequest(transport, 'model', new AbortController().signal, fetcher)).rejects.toThrow('激活请求未完成')
  })
})
