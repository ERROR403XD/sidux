import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { createThreadTurnOrderState } from './threadTurnOrderState'
import type { UiMessage } from '../types/codex'

function persistedMessage(turnIndex: number): UiMessage {
  return {
    id: `message-${turnIndex}`,
    role: 'user',
    text: '',
    turnIndex,
  } as UiMessage
}

describe('thread turn order state', () => {
  it('sets a turn index without rewriting state for an equivalent value', () => {
    const turnIndexByTurnIdByThreadId = ref<Record<string, Record<string, number>>>({})
    const state = createThreadTurnOrderState({ turnIndexByTurnIdByThreadId })
    state.set('thread-1', 'turn-1', 2)
    const first = turnIndexByTurnIdByThreadId.value
    state.set('thread-1', 'turn-1', 2)
    expect(turnIndexByTurnIdByThreadId.value).toBe(first)
    expect(state.getTurnIndex('thread-1', 'turn-1')).toBe(2)
  })

  it('ignores invalid turn identifiers and indexes', () => {
    const turnIndexByTurnIdByThreadId = ref<Record<string, Record<string, number>>>({})
    const state = createThreadTurnOrderState({ turnIndexByTurnIdByThreadId })
    state.set('', 'turn-1', 1)
    state.set('thread-1', '', 1)
    state.set('thread-1', 'turn-1', -1)
    state.set('thread-1', 'turn-1', 1.5)
    expect(turnIndexByTurnIdByThreadId.value).toEqual({})
  })

  it('computes the next index from lookup and persisted messages', () => {
    const turnIndexByTurnIdByThreadId = ref<Record<string, Record<string, number>>>({
      'thread-1': { 'turn-1': 3 },
    })
    const state = createThreadTurnOrderState({ turnIndexByTurnIdByThreadId })
    expect(state.maxTurnIndex('thread-1')).toBe(3)
    expect(state.nextTurnIndex('thread-1', [persistedMessage(5)])).toBe(6)
    expect(state.nextTurnIndex('thread-2', [])).toBe(0)
  })

  it('replaces a lookup once and preserves referential identity for equivalent data', () => {
    const turnIndexByTurnIdByThreadId = ref<Record<string, Record<string, number>>>({
      'thread-1': { 'turn-1': 1, 'turn-2': 2 },
    })
    const state = createThreadTurnOrderState({ turnIndexByTurnIdByThreadId })
    const first = turnIndexByTurnIdByThreadId.value
    state.replace('thread-1', { 'turn-2': 2, 'turn-1': 1 })
    expect(turnIndexByTurnIdByThreadId.value).toBe(first)
    state.replace('thread-1', { 'turn-3': 3 })
    expect(state.getLookup('thread-1')).toEqual({ 'turn-3': 3 })
  })

  it('prunes absent threads and resets all state', () => {
    const turnIndexByTurnIdByThreadId = ref<Record<string, Record<string, number>>>({
      'thread-1': { 'turn-1': 1 },
      'thread-2': { 'turn-2': 2 },
    })
    const state = createThreadTurnOrderState({ turnIndexByTurnIdByThreadId })
    state.prune(new Set(['thread-2']))
    expect(turnIndexByTurnIdByThreadId.value).toEqual({ 'thread-2': { 'turn-2': 2 } })
    state.reset()
    expect(turnIndexByTurnIdByThreadId.value).toEqual({})
  })
})
