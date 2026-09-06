import { describe, expect, it } from 'vitest'
import { mergeSubtaskMessage, normalizeSubtaskEvent, readTaskIdentity } from './subtasks'

describe('native task identity and activity', () => {
  it('keeps a normal fork separate from a spawned child, including old source metadata', () => {
    expect(readTaskIdentity({ id: 'fork', forkedFromId: 'main' })?.parentThreadId).toBe('')
    expect(readTaskIdentity({ id: 'child', source: { subAgent: { thread_spawn: { parent_thread_id: 'main', agent_path: '/root/review', agent_nickname: 'Reviewer' } } } })).toMatchObject({ parentThreadId: 'main', nickname: 'Reviewer', path: '/root/review' })
  })
  it('does not convert tool completion into child completion and limits returned text and targets', () => {
    const event = normalizeSubtaskEvent({ id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', receiverThreadIds: Array.from({ length: 80 }, (_, i) => 'child-' + i), agentsStates: { 'child-0': { status: 'running', message: 'x'.repeat(9000) } }, prompt: 'y'.repeat(9000) })!
    expect(event.subtask?.targets[0].status).toBe('running')
    expect(event.subtask?.targets[0].summary.length).toBe(2000)
    expect(event.subtask?.targets).toHaveLength(50)
    expect(event.subtask?.targetCount).toBe(80)
    expect(event.subtask?.prompt.length).toBe(4000)
    const late = { ...event, subtask: { ...event.subtask!, status: 'inProgress' } }
    expect(mergeSubtaskMessage(event, late)).toBe(event)
  })
  it('uses the explicit activity target and does not invent status for an interaction', () => {
    expect(normalizeSubtaskEvent({ id: 'activity', type: 'subAgentActivity', agentThreadId: 'child', agentPath: '/root/work', kind: 'interacted' })?.subtask?.targets[0]).toEqual({ id: 'child', path: '/root/work', status: '', summary: '' })
    expect(normalizeSubtaskEvent({ id: 'activity', type: 'subAgentActivity', agentThreadId: '../wrong', kind: 'completed' })).toBe(null)
  })
})
