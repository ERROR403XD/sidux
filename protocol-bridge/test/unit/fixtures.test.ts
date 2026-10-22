import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ChatToResponsesStreamTranslator, encodeSseFrame, responsesRequestToChatRequest } from '../../src/index.js'
import { normalizeEvents } from '../helpers.js'

const here = join(dirname(fileURLToPath(import.meta.url)), '..')

function readFixture(relative: string): string {
  return readFileSync(join(here, 'fixtures', relative), 'utf8')
}

/**
 * Golden tests over checked-in protocol samples captured from real provider
 * shapes (see fixtures/README.md). When a conversion bug is found in the
 * wild, add the raw sample here and pin the corrected output.
 */
describe('fixture: codex-shell-turn.json', () => {
  it('decodes the request into the expected chat payload', () => {
    const { request, warnings } = responsesRequestToChatRequest(JSON.parse(readFixture('requests/codex-shell-turn.json')))
    expect(warnings.map(row => row.field).sort()).toEqual(['include', 'prompt_cache_key', 'reasoning.summary'])
    expect(request).toMatchObject({
      model: 'deepseek-chat',
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: 'medium',
      parallel_tool_calls: false,
      tool_choice: 'auto',
      tools: [
        { type: 'function', function: { name: 'shell', strict: false } },
        { type: 'function', function: { name: 'apply_patch', strict: false } },
      ],
    })
    expect(request.messages).toEqual([
      { role: 'system', content: 'You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI on a user\'s computer.' },
      { role: 'user', content: 'Look at the repo and tell me the test entry point.' },
      {
        role: 'assistant',
        content: 'I will inspect the package manifest.',
        reasoning_content: 'Check package.json first.',
        tool_calls: [{ id: 'call_7d3f', type: 'function', function: { name: 'shell', arguments: '{"command":["cat","package.json"],"timeout_ms":10000}' } }],
      },
      { role: 'tool', tool_call_id: 'call_7d3f', content: '{"output":"\\"test:unit\\": \\"vitest run\\"","metadata":{}}' },
      { role: 'user', content: 'And the build?' },
    ])
  })
})

describe('fixture: deepseek-reasoner-tool-call.jsonl', () => {
  const transcript = readFixture('streams/deepseek-reasoner-tool-call.jsonl')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => encodeSseFrame(JSON.parse(line)))
    .join('')

  it('converts the full reasoning + text + tool-call stream', () => {
    const events: Array<Record<string, unknown>> = []
    const translator = new ChatToResponsesStreamTranslator({ model: 'deepseek-reasoner', onEvent: event => { events.push(event) } })
    translator.translateChunk(transcript)
    translator.finish()

    expect(events[0]).toMatchObject({ type: 'response.created', response: { id: 'chatcmpl-9f2c', model: 'deepseek-reasoner', status: 'in_progress' } })

    const types = events.map(event => event.type)
    expect(types.filter(type => type === 'response.reasoning_summary_text.delta')).toHaveLength(2)
    expect(types.filter(type => type === 'response.output_text.delta')).toHaveLength(1)
    expect(types.filter(type => type === 'response.function_call_arguments.delta')).toHaveLength(3)
    expect(types.at(-1)).toBe('response.completed')

    const completed = events.at(-1)!.response as Record<string, unknown>
    expect(completed.usage).toEqual({
      input_tokens: 811,
      output_tokens: 46,
      total_tokens: 857,
      input_tokens_details: { cached_tokens: 640 },
      output_tokens_details: { reasoning_tokens: 28 },
    })
    const output = completed.output as Array<Record<string, unknown>>
    expect(output.map(item => item.type)).toEqual(['reasoning', 'message', 'function_call'])
    expect(output[0]).toMatchObject({ summary: [{ type: 'summary_text', text: 'First, list the directory to understand the layout. Then run the tests.' }] })
    expect(output[1]).toMatchObject({ content: [{ type: 'output_text', text: 'Running the checks now.' }] })
    expect(output[2]).toMatchObject({ call_id: 'call_0a1b', name: 'shell', arguments: '{"command":"ls -la", "timeout":10}' })
  })

  it('produces identical results when the transcript arrives byte-fragmented', () => {
    const solo: Array<Record<string, unknown>> = []
    const soloTranslator = new ChatToResponsesStreamTranslator({ model: 'deepseek-reasoner', onEvent: event => { solo.push(event) } })
    soloTranslator.translateChunk(transcript)
    soloTranslator.finish()

    const fragmented: Array<Record<string, unknown>> = []
    const translator = new ChatToResponsesStreamTranslator({ model: 'deepseek-reasoner', onEvent: event => { fragmented.push(event) } })
    const bytes = Buffer.from(transcript, 'utf8')
    for (let offset = 0; offset < bytes.length; offset += 13) {
      translator.translateChunk(bytes.subarray(offset, Math.min(offset + 13, bytes.length)))
    }
    translator.finish()
    expect(normalizeEvents(fragmented)).toEqual(normalizeEvents(solo))
  })
})
