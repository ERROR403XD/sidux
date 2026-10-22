import { describe, expect, it } from 'vitest'
import {
  combineHistoryAndLive,
  historyMessageKey,
  mergeMessages,
  messageRenderKey,
  removePersistedLiveMessages,
  removeRedundantLiveAgentMessages,
  sameMessageIdentity,
  upsertMessage,
} from './messageIdentity'
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

it('merges incoming history while reusing equal rows and consuming equivalent optimistic user messages', () => {
  const assistant = message('assistant', 't1')
  const optimistic = message('optimistic', 't1', {
    role: 'user',
    messageType: 'userMessage.optimistic',
    text: ' hello  world ',
  })
  const confirmed = message('native-user', 't1', {
    role: 'user',
    messageType: 'userMessage',
    text: 'hello world',
  })
  const previous = [assistant, optimistic]

  expect(mergeMessages(previous, previous)).toBe(previous)
  expect(mergeMessages(previous, [confirmed, assistant]).map(row => row.id)).toEqual(['native-user', 'assistant'])
  expect(mergeMessages(previous, [confirmed, assistant])[1]).toBe(assistant)
})

it('removes only persisted live agents while retaining question-bearing or non-empty live work', () => {
  const persisted = message('item-1', 't1', { historyOrdinal: 1, messageType: 'agentMessage' })
  const removable = message('live', 't1', { historyOrdinal: 1, messageType: 'agentMessage.live' })
  const question = message('question-live', 't1', {
    historyOrdinal: 2,
    messageType: 'agentMessage.live',
    questions: [{ title: 'question', options: [] }],
  })
  const empty = message('empty-live', 't1', {
    historyOrdinal: 3,
    messageType: 'agentMessage.live',
    text: '  ',
  })
  const live = message('unrelated-live', 't1', { historyOrdinal: 4, messageType: 'agentMessage.live' })

  expect(removeRedundantLiveAgentMessages([removable, question, empty, live], [persisted])).toEqual([question, live])
})

it('removes persisted live rows and upserts messages without copying unchanged state', () => {
  const first = message('first', 't1', { messageType: 'agentMessage.live' })
  const second = message('second', 't1', { messageType: 'agentMessage.live' })
  const current = [first, second]
  const changed = { ...second, text: 'changed' }

  expect(removePersistedLiveMessages([first, second], [second])).toEqual([first])
  expect(upsertMessage([first], second)).toEqual([first, second])
  expect(upsertMessage(current, second)).toBe(current)
  expect(upsertMessage(current, changed)).toEqual([first, changed])
})
