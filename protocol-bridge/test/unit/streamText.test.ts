import { describe, expect, it } from 'vitest'
import { CHAT_DONE_FRAME, chatFinishFrame, chatFrame, chatUsageFrame, createTranslator, feed, feedBytes, normalizeEvents, textTranscript, typeOfEvents } from '../helpers.js'

describe('streaming text conversion', () => {
  it('emits the canonical Responses event sequence with full text in done events', () => {
    const { translator, events } = createTranslator()
    feed(translator, textTranscript())
    translator.finish()

    expect(typeOfEvents(events)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ])

    const deltas = events.filter(event => event.type === 'response.output_text.delta')
    expect(deltas.map(event => event.delta)).toEqual(['你好', '，', '🌍 world'])

    const completed = events.at(-1)!
    expect(completed.type).toBe('response.completed')
    const response = completed.response as Record<string, unknown>
    expect(response.status).toBe('completed')
    expect(response.usage).toEqual({
      input_tokens: 12,
      output_tokens: 7,
      total_tokens: 19,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    })
    const output = response.output as Array<Record<string, unknown>>
    expect(output).toHaveLength(1)
    expect(output[0]).toMatchObject({
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: '你好，🌍 world' }],
    })
    // Delta events carry item/output/content indices and sequence numbers.
    expect(events[4]).toMatchObject({ item_id: expect.stringMatching(/^msg_/), output_index: 0, content_index: 0 })
    expect(events.map(event => event.sequence_number)).toEqual(events.map((_, index) => index))
  })

  it('produces byte-identical event streams under every fragmentation', () => {
    const transcript = textTranscript()
    const { translator: solo, events: soloEvents } = createTranslator()
    feed(solo, transcript)
    solo.finish()

    for (const chunkSize of [1, 2, 3, 5, 7, 64, 1024]) {
      const { translator, events } = createTranslator()
      feedBytes(translator, transcript, chunkSize)
      translator.finish()
      expect(normalizeEvents(events), `chunk size ${chunkSize}`).toEqual(normalizeEvents(soloEvents))
    }
  })

  it('buffers many frames inside a single chunk', () => {
    const { translator, events } = createTranslator()
    const transcript = Array.from({ length: 50 }, (_, index) => chatFrame({ content: `t${index}` })).join('')
    feed(translator, transcript)
    translator.finish()
    expect(events.filter(event => event.type === 'response.output_text.delta')).toHaveLength(50)
  })

  it('caps a response at max_output_tokens with incomplete status', () => {
    const { translator, events } = createTranslator()
    feed(translator, [
      chatFrame({ content: 'cut off' }),
      chatFinishFrame('length'),
      CHAT_DONE_FRAME,
    ].join(''))
    translator.finish()

    const completed = events.at(-1)!
    const response = completed.response as Record<string, unknown>
    expect(response.status).toBe('incomplete')
    expect(response.incomplete_details).toEqual({ reason: 'max_output_tokens' })
  })

  it('forwards usage that arrives in a trailing choices-less chunk', () => {
    const { translator, events } = createTranslator()
    feed(translator, [
      chatFrame({ content: 'hi' }),
      chatFinishFrame('stop'),
      chatUsageFrame({ prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }),
      CHAT_DONE_FRAME,
    ].join(''))
    translator.finish()
    const response = events.at(-1)!.response as Record<string, unknown>
    expect(response.usage).toMatchObject({ input_tokens: 3, output_tokens: 1, total_tokens: 4 })
  })

  it('emits created + completed even for an empty upstream stream', () => {
    const { translator, events } = createTranslator()
    translator.finish()
    expect(typeOfEvents(events)).toEqual(['response.created', 'response.in_progress', 'response.completed'])
    const response = events.at(-1)!.response as Record<string, unknown>
    expect(response.output).toEqual([])
    expect(response.status).toBe('completed')
  })

  it('skips malformed and empty frames without breaking the stream', () => {
    const { translator, events } = createTranslator()
    feed(translator, [
      'data: not-json\n\n',
      'data: \n\n',
      ': comment\n\n',
      'event: ping\ndata: {"choices":[]}\n\n',
      chatFrame({ content: 'ok' }),
      chatFinishFrame('stop'),
      CHAT_DONE_FRAME,
    ].join(''))
    translator.finish()
    expect(typeOfEvents(events)).toContain('response.output_text.delta')
    expect(events.at(-1)!.type).toBe('response.completed')
  })
})
