import { describe, expect, it } from 'vitest'
import { createThreadTurnLifecycleState, type ThreadTurnStartInfo } from './threadTurnLifecycleState'

function startedTurn(threadId: string, turnId: string, startedAtMs: number): ThreadTurnStartInfo {
  return { threadId, turnId, startedAtMs }
}

describe('thread turn lifecycle state', () => {
  it('rejects a late start for an already completed turn', () => {
    const state = createThreadTurnLifecycleState()
    state.rememberFinished('thread-1', 'turn-1')
    expect(state.hasFinished('thread-1', 'turn-1')).toBe(true)
    expect(state.rememberStarted(startedTurn('thread-1', 'turn-1', 100))).toBe(false)
    expect(state.takeStarted('turn-1')).toBeNull()
  })

  it('takes a pending start once and preserves its start timestamp', () => {
    const state = createThreadTurnLifecycleState()
    state.rememberStarted(startedTurn('thread-1', 'turn-1', 1250))
    expect(state.takeStarted('turn-1')).toEqual(startedTurn('thread-1', 'turn-1', 1250))
    expect(state.takeStarted('turn-1')).toBeNull()
  })

  it('separates finished turns by thread and turn identifiers', () => {
    const state = createThreadTurnLifecycleState()
    state.rememberFinished('thread-1', 'turn-shared')
    expect(state.hasFinished('thread-2', 'turn-shared')).toBe(false)
    expect(state.rememberStarted(startedTurn('thread-2', 'turn-shared', 200))).toBe(true)
  })

  it('evicts the oldest finished turn beyond the capacity limit', () => {
    const state = createThreadTurnLifecycleState()
    state.rememberFinished('thread-1', 'turn-1')
    for (let index = 2; index <= 2001; index += 1) {
      state.rememberFinished('thread-1', `turn-${index}`)
    }
    expect(state.hasFinished('thread-1', 'turn-1')).toBe(false)
    expect(state.hasFinished('thread-1', 'turn-2')).toBe(true)
    expect(state.hasFinished('thread-1', 'turn-2001')).toBe(true)
  })

  it('clears finished and pending turn state together', () => {
    const state = createThreadTurnLifecycleState()
    state.rememberStarted(startedTurn('thread-1', 'turn-1', 100))
    state.rememberFinished('thread-2', 'turn-2')
    state.clear()
    expect(state.takeStarted('turn-1')).toBeNull()
    expect(state.hasFinished('thread-2', 'turn-2')).toBe(false)
    expect(state.rememberStarted(startedTurn('thread-2', 'turn-2', 200))).toBe(true)
  })
})
