import { describe, expect, it } from 'vitest'
import { CHAT_DONE_FRAME, chatFinishFrame, chatFrame, chatUsageFrame, createTranslator, feed } from '../helpers.js'
import { StreamInterruptedError } from '../../src/errors.js'

describe('stream lifecycle', () => {
  it('completes gracefully when [DONE] arrives without a finish_reason', () => {
    const { translator, events } = createTranslator()
    feed(translator, [
      chatFrame({ content: 'no finish reason' }),
      CHAT_DONE_FRAME,
    ].join(''))
    translator.finish()
    expect(events.at(-1)!.type).toBe('response.completed')
    const response = events.at(-1)!.response as Record<string, unknown>
    expect(response.status).toBe('completed')
  })

  it('completes gracefully on silent close without tool calls', () => {
    const { translator, events } = createTranslator()
    feed(translator, chatFrame({ content: 'ended abruptly' }))
    translator.finish()
    expect(events.at(-1)!.type).toBe('response.completed')
  })

  it('fails on silent close when the compat option asks for strictness', () => {
    const { translator, events } = createTranslator({ compatOptions: { silentClose: 'fail' } })
    feed(translator, chatFrame({ content: 'ended abruptly' }))
    translator.finish()
    expect(events.at(-1)!.type).toBe('response.failed')
  })

  it('fails when the upstream dies mid-flight', () => {
    const { translator, events } = createTranslator()
    feed(translator, [
      chatFrame({ content: 'partial' }),
    ].join(''))
    translator.fail(new StreamInterruptedError('connection reset'))
    expect(events.at(-1)!.type).toBe('response.failed')
    const response = events.at(-1)!.response as Record<string, unknown>
    expect(response.status).toBe('failed')
    expect(response.error).toEqual({ code: 'stream_interrupted', message: 'connection reset' })
  })

  it('reports generic errors with the upstream_error code', () => {
    const { translator, events } = createTranslator()
    translator.fail(new Error('socket hang up'))
    const response = events.at(-1)!.response as Record<string, unknown>
    expect(response.error).toEqual({ code: 'upstream_error', message: 'socket hang up' })
  })

  it('does not emit anything after a terminal state', () => {
    const { translator, events } = createTranslator()
    feed(translator, [
      chatFrame({ content: 'done' }),
      chatFinishFrame('stop'),
      CHAT_DONE_FRAME,
    ].join(''))
    translator.finish()
    const count = events.length
    // Late garbage after terminal state must be ignored.
    feed(translator, chatFrame({ content: 'late' }))
    translator.finish()
    translator.fail(new Error('late failure'))
    expect(events.length).toBe(count)
  })

  it('exposes usage for the transport accounting hook', () => {
    const { translator } = createTranslator()
    feed(translator, [
      chatFrame({ content: 'x' }),
      chatUsageFrame({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }),
      chatFinishFrame('stop'),
      CHAT_DONE_FRAME,
    ].join(''))
    translator.finish()
    expect(translator.getUsage()).toEqual({
      inputTokens: 5,
      outputTokens: 2,
      totalTokens: 7,
      cachedInputTokens: null,
      reasoningTokens: null,
    })
  })

  it('surfaces decoder warnings through getWarnings', () => {
    const { translator } = createTranslator()
    feed(translator, chatFrame({ content: 'x' }) + CHAT_DONE_FRAME)
    translator.finish()
    expect(Array.isArray(translator.getWarnings())).toBe(true)
  })

  it('keeps delta content arrays working (Gemini-proxy style providers)', () => {
    const { translator, events } = createTranslator()
    feed(translator, [
      chatFrame({ content: [{ type: 'text', text: 'part ' }, { type: 'text', text: 'two' }] }),
      chatFinishFrame('stop'),
      CHAT_DONE_FRAME,
    ].join(''))
    translator.finish()
    const delta = events.find(event => event.type === 'response.output_text.delta')
    expect(delta!.delta).toBe('part two')
  })

  it('reports dropped choices as warnings', () => {
    const { translator, events } = createTranslator()
    const multi = JSON.stringify({
      id: 'chatcmpl-test',
      model: 'bridge-model',
      choices: [
        { index: 0, delta: { content: 'a' }, finish_reason: null },
        { index: 1, delta: { content: 'b' }, finish_reason: null },
      ],
    })
    feed(translator, `data: ${multi}\n\n${chatFinishFrame('stop')}${CHAT_DONE_FRAME}`)
    translator.finish()
    expect(events.filter(event => event.type === 'response.output_text.delta')).toHaveLength(1)
  })
})
