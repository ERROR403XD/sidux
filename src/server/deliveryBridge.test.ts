import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackendQueueProcessor } from './codexAppServerBridge'
import { createDeliveryId } from '../delivery'
import { readPendingWebDeliveries, rememberWebDelivery, submitRememberedDelivery } from '../api/deliveryOutbox'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'delivery-bridge-'))
  let status = 'idle'
  const rpc = vi.fn(async (method: string): Promise<unknown> => {
    if (method === 'thread/read') return { thread: { id: 'fixture', status: { type: status } } }
    if (method === 'turn/start') return { turn: { id: 'native-turn' } }
    return {}
  })
  const processor = new BackendQueueProcessor({
    rpc, taskAccountBusy: () => false, onNotification: () => () => {}, notifyQueueChanged: () => {}, listPendingServerRequests: () => [],
  } as never, { directory, startRecovery: false, context: async () => 'fixture-account' })
  cleanups.push(async () => { await processor.dispose(); await rm(directory, { recursive: true, force: true }) })
  const message = { id: createDeliveryId(), text: 'fixture', imageUrls: [], skills: [], fileAttachments: [], collaborationMode: 'default' as const, model: 'saved-model', effort: 'ultra' }
  return { processor, rpc, message, busy: (value: boolean) => { status = value ? 'active' : 'idle' }, unload: () => { status = 'notLoaded' } }
}

describe('durable bridge delivery', () => {
  it('reads accepted and cancelled receipts without dispatch, reconcile, account access or queue writes', async () => {
    const { processor, rpc, message, busy } = await fixture()
    busy(true)
    await processor.mutate({ protocol: 2, expectedContextId: 'fixture-account', type: 'add', threadId: 'fixture', message })
    const queue = await processor.readState()
    await processor.mutate({ protocol: 2, type: 'remove', threadId: 'fixture', messageId: message.id, revision: queue.fixture[0].delivery!.revision })
    rpc.mockClear()
    const state = await processor.readState()
    expect(await processor.readDeliveryStatuses('fixture', [message.id])).toEqual([{ id: message.id, status: 'cancelled', turnId: undefined }])
    expect(await processor.readDeliveryStatuses('other', [message.id])).toEqual([])
    expect(await processor.readDeliveryStatuses('fixture', ['missing'])).toEqual([])
    expect(await processor.readState()).toEqual(state)
    expect(rpc).not.toHaveBeenCalled()
    await expect(processor.readDeliveryStatuses('fixture', ['../bad'])).rejects.toThrow('无效')
    await expect(processor.readDeliveryStatuses('fixture', Array(101).fill('id'))).rejects.toThrow('无效')
  })
  it('recovers a persisted question reply ID and deduplicates a lost acknowledgement', async () => {
    const { processor, rpc, message } = await fixture()
    const saved = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      get length() { return saved.size },
      key: (index: number) => [...saved.keys()][index] ?? null,
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
      removeItem: (key: string) => saved.delete(key),
    })
    try {
      // This is the ID shape already persisted by answerAsyncQuestions.
      const pending = rememberWebDelivery('delivery', {
        protocol: 2, threadId: 'fixture', mode: 'steer', expectedContextId: 'fixture-account',
        message: { ...message, id: 'question:fixture:question-turn:0' },
        params: { threadId: 'fixture', input: [{ type: 'text', text: message.text }] },
      })
      let loseResponse = true
      const fetch = vi.fn(async (_url, options) => {
        const result = await processor.submit(JSON.parse(options.body))
        if (loseResponse) {
          loseResponse = false
          throw new Error('lost acknowledgement')
        }
        return new Response(JSON.stringify({ data: result }))
      })
      vi.stubGlobal('fetch', fetch)
      await expect(submitRememberedDelivery(pending)).rejects.toThrow('lost acknowledgement')
      const restored = readPendingWebDeliveries('fixture')[0]
      expect(restored).toEqual(pending)
      expect(await submitRememberedDelivery(restored)).toEqual({ data: { id: pending.id, status: 'accepted', turnId: 'native-turn' } })
      expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body)
      expect(rpc.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1)
      const params = (rpc.mock.calls.find(([method]) => method === 'turn/start') as unknown as [string, Record<string, unknown>])[1]
      expect(params.clientUserMessageId).toMatch(/^q-\d{13}-[a-f0-9]{64}$/)
      expect(await processor.deliveries.result(String(params.clientUserMessageId))).toMatchObject({ status: 'accepted', turnId: 'native-turn' })
      expect(readPendingWebDeliveries('fixture')).toEqual([])
      expect(await processor.readState()).toEqual({})
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('retains expiry and account snapshot checks for legacy question replies', async () => {
    const { processor, rpc, message } = await fixture()
    const body = {
      protocol: 2, threadId: 'fixture', mode: 'steer',
      expectedContextId: 'fixture-account',
      message: { ...message, id: 'question:fixture:turn:0' },
      params: { threadId: 'fixture', input: [{ type: 'text', text: message.text }] },
    }
    await expect(processor.submit(body)).rejects.toThrow('刷新页面')
    await expect(processor.submit({ ...body, legacyQuestionCreatedAt: Date.now() - 8 * 86400000 })).rejects.toThrow('发送 ID 已过期')
    const result = await processor.submit({ ...body, legacyQuestionCreatedAt: Date.now(), expectedContextId: 'previous-account' })
    expect(result.status).toBe('failed')
    expect(rpc.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(0)
    expect((await processor.readState()).fixture[0].delivery?.error).toContain('账号或供应方已变化')
  })

  it('rejects old queue mutations without changing records', async () => {
    const { processor, message } = await fixture()
    await expect(processor.mutate({ type: 'add', threadId: 'fixture', message })).rejects.toThrow('刷新')
    expect(await processor.readState()).toEqual({})
  })

  it('deduplicates a lost HTTP response and exposes no private params', async () => {
    const { processor, message, rpc } = await fixture()
    const input = { protocol: 2, expectedContextId: 'fixture-account', threadId: 'fixture', message, params: { threadId: 'fixture', input: [{ type: 'text', text: message.text }], model: message.model } }
    const first = await processor.submit(input)
    const retried = await processor.submit(input)
    expect(first).toEqual({ id: message.id, status: 'accepted', turnId: 'native-turn' })
    expect(retried).toEqual(first)
    expect(rpc.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1)
    expect(await processor.readState()).toEqual({})
    expect(rpc).toHaveBeenCalledWith('thread/read', { threadId: 'fixture', includeTurns: false })
    expect(rpc.mock.calls.some(([method]) => method === 'thread/resume')).toBe(false)
  })

  it('resumes only an unloaded thread and excludes its history payload', async () => {
    const { processor, message, rpc, unload } = await fixture()
    unload()
    const result = await processor.submit({ protocol: 2, expectedContextId: 'fixture-account', threadId: 'fixture', message, params: { threadId: 'fixture', input: [] } })
    expect(result.status).toBe('accepted')
    expect(rpc).toHaveBeenCalledWith('thread/resume', { threadId: 'fixture', excludeTurns: true })
  })

  it('queues an ordinary send when a stale page thinks an active thread is idle', async () => {
    const { processor, message, rpc, busy } = await fixture()
    busy(true)
    const response = await processor.submit({ protocol: 2, expectedContextId: 'fixture-account', threadId: 'fixture', message, params: { threadId: 'fixture', input: [] } })
    expect(response.status).toBe('queued')
    expect(rpc.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(0)
    expect((await processor.readState()).fixture[0]).not.toHaveProperty('params')
    expect((await processor.readState()).fixture[0].delivery?.status).toBe('queued')
  })

  it('keeps edited rows in place, preserves settings, and rejects stale versions', async () => {
    const { processor, message, busy } = await fixture()
    busy(true)
    await processor.mutate({ protocol: 2, expectedContextId: 'fixture-account', type: 'add', threadId: 'fixture', message })
    const editing = await processor.mutate({ protocol: 2, expectedContextId: 'fixture-account', type: 'edit', threadId: 'fixture', messageId: message.id, revision: 1, editToken: 'tab-one' })
    expect(editing.state.fixture[0].delivery?.status).toBe('editing')
    await expect(processor.mutate({ protocol: 2, expectedContextId: 'fixture-account', type: 'remove', threadId: 'fixture', messageId: message.id, revision: 1 })).rejects.toThrow()
    const updated = await processor.mutate({ protocol: 2, expectedContextId: 'fixture-account', type: 'update', threadId: 'fixture', messageId: message.id, revision: 2, editToken: 'tab-one', message: { ...message, text: 'edited', model: 'other' } })
    expect(updated.state.fixture[0]).toMatchObject({ id: message.id, text: 'edited', model: 'saved-model', effort: 'ultra', delivery: { status: 'queued', revision: 3 } })
  })

  it('blocks submissions while provider mutation owns the gate', async () => {
    const { processor, message } = await fixture()
    const release = processor.beginProviderChange()
    await expect(processor.mutate({ protocol: 2, expectedContextId: 'fixture-account', type: 'add', threadId: 'fixture', message })).rejects.toThrow('账号操作')
    release()
    expect(await processor.readState()).toEqual({})
  })
})

it('delivers an interrupted thread continuation through the durable queue exactly once', async () => {
  const { ThreadQuotaResume } = await import('./threadQuotaResume')
  const { processor, rpc, message } = await fixture()
  const home = await mkdtemp(join(tmpdir(), 'resume-delivery-'))
  const submit = vi.fn(async (threadId: string, id: string) => {
    const continuation = { ...message, id, text: '继续之前的工作' }
    const params = await processor.buildQueuedTurnParams({ threadId, message: continuation })
    const response = await processor.submit({ protocol: 2, threadId, message: continuation, params, expectedContextId: 'fixture-account' })
    expect(response.status).toBe('accepted')
  })
  const runtime = { inspect: vi.fn(async () => ({ active: false, turnId: 'interrupted-turn', status: 'interrupted', error: '' })), available: async () => true, submit, cancel: async () => {}, changed: () => {} }
  const service = new ThreadQuotaResume(home, runtime, false)
  cleanups.unshift(async () => { await service.close(); await rm(home, { recursive: true, force: true }) })
  await service.set('fixture', true)
  await service.tick()
  expect((await service.snapshot()).fixture).toMatchObject({ status: 'submitted' })
  await service.tick()
  expect(submit).toHaveBeenCalledTimes(1)
  expect(rpc.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1)
  const id = (await service.snapshot()).fixture!.attemptId!
  expect(await processor.deliveries.result(id)).toMatchObject({ status: 'accepted', turnId: 'native-turn' })
  runtime.inspect.mockResolvedValue({ active: false, turnId: 'native-turn', status: 'completed', error: '' })
  await service.tick()
  await service.tick()
  expect((await service.snapshot()).fixture?.status).toBe('armed')
  expect(submit).toHaveBeenCalledTimes(1)
})
