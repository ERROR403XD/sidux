import { describe, expect, it } from 'vitest'
import { formatTurnDuration, insertTurnSummaryMessage } from './turnSummary'
import type { UiMessage } from './types/codex'

const message = (id: string, role: UiMessage['role'], patch: Partial<UiMessage> = {}): UiMessage => ({
  id,
  role,
  text: `${id} text`,
  ...patch,
})

describe('formatTurnDuration', () => {
  it('rounds positive durations and clamps sub-second work', () => {
    expect(formatTurnDuration(0)).toBe('<1s')
    expect(formatTurnDuration(Number.NaN)).toBe('<1s')
    expect(formatTurnDuration(499)).toBe('1s')
    expect(formatTurnDuration(500)).toBe('1s')
    expect(formatTurnDuration(65_400)).toBe('1m 5s')
    expect(formatTurnDuration(3_600_000)).toBe('1h 0m 0s')
    expect(formatTurnDuration(7_230_000)).toBe('2h 0m 30s')
  })
})

describe('insertTurnSummaryMessage', () => {
  it('replaces stale worked summaries and inserts before the last assistant message', () => {
    const messages = [
      message('old-summary', 'system', { messageType: 'worked', turnId: 'old' }),
      message('question', 'user', { turnId: 'turn-1' }),
      message('assistant', 'assistant', { turnId: 'turn-1' }),
      message('latest', 'user', { turnId: 'turn-1' }),
    ]

    expect(insertTurnSummaryMessage(messages, { turnId: 'turn-1', durationMs: 65_400 })).toEqual([
      message('question', 'user', { turnId: 'turn-1' }),
      {
        id: 'turn-summary:turn-1',
        role: 'system',
        text: 'Worked for 1m 5s',
        messageType: 'worked',
        turnId: 'turn-1',
      },
      message('assistant', 'assistant', { turnId: 'turn-1' }),
      message('latest', 'user', { turnId: 'turn-1' }),
    ])
  })

  it('appends the summary when there is no assistant message', () => {
    const messages = [message('question', 'user', { turnId: 'turn-1' })]
    const result = insertTurnSummaryMessage(messages, { turnId: 'turn-1', durationMs: 500 })

    expect(result).toHaveLength(2)
    expect(result[1]).toEqual({
      id: 'turn-summary:turn-1',
      role: 'system',
      text: 'Worked for 1s',
      messageType: 'worked',
      turnId: 'turn-1',
    })
  })
})
