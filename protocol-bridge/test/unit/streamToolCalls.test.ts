import { describe, expect, it } from 'vitest'
import { CHAT_DONE_FRAME, chatFinishFrame, chatFrame, createTranslator, feed, feedBytes, normalizeEvents, typeOfEvents } from '../helpers.js'

function singleToolTranscript(): string {
  return [
    chatFrame({ role: 'assistant', content: '' }),
    chatFrame({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'shell', arguments: '' } }] }),
    chatFrame({ tool_calls: [{ index: 0, function: { arguments: '{"cmd":"git ' } }] }),
    chatFrame({ tool_calls: [{ index: 0, function: { arguments: 'status"}' } }] }),
    chatFinishFrame('tool_calls'),
    CHAT_DONE_FRAME,
  ].join('')
}

describe('streaming tool call conversion', () => {
  it('emits function_call item with deltas and the full assembled arguments', () => {
    const { translator, events } = createTranslator()
    feed(translator, singleToolTranscript())
    translator.finish()

    expect(typeOfEvents(events)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed',
    ])

    const added = events[2]!
    expect(added.item).toMatchObject({ type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '' })
    expect(added.output_index).toBe(0)

    const done = events[6]!
    expect(done.item).toMatchObject({
      type: 'function_call',
      status: 'completed',
      call_id: 'call_1',
      name: 'shell',
      arguments: '{"cmd":"git status"}',
    })
    const response = events.at(-1)!.response as Record<string, unknown>
    expect((response.output as Array<Record<string, unknown>>)[0]).toMatchObject({ call_id: 'call_1', arguments: '{"cmd":"git status"}' })
  })

  it('survives tool arguments fragmented across dozens of chunks and byte splits', () => {
    const transcript = [
      chatFrame({ tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'write_file', arguments: '' } }] }),
      ...Array.from({ length: 40 }, (_, index) => chatFrame({ tool_calls: [{ index: 0, function: { arguments: `{"chunk":${index},"pad":"${'x'.repeat(20)}"}` } }] })),
      chatFinishFrame('tool_calls'),
      CHAT_DONE_FRAME,
    ].join('')
    const { translator: solo, events: soloEvents } = createTranslator()
    feed(solo, transcript)
    solo.finish()

    for (const chunkSize of [1, 3, 11]) {
      const { translator, events } = createTranslator()
      feedBytes(translator, transcript, chunkSize)
      translator.finish()
      expect(normalizeEvents(events), `chunk size ${chunkSize}`).toEqual(normalizeEvents(soloEvents))
    }
    const argumentsDone = soloEvents.find(event => event.type === 'response.function_call_arguments.done')
    expect(argumentsDone).toBeTruthy()
  })

  it('handles parallel tool calls with interleaved argument deltas', () => {
    const { translator, events } = createTranslator()
    feed(translator, [
      chatFrame({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read', arguments: '' } }] }),
      chatFrame({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'read', arguments: '' } }] }),
      chatFrame({ tool_calls: [{ index: 0, function: { arguments: '{"path":"a' } }] }),
      chatFrame({ tool_calls: [{ index: 1, function: { arguments: '{"path":"b' } }] }),
      chatFrame({ tool_calls: [{ index: 0, function: { arguments: '.ts"}' } }] }),
      chatFrame({ tool_calls: [{ index: 1, function: { arguments: '.ts"}' } }] }),
      chatFinishFrame('tool_calls'),
      CHAT_DONE_FRAME,
    ].join(''))
    translator.finish()

    const added = events.filter(event => event.type === 'response.output_item.added')
    expect(added.map(event => (event.item as Record<string, unknown>).call_id)).toEqual(['call_a', 'call_b'])
    expect(added.map(event => event.output_index)).toEqual([0, 1])

    const done = events.filter(event => event.type === 'response.output_item.done')
    expect(done.map(event => (event.item as Record<string, unknown>).arguments)).toEqual(['{"path":"a.ts"}', '{"path":"b.ts"}'])
    expect(done.map(event => event.output_index)).toEqual([0, 1])
  })

  it('interleaves text and tool calls in arrival order', () => {
    const { translator, events } = createTranslator()
    feed(translator, [
      chatFrame({ content: 'Let me check. ' }),
      chatFrame({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{}' } }] }),
      chatFinishFrame('tool_calls'),
      CHAT_DONE_FRAME,
    ].join(''))
    translator.finish()

    expect(typeOfEvents(events)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added', // message
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_item.added', // function_call
      'response.function_call_arguments.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed',
    ])
  })

  it('synthesizes call ids when the provider omits them', () => {
    const { translator, events } = createTranslator()
    feed(translator, [
      chatFrame({ tool_calls: [{ index: 0, function: { name: 'shell', arguments: '{}' } }] }),
      chatFinishFrame('tool_calls'),
      CHAT_DONE_FRAME,
    ].join(''))
    translator.finish()
    const added = events.find(event => event.type === 'response.output_item.added')
    expect((added!.item as Record<string, unknown>).call_id).toMatch(/^call_/)
  })

  it('reassembles names that arrive split across deltas', () => {
    const { translator, events } = createTranslator()
    feed(translator, [
      chatFrame({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'sh', arguments: '' } }] }),
      chatFrame({ tool_calls: [{ index: 0, function: { name: 'ell' } }] }),
      chatFrame({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] }),
      chatFinishFrame('tool_calls'),
      CHAT_DONE_FRAME,
    ].join(''))
    translator.finish()
    const done = events.filter(event => event.type === 'response.output_item.done').at(-1)
    expect((done!.item as Record<string, unknown>).name).toBe('shell')
  })

  it('treats a silent close with open tool calls as a failure', () => {
    const { translator, events } = createTranslator()
    feed(translator, [
      chatFrame({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"cmd":' } }] }),
    ].join(''))
    translator.finish()
    expect(events.at(-1)!.type).toBe('response.failed')
  })
})
