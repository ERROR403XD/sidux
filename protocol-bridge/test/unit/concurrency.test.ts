import { describe, expect, it } from 'vitest'
import { CHAT_DONE_FRAME, chatFinishFrame, chatFrame, chatUsageFrame, createTranslator, normalizeEvents, textTranscript } from '../helpers.js'
import { ChatToResponsesStreamTranslator } from '../../src/index.js'

/**
 * Concurrency and soak: many independent translators driven interleaved over
 * fragmented input must each produce exactly the solo-run event stream.
 * This proves request-local state: no shared buffers, no cross-talk.
 */
describe('concurrency and soak', () => {
  const TRANSLATOR_COUNT = 200

  function soloEvents(): Array<Record<string, unknown>> {
    const { translator, events } = createTranslator()
    translator.translateChunk(textTranscript())
    translator.finish()
    return events
  }

  it('keeps 200 interleaved fragmented streams isolated', () => {
    const expected = soloEvents()
    const bytes = Buffer.from(textTranscript(), 'utf8')
    const chunkSize = 7

    const translators: Array<{ translator: ChatToResponsesStreamTranslator; events: Array<Record<string, unknown>> }> = []
    for (let index = 0; index < TRANSLATOR_COUNT; index++) {
      const events: Array<Record<string, unknown>> = []
      translators.push({ events, translator: new ChatToResponsesStreamTranslator({ model: 'bridge-model', onEvent: event => { events.push(event) } }) })
    }

    // Interleave: push chunk i of every translator before chunk i+1.
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length))
      for (const entry of translators) entry.translator.translateChunk(chunk)
    }
    for (const entry of translators) entry.translator.finish()

    for (const [index, entry] of translators.entries()) {
      expect(normalizeEvents(entry.events), `translator ${index}`).toEqual(normalizeEvents(expected))
    }
  })

  it('soaks a 20k-delta stream without loss or duplication', () => {
    const totalDeltas = 20_000
    const transcript = [
      ...Array.from({ length: totalDeltas }, (_, index) => chatFrame({ content: index % 2 === 0 ? '好' : 'a' })),
      chatUsageFrame({ prompt_tokens: 1, completion_tokens: totalDeltas, total_tokens: totalDeltas + 1 }),
      chatFinishFrame('stop'),
      CHAT_DONE_FRAME,
    ].join('')

    const { translator, events } = createTranslator()
    const bytes = Buffer.from(transcript, 'utf8')
    for (let offset = 0; offset < bytes.length; offset += 997) {
      translator.translateChunk(bytes.subarray(offset, Math.min(offset + 997, bytes.length)))
    }
    translator.finish()

    const deltas = events.filter(event => event.type === 'response.output_text.delta')
    expect(deltas).toHaveLength(totalDeltas)
    const completed = events.at(-1)!
    const output = (completed.response as Record<string, unknown>).output as Array<Record<string, unknown>>
    const text = (output[0]!.content as Array<{ text: string }>)[0]!.text
    // Each delta contributes exactly one code unit ('好' or 'a').
    expect(text).toHaveLength(totalDeltas)
    expect((completed.response as Record<string, unknown>).usage).toMatchObject({ output_tokens: totalDeltas })
  })

  it('soaks an interleaved reasoning+text+three-tool-call stream', () => {
    const transcript = [
      chatFrame({ reasoning_content: 'plan' }),
      chatFrame({ content: 'Running tools.' }),
      chatFrame({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"' } }] }),
      chatFrame({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'read', arguments: '{"path":"a' } }] }),
      chatFrame({ tool_calls: [{ index: 2, id: 'call_c', type: 'function', function: { name: 'read', arguments: '{"path":"b' } }] }),
      chatFrame({ tool_calls: [{ index: 0, function: { arguments: '}' } }] }),
      chatFrame({ tool_calls: [{ index: 1, function: { arguments: '.ts"}' } }] }),
      chatFrame({ tool_calls: [{ index: 2, function: { arguments: '.ts"}' } }] }),
      chatFinishFrame('tool_calls'),
      CHAT_DONE_FRAME,
    ].join('')
    const { translator, events } = createTranslator()
    const bytes = Buffer.from(transcript, 'utf8')
    for (let offset = 0; offset < bytes.length; offset += 5) {
      translator.translateChunk(bytes.subarray(offset, Math.min(offset + 5, bytes.length)))
    }
    translator.finish()
    expect(events.at(-1)!.type).toBe('response.completed')
    const output = (events.at(-1)!.response as Record<string, unknown>).output as Array<Record<string, unknown>>
    expect(output.map(item => item.type)).toEqual(['reasoning', 'message', 'function_call', 'function_call', 'function_call'])
    expect(output[2]).toMatchObject({ call_id: 'call_a', arguments: '{"cmd":"ls"}' })
    expect(output[3]).toMatchObject({ call_id: 'call_b', arguments: '{"path":"a.ts"}' })
    expect(output[4]).toMatchObject({ call_id: 'call_c', arguments: '{"path":"b.ts"}' })
  })
})
