import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { createThreadLivePlanState } from './threadLivePlanState'
import type { UiMessage, UiPlanData } from '../types/codex'

function planMessage(id: string, text: string, isStreaming?: boolean): UiMessage {
  return {
    id,
    role: 'assistant',
    text,
    messageType: 'plan.live',
    plan: isStreaming === undefined ? undefined : { explanation: '', isStreaming, steps: [] } satisfies UiPlanData,
  } as UiMessage
}

describe('thread live plan state', () => {
  it('finds an existing plan for delta projection', () => {
    const messagesByThreadId = ref<Record<string, UiMessage[]>>({ 'thread-1': [planMessage('turn-1:plan', 'existing')] })
    const state = createThreadLivePlanState({ messagesByThreadId })
    expect(state.findMessage('thread-1', 'turn-1:plan')?.text).toBe('existing')
    expect(state.findMessage('thread-1', 'missing')).toBeUndefined()
  })

  it('upserts by id while skipping equivalent writes', () => {
    const messagesByThreadId = ref<Record<string, UiMessage[]>>({ 'thread-1': [planMessage('turn-1:plan', 'Plan', true)] })
    const state = createThreadLivePlanState({ messagesByThreadId })
    const first = messagesByThreadId.value
    state.upsert('thread-1', planMessage('turn-1:plan', 'Plan', true))
    expect(messagesByThreadId.value).toBe(first)
    state.upsert('thread-1', planMessage('turn-1:plan', 'Plan updated', true))
    expect(state.getMessages('thread-1')).toEqual([planMessage('turn-1:plan', 'Plan updated', true)])
  })

  it('clears, prunes, and resets without empty entries', () => {
    const messagesByThreadId = ref<Record<string, UiMessage[]>>({
      'thread-1': [planMessage('turn-1:plan', 'first')],
      'thread-2': [planMessage('turn-2:plan', 'second')],
    })
    const state = createThreadLivePlanState({ messagesByThreadId })
    state.clear('thread-1')
    expect(Object.keys(messagesByThreadId.value)).toEqual(['thread-2'])
    state.prune(new Set(['thread-1']))
    expect(messagesByThreadId.value).toEqual({})
    messagesByThreadId.value = { 'thread-3': [planMessage('turn-3:plan', 'third')] }
    state.reset()
    expect(messagesByThreadId.value).toEqual({})
    expect(state.getMessages('missing')).toEqual([])
  })
})
