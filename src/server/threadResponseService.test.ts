import { describe, expect, it } from 'vitest'
import {
  mergeStreamTurnErrorsIntoThreadResult,
  trimThreadTurnsInRpcResult,
  type StreamEventFrame,
  type StreamEventReader,
} from './threadResponseService.js'

describe('thread response service', () => {
  it('trims supported thread methods to the last ten turns', () => {
    const result = {
      marker: 'kept',
      thread: {
        id: 'thread-1',
        turns: Array.from({ length: 12 }, (_, index) => ({ id: `turn-${index}` })),
      },
    }

    const trimmed = trimThreadTurnsInRpcResult('thread/read', result) as typeof result & { threadTurnStartIndex: number }
    expect(trimmed.marker).toBe('kept')
    expect(trimmed.threadTurnStartIndex).toBe(2)
    expect(trimmed.thread.turns.map((turn) => turn.id)).toEqual(['turn-2', 'turn-3', 'turn-4', 'turn-5', 'turn-6', 'turn-7', 'turn-8', 'turn-9', 'turn-10', 'turn-11'])
  })

  it('does not trim unsupported methods or short threads', () => {
    const result = {
      thread: {
        id: 'thread-1',
        turns: Array.from({ length: 12 }, (_, index) => ({ id: `turn-${index}` })),
      },
    }
    expect(trimThreadTurnsInRpcResult('thread/list', result)).toBe(result)
    expect(trimThreadTurnsInRpcResult('thread/read', { thread: { turns: [{ id: 'turn-1' }] } })).toEqual({ thread: { turns: [{ id: 'turn-1' }] } })
  })

  it('merges final stream errors without overwriting persisted failures', () => {
    const frames: StreamEventFrame[] = [
      { method: 'error', params: { turnId: 'turn-recovered', message: 'retrying failure' }, atIso: '2026-10-09T00:00:00Z' },
      { method: 'error', params: { turnId: 'turn-recovered', willRetry: true, message: 'retrying again' }, atIso: '2026-10-09T00:00:01Z' },
      { method: 'error', params: { turn_id: 'turn-final', message: 'final failure' }, atIso: '2026-10-09T00:00:02Z' },
      { method: 'turn/completed', params: { turn: { id: 'turn-completed', status: 'completed', error: 'ignored' } }, atIso: '2026-10-09T00:00:03Z' },
    ]
    const streamEvents: StreamEventReader = {
      getStreamEvents: (threadId, limit) => {
        expect(threadId).toBe('thread-1')
        expect(limit).toBe(400)
        return frames
      },
    }
    const result = {
      thread: {
        id: 'thread-1',
        turns: [
          { id: 'turn-recovered', status: 'interrupted' },
          { id: 'turn-final', status: 'inProgress' },
          { id: 'turn-persisted', status: 'failed', error: { message: 'persisted failure' } },
          { id: 'turn-completed', status: 'completed' },
        ],
      },
    }

    const merged = mergeStreamTurnErrorsIntoThreadResult(streamEvents, result) as typeof result
    expect(merged.thread.turns[0]).toEqual({
      id: 'turn-recovered',
      status: 'failed',
      error: { message: 'retrying failure', codexErrorInfo: null, additionalDetails: null },
    })
    expect(merged.thread.turns[1]).toEqual({
      id: 'turn-final',
      status: 'failed',
      error: { message: 'final failure', codexErrorInfo: null, additionalDetails: null },
    })
    expect(merged.thread.turns[2]).toEqual(result.thread.turns[2])
    expect(merged.thread.turns[3]).toEqual(result.thread.turns[3])
  })

  it('returns the original result when no matching stream errors change turns', () => {
    const result = { thread: { id: 'thread-1', turns: [{ id: 'turn-1', status: 'completed' }] } }
    const streamEvents: StreamEventReader = { getStreamEvents: () => [] }
    expect(mergeStreamTurnErrorsIntoThreadResult(streamEvents, result)).toBe(result)
  })
})
