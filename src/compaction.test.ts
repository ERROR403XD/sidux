import { describe, expect, it } from 'vitest'
import { compactionFromTurn, updateCompactionMessages } from './compaction'
import { normalizeThreadMessagesV2 } from './api/normalizers/v2'

const item = { id: 'compact-1', type: 'contextCompaction' }
const params = { threadId: 'thread', turnId: 'turn', item, startedAtMs: 1000 }
describe('native compaction progress', () => {
  it('follows item lifecycle, measures duration and ignores stale starts', () => {
    const running = updateCompactionMessages([], 'item/started', params)!
    expect(running[0].compaction?.status).toBe('running')
    const finished = updateCompactionMessages(running, 'item/completed', { ...params, completedAtMs: 3400 })!
    expect(finished[0].compaction).toMatchObject({ status: 'completed', durationMs: 2400 })
    expect(updateCompactionMessages(finished, 'item/started', params)).toBeNull()
    expect(updateCompactionMessages(finished, 'turn/completed', { turn: { id: 'turn', status: 'failed', error: { message: 'Later model error' } } })).toBeNull()
  })
  it('does not call transient retries a failure, and distinguishes final failure from interruption', () => {
    const running = updateCompactionMessages([], 'item/started', params)!
    expect(updateCompactionMessages(running, 'error', { ...params, willRetry: true, error: { message: 'Retrying' } })).toBeNull()
    expect(updateCompactionMessages(running, 'error', { ...params, willRetry: false, error: { message: 'Unauthorized' } })![0].compaction).toMatchObject({ status: 'failed', error: 'Unauthorized' })
    expect(updateCompactionMessages(running, 'turn/completed', { turn: { id: 'turn', status: 'interrupted' } })![0].compaction?.status).toBe('interrupted')
    expect(updateCompactionMessages(running, 'turn/completed', { turn: { id: 'another', status: 'failed' } })).toBeNull()
  })
  it('restores native completed items without misattributing a later turn failure', () => {
    const messages = compactionFromTurn({ id: 'turn', status: 'failed', items: [item, { id: 'later', type: 'agentMessage' }], error: { message: 'Later failure' }, durationMs: 12000 })
    expect(messages[0].compaction?.status).toBe('completed')
    expect(messages[0].compaction?.durationMs).toBeUndefined()
  })
  it('restores the verified no-item compact-task failure once and preserves unrelated errors', () => {
    const turn = { id: 'turn', status: 'failed', items: [], error: { message: 'Error running remote compact task: Unauthorized' }, durationMs: 8994 }
    const messages = normalizeThreadMessagesV2({ thread: { turns: [turn] } } as any)
    expect(messages).toHaveLength(1)
    expect(messages[0].compaction).toMatchObject({ status: 'failed', durationMs: 8994 })
    const other = normalizeThreadMessagesV2({ thread: { turns: [{ ...turn, error: { message: 'Another error' } }] } } as any)
    expect(other[0].messageType).toBe('turnError')
  })
})
