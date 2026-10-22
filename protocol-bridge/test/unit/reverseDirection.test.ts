import { describe, expect, it } from 'vitest'
import { ChatStreamEncoder } from '../../src/chat/streamEncoder.js'
import { ResponsesStreamDecoder } from '../../src/responses/streamDecoder.js'
import { ResponsesToChatStreamTranslator } from '../../src/responses/streamTranslator.js'
import { chatRequestToResponsesRequest } from '../../src/responses/requestEncoder.js'
import { responsesResponseToChatResponse } from '../../src/responses/responseDecoder.js'
import { encodeSseFrame } from '../../src/sse/writer.js'

describe('reverse direction: chatRequestToResponsesRequest', () => {
  it('converts messages, tools and sampling params', () => {
    const { request, warnings } = chatRequestToResponsesRequest({
      model: 'gpt-5',
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } }] },
        { role: 'tool', tool_call_id: 'call_a', content: 'out' },
      ],
      tools: [{ type: 'function', function: { name: 'shell', description: 'run', parameters: { type: 'object' } } }],
      tool_choice: 'auto',
      max_tokens: 128,
      temperature: 0.5,
      reasoning_effort: 'low',
      stream: true,
      stream_options: { include_usage: true },
    })

    expect(request).toMatchObject({
      model: 'gpt-5',
      instructions: 'Be terse.',
      stream: true,
      max_output_tokens: 128,
      temperature: 0.5,
      reasoning: { effort: 'low' },
      tools: [{ type: 'function', name: 'shell', description: 'run', parameters: { type: 'object' } }],
      tool_choice: 'auto',
    })
    expect(request.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'function_call', call_id: 'call_a', name: 'shell', arguments: '{"cmd":"ls"}' },
      { type: 'function_call_output', call_id: 'call_a', output: 'out' },
    ])
    expect(warnings.map(row => row.field)).toEqual(['stream_options'])
  })
})

describe('reverse direction: responsesResponseToChatResponse', () => {
  it('maps output items and usage', () => {
    const { response } = responsesResponseToChatResponse({
      id: 'resp_1',
      created_at: 1726000000,
      model: 'gpt-5',
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'hmm' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] },
        { type: 'function_call', call_id: 'call_a', name: 'shell', arguments: '{"cmd":"ls"}' },
      ],
      usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
    })
    expect(response).toEqual({
      id: 'resp_1',
      object: 'chat.completion',
      created: 1726000000,
      model: 'gpt-5',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'Hello',
          reasoning_content: 'hmm',
          tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
    })
  })
})

describe('reverse direction: streaming', () => {
  function responsesTranscript(): string {
    return [
      encodeSseFrame({ type: 'response.created', response: { id: 'resp_x', model: 'gpt-5' } }),
      encodeSseFrame({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [] } }),
      encodeSseFrame({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, delta: 'think' }),
      encodeSseFrame({ type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] } }),
      encodeSseFrame({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, delta: 'Hello ' }),
      encodeSseFrame({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, delta: 'world' }),
      encodeSseFrame({ type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_a', name: 'shell', arguments: '' } }),
      encodeSseFrame({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 2, delta: '{"cmd"' }),
      encodeSseFrame({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 2, delta: ':"ls"}' }),
      encodeSseFrame({
        type: 'response.completed',
        response: { id: 'resp_x', model: 'gpt-5', output: [], usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 } },
      }),
    ].join('')
  }

  it('translates a full Responses stream into Chat chunks', () => {
    const chunks: Array<Record<string, unknown>> = []
    const translator = new ResponsesToChatStreamTranslator({ onChunk: chunk => { chunks.push(chunk) } })
    translator.translateChunk(responsesTranscript())
    translator.finish()

    const deltas = chunks.filter(chunk => Array.isArray(chunk.choices) && (chunk.choices as Array<Record<string, unknown>>)[0]?.delta)
    const contents = deltas
      .map(chunk => (chunk.choices as Array<{ delta: Record<string, unknown> }>)[0]!.delta)
      .filter(delta => typeof delta.content === 'string' && delta.content !== '')
      .map(delta => delta.content as string)
    expect(contents).toEqual(['Hello ', 'world'])

    const toolDeltas = deltas.flatMap(chunk => (chunk.choices as Array<{ delta: Record<string, unknown> }>)[0]!.delta.tool_calls as Array<Record<string, unknown>> | undefined)
      .filter(Boolean)
    expect(toolDeltas[0]).toMatchObject({ index: 0, id: 'call_a', type: 'function', function: { name: 'shell' } })

    const finish = chunks.find(chunk => (chunk.choices as Array<{ finish_reason?: unknown }> | undefined)?.[0]?.finish_reason)
    expect((finish!.choices as Array<{ finish_reason: string }>)[0]!.finish_reason).toBe('tool_calls')

    const usageChunk = chunks.find(chunk => Array.isArray(chunk.choices) && (chunk.choices as unknown[]).length === 0)
    expect(usageChunk).toMatchObject({ usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } })
  })

  it('maps reasoning deltas to reasoning_content', () => {
    const chunks: Array<Record<string, unknown>> = []
    const translator = new ResponsesToChatStreamTranslator({ onChunk: chunk => { chunks.push(chunk) } })
    translator.translateChunk(responsesTranscript())
    translator.finish()
    const reasoning = chunks
      .map(chunk => (chunk.choices as Array<{ delta: Record<string, unknown> }> | undefined)?.[0]?.delta)
      .filter(delta => delta && typeof delta.reasoning_content === 'string')
    expect(reasoning.map(delta => delta!.reasoning_content)).toEqual(['think'])
  })

  it('reports response.failed through onFailure and an error chunk', () => {
    const failures: Array<{ code: string; message: string }> = []
    const chunks: Array<Record<string, unknown>> = []
    const translator = new ResponsesToChatStreamTranslator({ onChunk: chunk => { chunks.push(chunk) }, onFailure: failure => { failures.push(failure) } })
    translator.translateChunk(encodeSseFrame({ type: 'response.failed', response: { error: { code: 'rate_limited', message: 'slow down' } } }))
    translator.finish()
    expect(failures).toEqual([{ code: 'rate_limited', message: 'slow down' }])
    expect(chunks.some(chunk => (chunk.error as Record<string, unknown>)?.code === 'rate_limited')).toBe(true)
  })

  it('survives arbitrary byte fragmentation', () => {
    const transcript = responsesTranscript()
    const solo: Array<Record<string, unknown>> = []
    const soloTranslator = new ResponsesToChatStreamTranslator({ onChunk: chunk => { solo.push(chunk) } })
    soloTranslator.translateChunk(transcript)
    soloTranslator.finish()

    const bytes = Buffer.from(transcript, 'utf8')
    const fragmented: Array<Record<string, unknown>> = []
    const translator = new ResponsesToChatStreamTranslator({ onChunk: chunk => { fragmented.push(chunk) } })
    for (let offset = 0; offset < bytes.length; offset += 3) {
      translator.translateChunk(bytes.subarray(offset, Math.min(offset + 3, bytes.length)))
    }
    translator.finish()
    expect(fragmented).toEqual(solo)
  })
})

describe('reverse direction: unit encoders', () => {
  it('ChatStreamEncoder emits role on the first chunk and a finish chunk', () => {
    const chunks: Array<Record<string, unknown>> = []
    const encoder = new ChatStreamEncoder(chunk => { chunks.push(chunk) })
    encoder.consume({ kind: 'start', responseId: 'resp_1', model: 'm' })
    encoder.consume({ kind: 'textDelta', text: 'hi' })
    encoder.consume({ kind: 'finish', reason: 'stop' })
    expect((chunks[0]!.choices as Array<{ delta: Record<string, unknown> }>)[0]!.delta).toEqual({ role: 'assistant', content: '' })
    expect(chunks[1]!.choices).toEqual([{ index: 0, delta: { content: 'hi' }, finish_reason: null }])
    expect(chunks[2]!.choices).toEqual([{ index: 0, delta: {}, finish_reason: 'stop' }])
  })

  it('ResponsesStreamDecoder ignores unknown event types', () => {
    const decoder = new ResponsesStreamDecoder()
    expect(decoder.decodeEvent({ type: 'response.output_text.done', text: 'x' }).events).toEqual([])
    expect(decoder.decodeEvent({ type: 'response.content_part.added' }).events).toEqual([])
  })
})
