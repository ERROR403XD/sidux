import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDeliveryId } from '../delivery'
import type { ThreadGoal } from '../threadGoal'
import { BackendQueueProcessor, createBackendQueueRuntimeFixture } from './backendQueueRuntime'
import { createThreadQuotaResumeRuntime } from './threadQuotaResumeRuntime'
import { ThreadQuotaResume } from './threadQuotaResume'
import { createThreadScheduledResumeRuntime } from './threadScheduledResumeRuntime'
import { ThreadScheduledResume } from './threadScheduledResume'
import { automaticResumeStartedMethod } from '../threadAutomaticResume'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'sidux-goal-continuation-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  let now = Date.now()
  let busy = false
  let loseResponse = false
  let failGoalRead = false
  let context = 'fixture-context'
  let unsupportedGoal = false
  let goal: ThreadGoal | null = {
    threadId: 'thread', objective: 'Preserve this goal and its accounting', status: 'usageLimited',
    tokenBudget: 1000, tokensUsed: 200, timeUsedSeconds: 30, createdAt: 100, updatedAt: 200,
  }
  let turn = { id: 'quota-turn', status: 'failed', error: { message: 'quota exceeded' } as unknown }
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const { runtime, probe } = createBackendQueueRuntimeFixture({ rpc: async (method, input) => {
    const params = input as Record<string, unknown>
    calls.push({ method, params })
    if (method === 'config/read') return { config: { model: 'fixture-model' } }
    if (method === 'thread/read') return { thread: { id: 'thread', model: 'fixture-model', status: { type: busy ? 'active' : 'notLoaded' }, turns: [turn] } }
    if (method === 'thread/turns/list') return { data: [turn], nextCursor: null }
    if (method === 'thread/goal/get') {
      if (unsupportedGoal) throw Object.assign(new Error('Method not found'), { code: -32601 })
      if (failGoalRead) throw new Error('goal read unavailable')
      return { goal: structuredClone(goal) }
    }
    if (method === 'thread/goal/set') {
      goal = { ...goal!, status: 'active', updatedAt: goal!.updatedAt + 1 }
      if (loseResponse) throw new Error('goal response lost')
      return { goal: structuredClone(goal) }
    }
    if (method === 'turn/start') {
      turn = { id: 'ordinary-turn', status: 'completed', error: null }
      return { turn: { id: turn.id } }
    }
    return {}
  } })
  const makeQueue = () => {
    const queue = new BackendQueueProcessor(runtime, {
      directory: join(home, 'delivery'), startRecovery: false, context: async () => context,
      features: async () => ({ historyPaging: true, resumeInitialPage: false, exactFork: false }),
    })
    vi.spyOn(queue, 'deliveryContext').mockImplementation(async () => context)
    cleanup.push(() => queue.dispose())
    return queue
  }
  let queue = makeQueue()
  const process = { taskAccountBusy: () => false, listPendingServerRequests: () => [], notifyQuotaResumeChanged: vi.fn(), notifyScheduledResumeChanged: vi.fn(), notifyAccountQuota: vi.fn() }
  const makeQuota = () => {
    const adapter = createThreadQuotaResumeRuntime(process, queue, () => ({
      blocksNewSubmissions: () => false, assertSubmissionAllowed: async () => {}, subscribeQuotaUpdates: () => () => {},
      store: { readState: async () => ({ activeStorageId: 'fixture', accounts: [{ storageId: 'fixture', quotaStatus: 'ready', quotaUpdatedAtIso: new Date().toISOString(), quotaSnapshot: { primary: { usedPercent: 0 } } }] }) },
    }) as never)
    const service = new ThreadQuotaResume(home, adapter, false)
    cleanup.push(() => service.close())
    return service
  }
  const makeSchedule = () => {
    const service = new ThreadScheduledResume(home, createThreadScheduledResumeRuntime(process, queue), () => now, false)
    const unsubscribe = runtime.onNotification(notification => service.observe(notification))
    cleanup.push(async () => { unsubscribe(); await service.close() })
    return service
  }
  return {
    home, calls, probe, makeQuota, makeSchedule, get queue() { return queue },
    get goal() { return goal }, setGoal: (value: ThreadGoal | null) => { goal = value },
    setBusy: (value: boolean) => { busy = value }, advance: () => { now += 2000 },
    changeAccount: () => { context = 'different-account' }, unsupportedGoal: () => { unsupportedGoal = true },
    loseResponse: () => { loseResponse = true }, failGoalRead: () => { failGoalRead = true },
    completePhase: () => { turn = { id: 'goal-phase', status: 'completed', error: null }; queue.history.invalidate('thread') },
    restartQueue: async () => { await queue.dispose(); queue = makeQueue() },
  }
}

describe('GOAL continuation through durable quota and scheduled resume', () => {
  it('resumes a quota-limited goal without sending a continue message or resetting accounting', async () => {
    const test = await fixture()
    const quota = test.makeQuota()
    await quota.set('thread', true)
    await quota.tick()
    const attempt = (await quota.snapshot()).thread!.attemptId!
    expect(test.calls.filter(call => call.method === 'thread/goal/set').map(call => call.params)).toEqual([
      { threadId: 'thread', status: 'active', origin: 'user' },
    ])
    expect(test.calls.some(call => call.method === 'turn/start')).toBe(false)
    expect(test.goal).toMatchObject({ tokenBudget: 1000, tokensUsed: 200, timeUsedSeconds: 30, objective: 'Preserve this goal and its accounting' })
    expect(await test.queue.deliveries.result(attempt)).toMatchObject({ status: 'accepted', goalResume: { createdAt: 100 } })
    expect(test.probe.notifications.filter(event => event.method === automaticResumeStartedMethod)).toEqual([
      { method: automaticResumeStartedMethod, params: { threadId: 'thread', deliveryId: attempt, source: 'quota' } },
    ])
    await quota.tick()
    await quota.close()
    await test.restartQueue()
    const restarted = test.makeQuota()
    await restarted.tick()
    await restarted.tick()
    expect(test.calls.filter(call => call.method === 'thread/goal/set')).toHaveLength(1)
    expect(test.calls.some(call => call.method === 'turn/start')).toBe(false)
    expect(test.probe.notifications.filter(event => event.method === automaticResumeStartedMethod)).toHaveLength(1)
  })

  it('consumes the schedule as soon as GOAL resumes with chosen settings, before any phase completes', async () => {
    const test = await fixture()
    test.setGoal({ ...test.goal!, status: 'paused' })
    const scheduler = test.makeSchedule()
    await scheduler.set('thread', Date.now() + 1000, { model: 'chosen-model', effort: 'ultra', tier: 'fast' })
    expect(test.calls.some(call => call.method === 'thread/goal/set')).toBe(false)
    test.advance()
    await scheduler.tick()
    expect(test.calls.find(call => call.method === 'thread/settings/update')?.params).toEqual({ threadId: 'thread', model: 'chosen-model', effort: 'ultra', serviceTier: 'fast' })
    expect(test.calls.filter(call => call.method === 'thread/goal/set')).toHaveLength(1)
    expect(test.probe.notifications.filter(event => event.method === automaticResumeStartedMethod)).toEqual([
      { method: automaticResumeStartedMethod, params: expect.objectContaining({ threadId: 'thread', source: 'scheduled' }) },
    ])
    expect(test.calls.some(call => call.method === 'turn/start')).toBe(false)
    expect(test.goal?.status).toBe('active')
    expect(await scheduler.snapshot()).toEqual({})
    expect(JSON.parse(await readFile(join(test.home, 'codexapp-scheduled-resume.json'), 'utf8')).marks).toEqual({})
    const reads = test.calls.length
    await scheduler.tick()
    expect(test.calls).toHaveLength(reads)
    await scheduler.close()
    await test.restartQueue()
    const restarted = test.makeSchedule()
    await restarted.tick()
    expect(await restarted.snapshot()).toEqual({})
    expect(test.calls.filter(call => call.method === 'thread/goal/set')).toHaveLength(1)
  })

  it('keeps queued intent until GOAL dispatch starts, then consumes the schedule and preserves its receipt', async () => {
    const test = await fixture()
    test.setGoal(null)
    test.setBusy(true)
    const scheduler = test.makeSchedule()
    await scheduler.set('thread', Date.now() + 1000, { model: 'chosen-model', effort: 'high', tier: '' })
    test.advance()
    await scheduler.tick()
    const attempt = (await scheduler.snapshot()).thread!.attemptId
    expect(await test.queue.deliveries.result(attempt)).toMatchObject({ status: 'queued' })
    test.setGoal({ threadId: 'thread', objective: 'Goal added while queued', status: 'paused', tokensUsed: 0, timeUsedSeconds: 0, createdAt: 300, updatedAt: 300 })
    test.setBusy(false)
    await test.queue.deliveries.process('thread')
    expect(test.calls.filter(call => call.method === 'thread/goal/set')).toHaveLength(1)
    expect(test.calls.some(call => call.method === 'turn/start')).toBe(false)
    expect(test.goal?.status).toBe('active')
    await scheduler.tick()
    expect(await scheduler.snapshot()).toEqual({})
    expect(await test.queue.deliveries.result(attempt)).toMatchObject({ status: 'accepted' })
  })

  it.each(['submitted', 'unknown', 'failed'] as const)('recovers an old %s GOAL marker from its accepted receipt without querying GOAL or history', async status => {
    const test = await fixture()
    const scheduler = test.makeSchedule()
    await scheduler.set('thread', Date.now() + 1000, { model: 'chosen-model', effort: 'high', tier: '' })
    const old = (await scheduler.snapshot()).thread!
    test.advance()
    await scheduler.tick()
    const event = test.probe.notifications.find(event => event.method === automaticResumeStartedMethod)!
    const attemptId = (event.params as { deliveryId: string }).deliveryId
    await scheduler.close()
    await test.restartQueue()
    await writeFile(join(test.home, 'codexapp-scheduled-resume.json'), JSON.stringify({ version: 1, marks: {
      thread: { ...old, status, attemptId, error: 'old completion tracking error' },
    } }))
    test.failGoalRead()
    const reads = test.calls.length
    const recovered = test.makeSchedule()
    await recovered.tick()
    expect(await recovered.snapshot()).toEqual({})
    expect(test.goal?.status).toBe('active')
    expect(test.calls).toHaveLength(reads)
    expect(test.calls.filter(call => call.method === 'thread/goal/set')).toHaveLength(1)
  })

  it('keeps an unconfirmed GOAL startup marked without replaying its mutation', async () => {
    const test = await fixture()
    test.loseResponse()
    const scheduler = test.makeSchedule()
    await scheduler.set('thread', Date.now() + 1000, { model: 'chosen-model', effort: 'high', tier: '' })
    test.advance()
    await scheduler.tick()
    expect((await scheduler.snapshot()).thread?.status).toBe('unknown')
    expect(test.goal?.status).toBe('active')
    await scheduler.close()
    await test.restartQueue()
    const recovered = test.makeSchedule()
    await recovered.tick()
    expect((await recovered.snapshot()).thread?.status).toBe('unknown')
    expect(test.calls.filter(call => call.method === 'thread/goal/set')).toHaveLength(1)
  })

  it.each(['budgetLimited', 'complete'] as const)('does not resume a %s goal or fall back to a continue message', async status => {
    const test = await fixture()
    test.setGoal({ ...test.goal!, status, ...(status === 'budgetLimited' ? { tokensUsed: 1000 } : {}) })
    const quota = test.makeQuota()
    await quota.set('thread', true)
    await quota.tick()
    expect(test.calls.some(call => ['turn/start', 'thread/goal/set'].includes(call.method))).toBe(false)
  })

  it('never falls back to a continue message when the goal cannot be read', async () => {
    const test = await fixture()
    const quota = test.makeQuota()
    await quota.set('thread', true)
    // Fail after arming so both missed-event inspection and dispatch are covered.
    test.failGoalRead()
    await quota.tick()
    expect(test.calls.some(call => ['turn/start', 'thread/goal/set'].includes(call.method))).toBe(false)
  })

  it('detects a native usageLimited goal even when its last phase completed without a quota error', async () => {
    const test = await fixture()
    test.completePhase()
    const quota = test.makeQuota()
    await quota.set('thread', true)
    expect((await quota.snapshot()).thread?.status).toBe('waiting')
    await quota.tick()
    expect(test.calls.filter(call => call.method === 'thread/goal/set')).toHaveLength(1)
    expect(test.calls.some(call => call.method === 'turn/start')).toBe(false)
  })

  it.each(['paused', 'blocked', 'budgetLimited', 'complete'] as const)('does not treat an old quota error as permission to resume a %s goal', async status => {
    const test = await fixture()
    test.setGoal({ ...test.goal!, status })
    const quota = test.makeQuota()
    await quota.set('thread', true)
    await quota.tick()
    expect(test.calls.some(call => ['turn/start', 'thread/goal/set'].includes(call.method))).toBe(false)
  })

  it('cancels a queued GOAL continuation without resuming it later', async () => {
    const test = await fixture()
    test.setBusy(true)
    const scheduler = test.makeSchedule()
    await scheduler.set('thread', Date.now() + 1000, { model: 'chosen-model', effort: 'high', tier: '' })
    test.advance()
    await scheduler.tick()
    const attempt = (await scheduler.snapshot()).thread!.attemptId
    expect(await test.queue.deliveries.result(attempt)).toMatchObject({ status: 'queued', message: { continuation: true } })
    await scheduler.set('thread', null)
    expect(await test.queue.deliveries.result(attempt)).toMatchObject({ status: 'cancelled' })
    test.setBusy(false)
    await test.queue.deliveries.process('thread')
    expect(test.calls.some(call => ['thread/settings/update', 'turn/start', 'thread/goal/set'].includes(call.method))).toBe(false)
  })

  it('rejects an account change without modifying GOAL settings or resuming it', async () => {
    const test = await fixture()
    const scheduler = test.makeSchedule()
    await scheduler.set('thread', Date.now() + 1000, { model: 'chosen-model', effort: 'high', tier: '' })
    test.changeAccount()
    test.advance()
    await scheduler.tick()
    await scheduler.tick()
    expect((await scheduler.snapshot()).thread?.status).toBe('failed')
    expect(test.calls.some(call => ['thread/settings/update', 'turn/start', 'thread/goal/set'].includes(call.method))).toBe(false)
  })

  it.each(['cleared', 'replaced', 'budget-exhausted'] as const)('rechecks a %s goal between preparation and dispatch', async change => {
    const test = await fixture()
    const sending = test.queue.store.sending.bind(test.queue.store)
    vi.spyOn(test.queue.store, 'sending').mockImplementationOnce(async (...args) => {
      const row = await sending(...args)
      test.setGoal(change === 'cleared' ? null : change === 'replaced' ? { ...test.goal!, objective: 'A different goal' } : { ...test.goal!, tokensUsed: 1000 })
      return row
    })
    const scheduler = test.makeSchedule()
    await scheduler.set('thread', Date.now() + 1000, { model: 'chosen-model', effort: 'high', tier: '' })
    test.advance()
    await scheduler.tick()
    await scheduler.tick()
    expect((await scheduler.snapshot()).thread?.status).toBe('failed')
    expect(test.calls.some(call => ['thread/settings/update', 'turn/start', 'thread/goal/set'].includes(call.method))).toBe(false)
  })

  it.each(['paused', 'blocked', 'usageLimited', 'budgetLimited'] as const)('does not restore a consumed schedule when a resumed GOAL later becomes %s', async status => {
    const test = await fixture()
    const scheduler = test.makeSchedule()
    await scheduler.set('thread', Date.now() + 1000, { model: 'chosen-model', effort: 'high', tier: '' })
    test.advance()
    await scheduler.tick()
    expect(await scheduler.snapshot()).toEqual({})
    test.completePhase()
    test.setGoal({ ...test.goal!, status })
    scheduler.observe({ method: 'thread/goal/updated', params: { threadId: 'thread', goal: test.goal } })
    await scheduler.tick()
    expect(await scheduler.snapshot()).toEqual({})
    expect(test.calls.filter(call => call.method === 'thread/goal/set')).toHaveLength(1)
  })

  it.each(['no-goal', 'old-runtime'] as const)('continues ordinary conversations with turn/start for %s', async mode => {
    const test = await fixture()
    test.setGoal(null)
    if (mode === 'old-runtime') test.unsupportedGoal()
    const quota = test.makeQuota()
    await quota.set('thread', true)
    await quota.tick()
    expect(test.calls.filter(call => call.method === 'turn/start')).toHaveLength(1)
    expect(test.calls.some(call => call.method === 'thread/goal/set')).toBe(false)
  })

  it('does not add GOAL reads to ordinary manual messages', async () => {
    const test = await fixture()
    const id = createDeliveryId()
    await test.queue.submit({ protocol: 2, threadId: 'thread', expectedContextId: 'fixture-context', params: { threadId: 'thread', input: [{ type: 'text', text: 'ordinary request' }] }, message: { id, text: 'ordinary request', imageUrls: [], skills: [], fileAttachments: [], collaborationMode: 'default' } })
    expect(test.calls.filter(call => call.method === 'turn/start')).toHaveLength(1)
    expect(test.calls.some(call => call.method.startsWith('thread/goal/'))).toBe(false)
  })

  it('does not replay an unconfirmed goal mutation after restart', async () => {
    const test = await fixture()
    test.loseResponse()
    const quota = test.makeQuota()
    await quota.set('thread', true)
    await quota.tick()
    expect((await quota.snapshot()).thread?.status).toBe('unknown')
    const attempt = (await quota.snapshot()).thread!.attemptId!
    await test.queue.deliveries.observe({ method: 'item/started', params: { threadId: 'thread', turnId: 'unrelated-turn', item: { type: 'userMessage', clientId: attempt } } })
    expect(await test.queue.deliveries.result(attempt)).toMatchObject({ status: 'unknown' })
    await quota.close()
    await test.restartQueue()
    const restarted = test.makeQuota()
    await restarted.tick()
    await test.queue.deliveries.process('thread')
    await restarted.tick()
    expect(test.calls.filter(call => call.method === 'thread/goal/set')).toHaveLength(1)
    expect(test.calls.some(call => call.method === 'turn/start')).toBe(false)
    const before = test.calls.length
    await test.queue.deliveries.reconcile(attempt)
    expect(test.calls).toHaveLength(before)
  })
})
