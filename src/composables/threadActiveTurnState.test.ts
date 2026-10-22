import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { createThreadActiveTurnState } from './threadActiveTurnState'

describe('thread active turn state', () => {
  it('sets and reads the active turn for each thread', () => {
    const turnIdByThreadId = ref<Record<string, string>>({})
    const state = createThreadActiveTurnState({ turnIdByThreadId })
    state.setTurnId('thread-1', 'turn-1')
    state.setTurnId('thread-2', 'turn-shared')
    expect(state.getTurnId('thread-1')).toBe('turn-1')
    expect(state.getTurnId('thread-2')).toBe('turn-shared')
    expect(state.getTurnId('missing')).toBeUndefined()
  })

  it('skips equivalent writes and rejects invalid identifiers', () => {
    const turnIdByThreadId = ref<Record<string, string>>({ 'thread-1': 'turn-1' })
    const state = createThreadActiveTurnState({ turnIdByThreadId })
    const first = turnIdByThreadId.value
    state.setTurnId('thread-1', 'turn-1')
    state.setTurnId('', 'turn-2')
    state.setTurnId('thread-2', '')
    expect(turnIdByThreadId.value).toBe(first)
    state.setTurnId('thread-1', 'turn-2')
    expect(turnIdByThreadId.value['thread-1']).toBe('turn-2')
  })

  it('clears one active turn without affecting other threads', () => {
    const turnIdByThreadId = ref<Record<string, string>>({
      'thread-1': 'turn-1',
      'thread-2': 'turn-2',
    })
    const state = createThreadActiveTurnState({ turnIdByThreadId })
    state.clear('thread-1')
    expect(turnIdByThreadId.value).toEqual({ 'thread-2': 'turn-2' })
    state.clear('missing')
    expect(turnIdByThreadId.value).toEqual({ 'thread-2': 'turn-2' })
  })

  it('prunes absent threads and resets all state', () => {
    const turnIdByThreadId = ref<Record<string, string>>({
      'thread-1': 'turn-1',
      'thread-2': 'turn-2',
    })
    const state = createThreadActiveTurnState({ turnIdByThreadId })
    state.prune(new Set(['thread-1']))
    expect(turnIdByThreadId.value).toEqual({ 'thread-1': 'turn-1' })
    state.reset()
    expect(turnIdByThreadId.value).toEqual({})
  })
})
