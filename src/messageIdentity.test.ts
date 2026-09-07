import { describe, expect, it } from 'vitest'
import { combineHistoryAndLive, historyMessageKey, sameMessageIdentity, messageRenderKey } from './messageIdentity'
import type { UiMessage } from './types/codex'
const message = (id: string, turnId = 't1', patch: Partial<UiMessage> = {}): UiMessage => ({ id, turnId, role: 'assistant', text: 'same text', messageType: 'agentMessage', ...patch })
describe('message identity across refresh and live replay', () => {
  it('reconciles reconstructed history IDs by turn and item position', () => {
    const before = message('item-2', 't1', { historyOrdinal: 2048 })
    const after = message('native-id', 't1', { historyOrdinal: 2048 })
    expect(historyMessageKey(before)).toBe(historyMessageKey(after))
    expect(sameMessageIdentity(before, after)).toBe(true)
    expect(sameMessageIdentity(before, { ...after, turnId: 't2' })).toBe(false)
  })
  it('retains equal real messages in different turns and different items', () => {
    expect(combineHistoryAndLive([message('a')], [message('b'), message('a', 't2')])).toHaveLength(3)
  })
  it('keeps one item for repeated live overlays and accepts a longer same-item delta', () => {
    const live = message('a', 't1', { text: 'same text and more', messageType: 'agentMessage.live' })
    expect(combineHistoryAndLive([message('a')], [live, live])).toHaveLength(1)
    expect(combineHistoryAndLive([message('a')], [live])[0].text).toBe(live.text)
    expect(combineHistoryAndLive([], [live, live])).toHaveLength(1)
  })
})

it('scopes rendering and interaction identity to both thread and turn', () => {
  expect(messageRenderKey(message('item-0', 't1'), 'a')).not.toBe(messageRenderKey(message('item-0', 't2'), 'a'))
  expect(messageRenderKey(message('item-0', 't1'), 'a')).not.toBe(messageRenderKey(message('item-0', 't1'), 'b'))
})
