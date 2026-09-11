/** One minimal generation, no retries, session files, tools or conversation history. */
export async function sendActivationRequest(transport: { url: string; headers: Record<string, string> }, model: string, signal: AbortSignal, fetchImpl = fetch): Promise<void> {
  const response = await fetchImpl(transport.url, {
    method: 'POST', headers: transport.headers, signal,
    body: JSON.stringify({ model, stream: true, store: false, instructions: 'Reply briefly.',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      reasoning: { effort: 'low' }, service_tier: 'default', tools: [],
    }),
  })
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {})
    throw new Error('激活请求未完成，不自动重发')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let bytes = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 65536) throw new Error('激活响应超出限制，不自动重发')
      buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n')
      let index: number
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!data || data === '[DONE]') continue
        let event: { type?: string; response?: { status?: string; id?: string } }
        try { event = JSON.parse(data) } catch { throw new Error('激活响应无效，不自动重发') }
        if (event.type === 'response.completed' && event.response?.status === 'completed' && event.response.id) return
        if (['error', 'response.failed', 'response.incomplete'].includes(event.type || '')) throw new Error('激活请求未完成，不自动重发')
      }
    }
    throw new Error('激活响应中断，结果未知，不自动重发')
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
