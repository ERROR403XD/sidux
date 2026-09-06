import { describe, expect, it } from 'vitest'
import { applyThreadQueueOperation, type StoredQueuedMessage } from './threadQueue'

const message = (id: string): StoredQueuedMessage => ({ id, text: id, imageUrls: [], skills: [], fileAttachments: [], collaborationMode: 'default' })

describe('server queue operations', () => {
  it('preserves concurrent additions on different threads and preserves unrelated messages on remove', () => {
    let state = applyThreadQueueOperation({}, { type: 'add', threadId: 'a', message: message('a1') }).state
    state = applyThreadQueueOperation(state, { type: 'add', threadId: 'b', message: message('b1') }).state
    const result = applyThreadQueueOperation(state, { type: 'remove', threadId: 'a', messageId: 'a1' })
    expect(result.removed?.id).toBe('a1')
    expect(result.state).toEqual({ b: [message('b1')] })
  })

  it('does not resurrect a dequeued message when a stale page reorders it', () => {
    const state = { a: [message('a2')] }
    expect(() => applyThreadQueueOperation(state, { type: 'move', threadId: 'a', messageId: 'a1', targetId: 'a2' })).toThrow('已发送')
    expect(state.a.map(row => row.id)).toEqual(['a2'])
  })

  it('preserves concurrent additions when reordering and inserting an edited message', () => {
    const state = { a: [message('a1'), message('a2'), message('from-other-page')] }
    const moved = applyThreadQueueOperation(state, { type: 'move', threadId: 'a', messageId: 'a2', targetId: 'a1' }).state
    const edited = applyThreadQueueOperation(moved, { type: 'add', threadId: 'a', beforeId: 'a1', message: message('edited') }).state
    expect(edited.a?.map(row => row.id)).toEqual(['a2', 'edited', 'a1', 'from-other-page'])
  })

  it('does not duplicate an ID already in the queue', () => {
    const state = { a: [message('a1')] }
    expect(applyThreadQueueOperation(state, { type: 'add', threadId: 'a', message: message('a1') }).state.a).toHaveLength(1)
  })
})
