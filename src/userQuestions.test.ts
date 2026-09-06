import { describe, expect, it } from 'vitest'
import { buildQuestionReply, isAsyncUserInputRequest, pendingRequestPriority, questionRefKey, readAsyncQuestions, readQuestionReply } from './userQuestions'
import type { UiMessage, UiServerRequest } from './types/codex'

describe('question protocol adapter', () => {
  it('keeps free-text questions and filters malformed options', () => {
    expect(readAsyncQuestions([{ title: '  Scope? ', options: ['One', '', null] }, { title: 'When?' }, { title: '' }]))
      .toEqual([{ title: 'Scope?', options: ['One'] }, { title: 'When?', options: [] }])
  })

  it('treats legacy requests as blocking and gives approvals precedence', () => {
    const request = { method: 'item/tool/requestUserInput', params: {} } as UiServerRequest
    expect(isAsyncUserInputRequest(request)).toBe(false)
    expect(pendingRequestPriority(request)).toBe(1)
    request.params = { isBlocking: false }
    expect(isAsyncUserInputRequest(request)).toBe(true)
    expect(pendingRequestPriority(request)).toBe(2)
    expect(pendingRequestPriority({ ...request, method: 'item/permissions/requestApproval' })).toBe(0)
  })

  it('roundtrips exact item/turn identity and visible answers without parsing ordinary chat as answers', () => {
    const message: UiMessage = { id: 'item-1', turnId: 'turn-1', role: 'assistant', text: '', questions: [{ title: 'Scope?', options: ['One'] }, { title: 'When?', options: [] }] }
    const encoded = buildQuestionReply(message, ['Two', 'Tomorrow'])
    expect(readQuestionReply(encoded)).toEqual({ text: 'Scope?\nTwo\n\nWhen?\nTomorrow', questionReply: { itemId: 'item-1', turnId: 'turn-1' } })
    expect(readQuestionReply('Tomorrow')).toEqual({ text: 'Tomorrow' })
    expect(readQuestionReply('<!-- codexapp:question-reply invalid -->\n\nHi')).toEqual({ text: '<!-- codexapp:question-reply invalid -->\n\nHi' })
    expect(() => buildQuestionReply(message, ['One', ''])).toThrow()
    expect(() => buildQuestionReply({ ...message, turnId: undefined }, ['One', 'Tomorrow'])).toThrow()
  })
})


it('binds by turn and question ordinal when native item IDs change during materialization', () => {
  expect(questionRefKey({ itemId: 'item-3', turnId: 'turn-1', questionOrdinal: 0 }))
    .toBe(questionRefKey({ itemId: 'call-real', turnId: 'turn-1', questionOrdinal: 0 }))
  expect(questionRefKey({ itemId: 'call-real', turnId: 'turn-1', questionOrdinal: 1 }))
    .not.toBe(questionRefKey({ itemId: 'call-real', turnId: 'turn-1', questionOrdinal: 0 }))
})
