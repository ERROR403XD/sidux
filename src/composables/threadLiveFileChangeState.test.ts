import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { createThreadLiveFileChangeState } from './threadLiveFileChangeState'
import type { UiMessage } from '../types/codex'

function fileChange(id: string, turnId?: string, turnIndex?: number): UiMessage {
  return {
    id,
    role: 'system',
    text: '',
    messageType: 'fileChange',
    turnId,
    turnIndex,
  } as UiMessage
}

describe('thread live file change state', () => {
  it('sets and upserts messages while skipping equivalent writes', () => {
    const messagesByThreadId = ref<Record<string, UiMessage[]>>({ 'thread-1': [fileChange('change-1')] })
    const state = createThreadLiveFileChangeState({ messagesByThreadId })
    const first = messagesByThreadId.value
    state.set('thread-1', first['thread-1'])
    expect(messagesByThreadId.value).toBe(first)
    state.upsert('thread-1', fileChange('change-2'))
    expect(state.getMessages('thread-1').map(message => message.id)).toEqual(['change-1', 'change-2'])
  })

  it('rebinds only changed turn indices', () => {
    const messagesByThreadId = ref<Record<string, UiMessage[]>>({
      'thread-1': [fileChange('change-1', 'turn-1', 0), fileChange('change-2', 'turn-2', 1)],
    })
    const state = createThreadLiveFileChangeState({ messagesByThreadId })
    state.rebindTurnIndices('thread-1', { 'turn-1': 4, 'turn-2': 1 })
    expect(state.getMessages('thread-1')).toEqual([
      fileChange('change-1', 'turn-1', 4),
      fileChange('change-2', 'turn-2', 1),
    ])
  })

  it('removes persisted messages by id, turn id, and turn index', () => {
    const messagesByThreadId = ref<Record<string, UiMessage[]>>({
      'thread-1': [
        fileChange('same-id', 'turn-1', 0),
        fileChange('other-id', 'persisted-turn', 1),
        fileChange('third-id', 'turn-3', 3),
      ],
    })
    const state = createThreadLiveFileChangeState({ messagesByThreadId })
    state.removePersistedIn('thread-1', [
      fileChange('same-id', 'other-turn', 9),
      fileChange('different-id', 'persisted-turn', 8),
      fileChange('different-id', 'other-turn', 2),
    ])
    expect(state.getMessages('thread-1')).toEqual([fileChange('third-id', 'turn-3', 3)])
    state.removePersistedIn('thread-1', [fileChange('different-id', 'turn-3', 3)])
    expect('thread-1' in messagesByThreadId.value).toBe(false)
  })

  it('clears, prunes, and resets without empty entries', () => {
    const messagesByThreadId = ref<Record<string, UiMessage[]>>({
      'thread-1': [fileChange('change-1')],
      'thread-2': [fileChange('change-2')],
    })
    const state = createThreadLiveFileChangeState({ messagesByThreadId })
    state.clear('thread-1')
    expect(Object.keys(messagesByThreadId.value)).toEqual(['thread-2'])
    state.prune(new Set(['thread-1']))
    expect(messagesByThreadId.value).toEqual({})
    messagesByThreadId.value = { 'thread-3': [fileChange('change-3')] }
    state.reset()
    expect(messagesByThreadId.value).toEqual({})
    expect(state.getMessages('missing')).toEqual([])
  })
})
