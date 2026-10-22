import { describe, expect, it } from 'vitest'
import { chatResponseToResponses } from '../../src/chat/responseEncoder.js'

describe('chatResponseToResponses', () => {
  it('maps text, reasoning_content, usage and finish_reason', () => {
    const { response, warnings } = chatResponseToResponses({
      id: 'chatcmpl-1',
      created: 1726000000,
      model: 'deepseek-chat',
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'Hello.', reasoning_content: 'thinking' },
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
        prompt_tokens_details: { cached_tokens: 3 },
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    }, 'deepseek-chat')

    expect(warnings).toEqual([])
    expect(response).toMatchObject({
      id: 'chatcmpl-1',
      object: 'response',
      created_at: 1726000000,
      status: 'completed',
      model: 'deepseek-chat',
    })
    // Reasoning first, then the message.
    expect(response.output).toEqual([
      { type: 'reasoning', id: expect.stringMatching(/^rs_/), summary: [{ type: 'summary_text', text: 'thinking' }] },
      { type: 'message', id: expect.stringMatching(/^msg_/), status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Hello.', annotations: [] }] },
    ])
    expect(response.usage).toEqual({
      input_tokens: 10,
      output_tokens: 4,
      total_tokens: 14,
      input_tokens_details: { cached_tokens: 3 },
      output_tokens_details: { reasoning_tokens: 2 },
    })
  })

  it('maps tool calls into function_call items with call_id', () => {
    const { response } = chatResponseToResponses({
      id: 'chatcmpl-2',
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } },
            { id: 'call_b', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } },
          ],
        },
      }],
    }, 'm')

    expect(response.status).toBe('completed')
    expect(response.output).toEqual([
      { type: 'function_call', id: expect.stringMatching(/^fc_/), status: 'completed', call_id: 'call_a', name: 'shell', arguments: '{"cmd":"ls"}' },
      { type: 'function_call', id: expect.stringMatching(/^fc_/), status: 'completed', call_id: 'call_b', name: 'read', arguments: '{"path":"a.ts"}' },
    ])
  })

  it('marks length-truncated answers incomplete', () => {
    const { response } = chatResponseToResponses({
      choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'partial' } }],
    }, 'm')
    expect(response.status).toBe('incomplete')
    expect(response.incomplete_details).toEqual({ reason: 'max_output_tokens' })
  })

  it('handles empty choices and missing usage gracefully', () => {
    const { response, warnings } = chatResponseToResponses({ choices: [] }, 'm')
    expect(response.output).toEqual([])
    expect(response.status).toBe('completed')
    expect('usage' in response).toBe(false)
    expect(warnings).toEqual([])
  })

  it('recognizes the reasoning alias field through compat options', () => {
    const { response } = chatResponseToResponses({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok', reasoning: 'alt field' } }],
    }, 'm', { reasoningFields: ['reasoning'] })
    expect((response.output as Array<Record<string, unknown>>)[0]).toMatchObject({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'alt field' }] })
  })
})
