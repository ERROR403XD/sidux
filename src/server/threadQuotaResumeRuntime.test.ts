import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDeliveryId } from '../delivery.js'
import type { StoredAccountEntry } from './accountAuthStore.js'
import { BackendQueueProcessor, createBackendQueueRuntimeFixture } from './backendQueueRuntime.js'
import { createThreadQuotaResumeRuntime, createThreadQuotaResumeService } from './threadQuotaResumeRuntime.js'
import { automaticResumeStartedMethod } from '../threadAutomaticResume'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'quota-resume-runtime-'))
  let nativeActive = false
  let turn = { id: 'quota-turn', status: 'failed', error: { message: 'quota exceeded' } as unknown }
  const rpc = vi.fn(async (method: string): Promise<unknown> => {
    if (method === 'config/read') return { config: { model: 'fixture-model' } }
    if (method === 'thread/read') return { thread: { id: 'thread', status: { type: nativeActive ? 'inProgress' : 'idle' }, turns: [turn] } }
    if (method === 'thread/turns/list') return { data: [turn], nextCursor: null }
    if (method === 'turn/start') {
      turn = { id: 'native-turn', status: 'completed', error: null }
      return { turn: { id: turn.id } }
    }
    return {}
  })
  const { runtime, probe } = createBackendQueueRuntimeFixture({ rpc })
  const queue = new BackendQueueProcessor(runtime, { directory: join(home, 'delivery'), startRecovery: false, context: async () => 'fixture-account', features: async () => ({ historyPaging: true, resumeInitialPage: false, exactFork: false }) })
  vi.spyOn(queue, 'deliveryContext').mockResolvedValue('fixture-account')
  const process = { taskAccountBusy: runtime.taskAccountBusy, listPendingServerRequests: runtime.listPendingServerRequests, notifyQuotaResumeChanged: vi.fn(), notifyAccountQuota: vi.fn() }
  const account: StoredAccountEntry = {
    accountId: 'fixture', storageId: 'fixture-account', userId: null, authMode: null, email: null, planType: null,
    credentialRevision: 1, authStatus: 'ready', lastRefreshedAtIso: '', lastVerifiedAtIso: null, lastActivatedAtIso: null,
    quotaSnapshot: { limitId: null, limitName: null, primary: { usedPercent: 10, windowMinutes: 300, resetsAt: null }, secondary: null, credits: null, planType: null },
    quotaUpdatedAtIso: new Date().toISOString(), quotaFailedAtIso: null, quotaStatus: 'ready', quotaError: null, unavailableReason: null,
  }
  const subscribers = new Set<(account: StoredAccountEntry) => void>()
  const coordinator = {
    blocksNewSubmissions: vi.fn(() => false),
    assertSubmissionAllowed: vi.fn(async () => {}),
    store: { readState: vi.fn(async () => ({ schemaVersion: 2, operationEpoch: 0, activeAccountId: account.accountId, activeStorageId: account.storageId, accounts: [account] })) },
    subscribeQuotaUpdates: (listener: (account: StoredAccountEntry) => void) => {
      subscribers.add(listener)
      return () => { subscribers.delete(listener) }
    },
  }
  const { quotaResume, unsubscribeQuota } = createThreadQuotaResumeService(home, process, queue, () => coordinator, false)
  cleanups.push(async () => {
    unsubscribeQuota()
    await quotaResume.close()
    await queue.dispose()
    await rm(home, { recursive: true, force: true })
  })
  return { home, queue, quotaResume, unsubscribeQuota, rpc, probe, account, coordinator, subscribers, process,
    setNativeActive: (value: boolean) => { nativeActive = value },
    adapter: createThreadQuotaResumeRuntime(process, queue, () => coordinator) }
}

describe('quota continuation runtime with the durable delivery owner', () => {
  it('loads the replacement owner only after the predecessor finishes its accepted write', async () => {
    const test = await fixture()
    const page = await test.queue.history.page('thread', { limit: 1 })
    let releaseInspection!: (value: typeof page) => void
    const inspection = new Promise<typeof page>(resolve => { releaseInspection = resolve })
    const inspect = vi.spyOn(test.queue.history, 'page').mockReturnValueOnce(inspection)
    const saving = test.quotaResume.set('thread-a', true)
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(1))
    test.unsubscribeQuota()
    const previousRuntimeStopped = test.quotaResume.close()
    const current = createThreadQuotaResumeService(test.home, test.process, test.queue, () => test.coordinator, false, previousRuntimeStopped)
    let ready = false
    void current.quotaResume.ready.then(() => { ready = true })
    try {
      const setting = current.quotaResume.set('thread-b', true)
      await Promise.resolve()
      await Promise.resolve()
      expect(ready).toBe(false)
      expect(inspect).toHaveBeenCalledTimes(1)
      releaseInspection(page)
      await saving
      await previousRuntimeStopped
      await setting
      expect(Object.keys(await current.quotaResume.snapshot()).sort()).toEqual(['thread-a', 'thread-b'])
      const persisted = JSON.parse(await readFile(join(test.home, 'codexapp-quota-resume.json'), 'utf8'))
      expect(Object.keys(persisted.marks).sort()).toEqual(['thread-a', 'thread-b'])
      expect(ready).toBe(true)
    } finally {
      releaseInspection(page)
      current.unsubscribeQuota()
      await current.quotaResume.close()
    }
  })

  it('submits once and returns to armed after the native continuation completes', async () => {
    const { quotaResume, rpc, probe, queue } = await fixture()
    await quotaResume.set('thread', true)
    await quotaResume.tick()
    const attemptId = (await quotaResume.snapshot()).thread!.attemptId!
    expect(await queue.deliveries.result(attemptId)).toMatchObject({ status: 'accepted', turnId: 'native-turn' })
    queue.history.invalidate('thread')
    await quotaResume.tick()
    await quotaResume.tick()
    expect((await quotaResume.snapshot()).thread?.status).toBe('armed')
    expect(rpc.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1)
    expect(probe.notifications.filter(event => event.method === automaticResumeStartedMethod)).toEqual([
      { method: automaticResumeStartedMethod, params: { threadId: 'thread', deliveryId: attemptId, source: 'quota', turnId: 'native-turn' } },
    ])
  })

  it('waits to notify a queued quota continuation until native startup is accepted', async () => {
    const { adapter, queue, probe, setNativeActive } = await fixture()
    setNativeActive(true)
    const id = createDeliveryId()
    await adapter.submit('thread', id)
    expect(await queue.deliveries.result(id)).toMatchObject({ status: 'queued', message: { resumeSource: 'quota' } })
    expect(probe.notifications).toEqual([])
    setNativeActive(false)
    await queue.deliveries.process('thread')
    expect(probe.notifications.filter(event => event.method === automaticResumeStartedMethod)).toEqual([
      { method: automaticResumeStartedMethod, params: { threadId: 'thread', deliveryId: id, source: 'quota', turnId: 'native-turn' } },
    ])
  })

  it('cancels a queued intent and retains accepted receipt evidence', async () => {
    const { adapter, queue, rpc } = await fixture()
    const id = createDeliveryId()
    const message = { id, text: 'fixture', imageUrls: [], skills: [], fileAttachments: [], collaborationMode: 'default' as const }
    await queue.deliveries.submit({ threadId: 'thread', mode: 'queue', expectedContextId: 'fixture-account', message })
    expect((await adapter.inspect('thread')).active).toBe(true)
    await adapter.cancel(id)
    expect(await queue.readState()).toEqual({})
    const acceptedId = createDeliveryId()
    await adapter.submit('thread', acceptedId)
    await adapter.cancel(acceptedId)
    expect(await queue.deliveries.result(acceptedId)).toMatchObject({ status: 'accepted' })
    expect(await adapter.reconcile!('thread', acceptedId)).toBe('submitted')
    expect(await adapter.reconcile!('other-thread', acceptedId)).toBe('unknown')
    expect(rpc.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1)
  })

  it.each(['queued', 'editing', 'failed'] as const)('cancels an unsubmitted %s quota continuation so it cannot later send', async status => {
    const { quotaResume, queue, rpc, setNativeActive } = await fixture()
    const buildParams = queue.buildQueuedTurnParams.bind(queue)
    vi.spyOn(queue, 'buildQueuedTurnParams').mockImplementationOnce(async input => {
      const params = await buildParams(input)
      // The native conversation becomes busy after the quota check, before admission.
      setNativeActive(true)
      return params
    })
    await quotaResume.set('thread', true)
    await quotaResume.tick()
    const queued = (await queue.store.records())[0]!
    expect(queued.status).toBe('queued')
    if (status === 'editing') await queue.store.edit(queued.message.id, queued.revision, 'quota-editor')
    if (status === 'failed') await queue.store.failed(queued.message.id, queued.revision, 'pre-send failure')
    const pending = (await queue.store.records())[0]!
    expect(pending.status).toBe(status)
    await quotaResume.set('thread', false)
    expect(await quotaResume.snapshot()).toEqual({})
    expect(await queue.store.records()).toEqual([])
    expect(await queue.deliveries.result(pending.message.id)).toMatchObject({ status: 'cancelled' })
    await expect(queue.store.resume(pending.message.id, pending.revision)).rejects.toThrow('移除')
    setNativeActive(false)
    await queue.deliveries.process('thread')
    expect(rpc.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(0)
  })

  it('retains the quota mark when an edit races cancellation and allows a checked retry', async () => {
    const { quotaResume, queue, setNativeActive } = await fixture()
    const buildParams = queue.buildQueuedTurnParams.bind(queue)
    vi.spyOn(queue, 'buildQueuedTurnParams').mockImplementationOnce(async input => {
      const params = await buildParams(input)
      setNativeActive(true)
      return params
    })
    await quotaResume.set('thread', true)
    await quotaResume.tick()
    const remove = queue.store.remove.bind(queue.store)
    vi.spyOn(queue.store, 'remove').mockImplementationOnce(async (id, revision) => {
      await queue.store.edit(id, revision, 'concurrent-editor')
      return remove(id, revision)
    })
    await expect(quotaResume.set('thread', false)).rejects.toThrow('状态已变化')
    expect((await quotaResume.snapshot()).thread?.status).toBe('submitted')
    expect((await queue.store.records())[0]?.status).toBe('editing')
    await quotaResume.set('thread', false)
    expect(await quotaResume.snapshot()).toEqual({})
    expect(await queue.store.records()).toEqual([])
  })

  it('retries only recent claims that have no ledger evidence', async () => {
    const { adapter, rpc } = await fixture()
    const id = createDeliveryId()
    expect(await adapter.reconcile!('thread', id, Date.now())).toBe('waiting')
    expect(await adapter.reconcile!('thread', id, Date.now() - 86400_001)).toBe('unknown')
    expect(await adapter.reconcile!('thread', id)).toBe('unknown')
    expect(rpc.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(0)
  })

  it('requires a fresh quota snapshot and submission admission before continuing', async () => {
    const { adapter, coordinator, account, process } = await fixture()
    expect(await adapter.available()).toBe(true)
    expect(coordinator.assertSubmissionAllowed).toHaveBeenCalledTimes(1)
    account.quotaUpdatedAtIso = new Date(Date.now() - 300_001).toISOString()
    expect(await adapter.available()).toBe(false)
    account.quotaUpdatedAtIso = new Date().toISOString()
    account.quotaSnapshot!.primary!.usedPercent = 100
    expect(await adapter.available()).toBe(false)
    account.quotaSnapshot!.primary!.usedPercent = 10
    coordinator.assertSubmissionAllowed.mockRejectedValueOnce(new Error('protection limit'))
    expect(await adapter.available()).toBe(false)
    process.taskAccountBusy = () => true
    expect(await adapter.available()).toBe(false)
  })

  it('wakes on quota recovery, keeps one subscription, and detaches on close', async () => {
    const { quotaResume, unsubscribeQuota, subscribers, account, process } = await fixture()
    const tick = vi.spyOn(quotaResume, 'tick').mockResolvedValue()
    const emit = () => { for (const listener of subscribers) listener(account) }
    expect(subscribers.size).toBe(1)
    emit()
    emit()
    account.quotaSnapshot!.primary!.usedPercent = 20
    emit()
    account.quotaSnapshot!.primary!.usedPercent = 5
    emit()
    expect(tick).toHaveBeenCalledTimes(2)
    expect(process.notifyAccountQuota).toHaveBeenCalledTimes(4)
    unsubscribeQuota()
    unsubscribeQuota()
    expect(subscribers.size).toBe(0)
    emit()
    expect(tick).toHaveBeenCalledTimes(2)
  })
})
