import { describe, expect, it } from 'vitest'
import { responsesRequestToChatRequest } from '../../src/chat/requestDecoder.js'
import { UnsupportedFeatureError } from '../../src/errors.js'

describe('responsesRequestToChatRequest', () => {
  it('converts a Codex-shaped request: instructions, messages, tools, reasoning', () => {
    const { request, warnings } = responsesRequestToChatRequest({
      model: 'deepseek-chat',
      instructions: 'You are Codex.',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] },
      ],
      tools: [
        { type: 'function', name: 'shell', description: 'Run a shell command', parameters: { type: 'object' }, strict: false },
      ],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      reasoning: { effort: 'high', summary: 'auto' },
      temperature: 0.2,
      top_p: 0.9,
      max_output_tokens: 512,
      stream: true,
      store: false,
      prompt_cache_key: 'abc',
    })

    expect(request).toEqual({
      model: 'deepseek-chat',
      messages: [{ role: 'system', content: 'You are Codex.' }, { role: 'user', content: 'list files' }],
      stream: true,
      stream_options: { include_usage: true },
      tools: [{ type: 'function', function: { name: 'shell', description: 'Run a shell command', parameters: { type: 'object' }, strict: false } }],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      reasoning_effort: 'high',
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 512,
    })
    expect(warnings.map(row => row.field)).toEqual(['reasoning.summary', 'prompt_cache_key'])
  })

  it('maps the full agent tool loop: function_call, function_call_output, replayed reasoning', () => {
    const { request } = responsesRequestToChatRequest({
      model: 'm',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run pwd' }] },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'need pwd' }] },
        { type: 'function_call', call_id: 'call_a1', name: 'shell', arguments: '{"cmd":"pwd"}' },
        { type: 'function_call_output', call_id: 'call_a1', output: '/repo' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
        { type: 'message', role: 'user', content: 'again' },
      ],
    })
    expect(request.messages).toEqual([
      { role: 'user', content: 'run pwd' },
      { role: 'assistant', content: '', reasoning_content: 'need pwd', tool_calls: [{ id: 'call_a1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"pwd"}' } }] },
      { role: 'tool', tool_call_id: 'call_a1', content: '/repo' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'again' },
    ])
  })

  it('accepts a plain string input', () => {
    const { request } = responsesRequestToChatRequest({ model: 'm', input: 'hello' })
    expect(request.messages).toEqual([{ role: 'user', content: 'hello' }])
    expect(request.stream).toBeUndefined()
  })

  it('maps developer role to system and inverts tool_choice', () => {
    const { request } = responsesRequestToChatRequest({
      model: 'm',
      input: [
        { type: 'message', role: 'developer', content: 'be careful' },
        { type: 'message', role: 'user', content: 'hi' },
      ],
      tool_choice: { type: 'function', name: 'shell' },
    })
    expect(request.messages[0]).toEqual({ role: 'system', content: 'be careful' })
    expect(request.tool_choice).toEqual({ type: 'function', function: { name: 'shell' } })
  })

  it('converts inline image parts to chat image_url parts', () => {
    const { request } = responsesRequestToChatRequest({
      model: 'm',
      input: [
        { type: 'message', role: 'user', content: [
          { type: 'input_text', text: 'what is this' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        ] },
      ],
    })
    expect(request.messages[0]!.content).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ])
  })

  it('maps text.format json_schema to response_format', () => {
    const { request } = responsesRequestToChatRequest({
      model: 'm',
      input: 'hi',
      text: { format: { type: 'json_schema', name: 'out', schema: { type: 'object' }, strict: true } },
    })
    expect(request.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'out', schema: { type: 'object' }, strict: true },
    })
  })

  it('honors the max_completion_tokens compat option', () => {
    const { request } = responsesRequestToChatRequest(
      { model: 'm', input: 'hi', max_output_tokens: 64 },
      { maxTokensField: 'max_completion_tokens' },
    )
    expect(request.max_completion_tokens).toBe(64)
    expect(request.max_tokens).toBeUndefined()
  })

  it('omits non-function tools in omit mode and reports them', () => {
    const { request, warnings } = responsesRequestToChatRequest(
      {
        model: 'm',
        input: 'hi',
        tools: [
          { type: 'web_search' },
          { type: 'function', name: 'shell' },
        ],
      },
      { unsupportedTools: 'omit' },
    )
    expect(request.tools).toEqual([{ type: 'function', function: { name: 'shell' } }])
    expect(warnings.some(row => row.reason.includes('web_search'))).toBe(true)
  })

  it('rejects non-function tools by default', () => {
    expect(() => responsesRequestToChatRequest({
      model: 'm',
      input: 'hi',
      tools: [{ type: 'web_search' }],
    })).toThrow(UnsupportedFeatureError)
  })

  it('rejects server-side state and unsupported input item types explicitly', () => {
    expect(() => responsesRequestToChatRequest({ model: 'm', input: 'hi', previous_response_id: 'resp_1' })).toThrow(/previous_response_id/)
    expect(() => responsesRequestToChatRequest({ model: 'm', input: 'hi', background: true })).toThrow(/background/)
    expect(() => responsesRequestToChatRequest({ model: 'm', input: [{ type: 'item_reference', id: 'x' }] })).toThrow(/item_reference/)
    expect(() => responsesRequestToChatRequest({ model: 'm', input: [{ type: 'computer_call', call_id: 'c' }] })).toThrow(/computer_call/)
    expect(() => responsesRequestToChatRequest({ model: 'm', input: [{ type: 'web_search_call', id: 'w' }] })).toThrow(/web_search_call/)
  })

  it('skips encrypted-only reasoning items with a warning', () => {
    const { request, warnings } = responsesRequestToChatRequest({
      model: 'm',
      input: [
        { type: 'reasoning', encrypted_content: 'gAAAA', summary: [] },
        { type: 'message', role: 'assistant', content: 'ok' },
      ],
    })
    expect(request.messages).toEqual([{ role: 'assistant', content: 'ok' }])
    expect(warnings).toEqual([{ field: 'input[0].encrypted_content', reason: expect.any(String) }])
  })

  it('warns about include and unknown fields instead of failing', () => {
    const { warnings } = responsesRequestToChatRequest({
      model: 'm',
      input: 'hi',
      include: ['reasoning.encrypted_content'],
      future_field: { a: 1 },
    })
    expect(warnings.map(row => row.field).sort()).toEqual(['future_field', 'include'])
  })

  it('requires a model name', () => {
    expect(() => responsesRequestToChatRequest({ input: 'hi' })).toThrow(/model/)
  })
})
