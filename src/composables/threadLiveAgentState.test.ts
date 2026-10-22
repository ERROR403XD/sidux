import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { createThreadLiveAgentState } from './threadLiveAgentState'
import type { UiMessage } from '../types/codex'

function agentMessage(id: string, text: string, turnId?: string): UiMessage {
  return {
    id,
    role: 'assistant',
    text,
    messageType: 'agentMessage.live',
    turnId,
  } as UiMessage
}

describe('thread live agent state', () => {
  it('finds an existing message for delta projection', () => {
    const messagesByThreadId = ref<Record<string, UiMessage[]>>({ 'thread-1': [agentMessage('agent-1', 'existing', 'turn-1')] })
    const state = createThreadLiveAgentState({ messagesByThreadId })
    expect(state.findMessage('thread-1', 'agent-1')?.text).toBe('existing')
    expect(state.findMessage('thread-1', 'missing')).toBeUndefined()
  })

  it('uses the fallback turn id without replacing an explicit turn id', () => {
    const messagesByThreadId = ref<Record<string, UiMessage[]>>({})
    const state = createThreadLiveAgentState({ messagesByThreadId })
    state.upsert('thread-1', agentMessage('agent-1', 'first'), 'turn-fallback')
    state.upsert('thread-1', agentMessage('agent-2', 'second', 'turn-explicit'), 'turn-fallback')
    expect(state.getMessages('thread-1').map(message => message.turnId)).toEqual(['turn-fallback', 'turn-explicit'])
  })

  it('upserts by message id while skipping equivalent writes', () => {
    const messagesByThreadId = ref<Record<string, UiMessage[]>>({ 'thread-1': [agentMessage('agent-1', 'existing', 'turn-1')] })
    const state = createThreadLiveAgentState({ messagesByThreadId })
    const first = messagesByThreadId.value
    state.upsert('thread-1', agentMessage('agent-1', 'existing'), 'turn-1')
    expect(messagesByThreadId.value).toBe(first)
    state.upsert('thread-1', agentMessage('agent-1', 'updated'), 'turn-1')
    expect(state.getMessages('thread-1')).toEqual([agentMessage('agent-1', 'updated', 'turn-1')])
  })

  it('clears, prunes, and resets without empty entries', () => {
    const messagesByThreadId = ref<Record<string, UiMessage[]>>({
      'thread-1': [agentMessage('agent-1', 'first')],
      'thread-2': [agentMessage('agent-2', 'second')],
    })
    const state = createThreadLiveAgentState({ messagesByThreadId })
    state.clear('thread-1')
    expect(Object.keys(messagesByThreadId.value)).toEqual(['thread-2'])
    state.prune(new Set(['thread-1']))
    expect(messagesByThreadId.value).toEqual({})
    messagesByThreadId.value = { 'thread-3': [agentMessage('agent-3', 'third')] }
    state.reset()
    expect(messagesByThreadId.value).toEqual({})
    expect(state.getMessages('missing')).toEqual([])
  })
})
