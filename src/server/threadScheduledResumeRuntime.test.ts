import { expect, it, vi } from 'vitest'
import { createThreadScheduledResumeRuntime } from './threadScheduledResumeRuntime'
import type { ScheduledResumeMark } from '../threadScheduledResume'

const choice = { model: 'chosen-model', effort: 'ultra', tier: '' }
const mark: ScheduledResumeMark = { at: 1000, status: 'submitted', attemptId: 'delivery-id', choice, contextId: 'context' }
const goalResume = { createdAt: 100, objectiveHash: 'a'.repeat(64) }

it('recognizes accepted startup while the native turn is still running without reading history', async () => {
  const history = { turnState: vi.fn(async () => ({ id: 'running', status: 'inProgress' })) }
  const runtime = createThreadScheduledResumeRuntime({ notifyScheduledResumeChanged: vi.fn() }, {
    history, deliveries: { result: vi.fn(async () => ({ id: mark.attemptId, threadId: 'thread', status: 'accepted', turnId: 'running' })) },
  } as never)
  expect(await runtime.inspect('thread', mark)).toEqual({ status: 'started', turnId: 'running' })
  expect(history.turnState).not.toHaveBeenCalled()
})

it('sends a scheduled delivery with inherited model/effort and returns confirmed startup immediately', async () => {
  const queue = {
    history: { metadata: vi.fn(async () => ({ thread: { model: 'historical-model' } })), turnState: vi.fn() },
    deliveryContext: vi.fn(async () => 'context'),
    buildQueuedTurnParams: vi.fn(async ({ message }) => ({ model: message.model, effort: message.effort })),
    submit: vi.fn(async () => ({ id: mark.attemptId, status: 'accepted', turnId: 'own' })),
    deliveries: { result: vi.fn() }, store: { remove: vi.fn() },
  }
  const runtime = createThreadScheduledResumeRuntime({ notifyScheduledResumeChanged: vi.fn() }, queue as never)
  expect(await runtime.prepare('thread', choice)).toEqual({ choice, contextId: 'context' })
  expect(await runtime.submit('thread', mark)).toBe('started')
  expect(queue.submit).toHaveBeenCalledWith(expect.objectContaining({
    expectedContextId: 'context', message: expect.objectContaining({ id: mark.attemptId, resumeSource: 'scheduled', text: '继续之前的工作', model: 'chosen-model', effort: 'ultra', collaborationMode: 'default' }),
  }))
  expect(queue.history.turnState).not.toHaveBeenCalled()
})

it.each(['queued', 'editing', 'sending'])('keeps a %s delivery until acceptance', async status => {
  const runtime = createThreadScheduledResumeRuntime({ notifyScheduledResumeChanged: vi.fn() }, {
    buildQueuedTurnParams: vi.fn(async () => ({})), submit: vi.fn(async () => ({ status })),
    deliveries: { result: vi.fn(async () => ({ threadId: 'thread', message: { id: mark.attemptId }, status })) },
  } as never)
  expect(await runtime.submit('thread', mark)).toBe('submitted')
  expect(await runtime.inspect('thread', mark)).toEqual({ status: 'submitted' })
})

it.each(['failed', 'unknown', 'cancelled'])('does not consume a %s submission', async status => {
  const runtime = createThreadScheduledResumeRuntime({ notifyScheduledResumeChanged: vi.fn() }, {
    buildQueuedTurnParams: vi.fn(async () => ({})), submit: vi.fn(async () => ({ status })),
  } as never)
  await expect(runtime.submit('thread', mark)).rejects.toThrow('未确认')
})

it('recognizes a GOAL acceptance without querying goal state or waiting for a completed phase', async () => {
  const inspectGoalContinuation = vi.fn()
  const runtime = createThreadScheduledResumeRuntime({ notifyScheduledResumeChanged: vi.fn() }, {
    deliveries: { result: vi.fn(async () => ({ id: mark.attemptId, threadId: 'thread', status: 'accepted', goalResume })) },
    inspectGoalContinuation,
  } as never)
  expect(await runtime.inspect('thread', mark)).toEqual({ status: 'started' })
  expect(inspectGoalContinuation).not.toHaveBeenCalled()
})

it.each([
  { id: 'other', threadId: 'thread', status: 'accepted', turnId: 'own' },
  { id: mark.attemptId, threadId: 'other', status: 'accepted', turnId: 'own' },
  { id: mark.attemptId, threadId: 'thread', status: 'accepted' },
  { id: mark.attemptId, threadId: 'thread', status: 'accepted', goalResume: {} },
])('keeps mismatched or incomplete acceptance evidence: %j', async row => {
  const runtime = createThreadScheduledResumeRuntime({ notifyScheduledResumeChanged: vi.fn() }, {
    deliveries: { result: vi.fn(async () => row) },
  } as never)
  expect(await runtime.inspect('thread', mark)).toEqual({ status: 'unknown' })
})

it.each([false, true])('consumes an unknown delivery only after matching durable reconciliation (mismatch: %s)', async mismatch => {
  const runtime = createThreadScheduledResumeRuntime({ notifyScheduledResumeChanged: vi.fn() }, {
    deliveries: {
      result: vi.fn(async () => ({ threadId: 'thread', status: 'unknown', message: { id: mark.attemptId } })),
      reconcile: vi.fn(async () => ({ id: mark.attemptId, threadId: mismatch ? 'other' : 'thread', status: 'accepted', turnId: 'own' })),
    },
  } as never)
  expect(await runtime.inspect('thread', mark)).toEqual(mismatch ? { status: 'unknown' } : { status: 'started', turnId: 'own' })
})

it.each(['sending', 'unknown', 'accepted'])('does not remove a %s delivery when cancelling its schedule marker', async status => {
  const row = status === 'accepted'
    ? { threadId: 'thread', turnId: 'own', status }
    : { threadId: 'thread', message: { id: mark.attemptId }, status, revision: 1 }
  const remove = vi.fn()
  const runtime = createThreadScheduledResumeRuntime({ notifyScheduledResumeChanged: vi.fn() }, {
    deliveries: { result: vi.fn(async () => row) }, store: { remove },
  } as never)
  await runtime.cancel(mark.attemptId)
  expect(remove).not.toHaveBeenCalled()
})

it('never resubmits a recovered failure whose delivery record is unavailable', async () => {
  const submit = vi.fn()
  const runtime = createThreadScheduledResumeRuntime({ notifyScheduledResumeChanged: vi.fn() }, {
    submit, deliveries: { result: vi.fn(async () => null) },
  } as never)
  const failed = { ...mark, attemptedAt: Date.now(), status: 'failed' as const, error: 'delivery unavailable' }
  for (let index = 0; index < 2; index++) {
    expect(await runtime.inspect('thread', failed)).toEqual({ status: 'failed', error: failed.error })
  }
  expect(submit).not.toHaveBeenCalled()
})

it('keeps a cancelled receipt as a failed schedule rather than treating it as startup', async () => {
  const runtime = createThreadScheduledResumeRuntime({ notifyScheduledResumeChanged: vi.fn() }, {
    deliveries: { result: vi.fn(async () => ({ id: mark.attemptId, threadId: 'thread', status: 'cancelled' })) },
  } as never)
  expect(await runtime.inspect('thread', mark)).toMatchObject({ status: 'failed' })
})
