import { describe, expect, it } from 'vitest'
import { bindMessageTurnOrder, mergeTurnOrder } from './historyOrder'

describe('paged turn order', () => {
  it('places a resumed prefix before a turn already received live', () => {
    expect(mergeTurnOrder({ active: 0 }, { old: 0, empty: 1, active: 2 })).toEqual({ old: 0, empty: 1, active: 2 })
  })
  it('keeps empty turns and an overlapping live turn when older history is prepended', () => {
    const recent = { latest: 0, active: 1 }
    const lookup = mergeTurnOrder(recent, { older: 0, empty: 1, latest: 2 }, true)
    expect(lookup).toEqual({ older: 0, empty: 1, latest: 2, active: 3 })
    expect(mergeTurnOrder(lookup, { active: 0, new: 1 })).toEqual({ older: 0, empty: 1, latest: 2, active: 3, new: 4 })
    expect(bindMessageTurnOrder([
      { id: 'q', role: 'assistant', text: 'question', turnId: 'latest', questionOrdinal: 0, turnIndex: 0 },
      { id: 'old', role: 'user', text: 'old', turnId: 'older', turnIndex: 0 },
    ], lookup)).toEqual([
      { id: 'old', role: 'user', text: 'old', turnId: 'older', turnIndex: 0 },
      { id: 'q', role: 'assistant', text: 'question', turnId: 'latest', questionOrdinal: 0, turnIndex: 2 },
    ])
  })
})
