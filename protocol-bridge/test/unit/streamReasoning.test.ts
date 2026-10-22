import { describe, expect, it } from 'vitest'
import { CHAT_DONE_FRAME, chatFinishFrame, chatFrame, createTranslator, feed, typeOfEvents } from '../helpers.js'

describe('streaming reasoning conversion', () => {
  it('emits reasoning summary events before the message for DeepSeek-style reasoning_content', () => {
    const { translator, events } = createTranslator()
    feed(translator, [
      chatFrame({ reasoning_content: '思考中 ' }),
      chatFrame({ reasoning_content: 'step two' }),
      chatFrame({ content: 'Answer' }),
      chatFinishFrame('stop'),
      CHAT_DONE_FRAME,
    ].join(''))
    translator.finish()

    expect(typeOfEvents(events)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added', // reasoning
      'response.reasoning_summary_part.added',
      'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.delta',
      'response.output_item.added', // message
      'response.content_part.added',
      'response.output_text.delta',
      'response.reasoning_summary_text.done',
      'response.reasoning_summary_part.done',
      'response.output_item.done',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ])

    const reasoningDone = events.find(event => event.type === 'response.reasoning_summary_text.done')
    expect(reasoningDone).toMatchObject({ text: '思考中 step two' })
    const completed = events.at(-1)!.response as Record<string, unknown>
    expect((completed.output as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: '思考中 step two' }],
    })
  })

  it('honors the reasoning alias field through compat options', () => {
    const { translator, events } = createTranslator({ compatOptions: { reasoningFields: ['reasoning'] } })
    feed(translator, [
      chatFrame({ reasoning: 'alt' }),
      chatFrame({ content: 'ok' }),
      chatFinishFrame('stop'),
      CHAT_DONE_FRAME,
    ].join(''))
    translator.finish()
    expect(events.some(event => event.type === 'response.reasoning_summary_text.delta')).toBe(true)
  })

  it('keeps reasoning out of the stream when the provider sends none', () => {
    const { translator, events } = createTranslator()
    feed(translator, [
      chatFrame({ content: 'plain' }),
      chatFinishFrame('stop'),
      CHAT_DONE_FRAME,
    ].join(''))
    translator.finish()
    expect(typeOfEvents(events).some(type => type.startsWith('response.reasoning'))).toBe(false)
  })
})
