import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackendQueueProcessor } from './codexAppServerBridge'
import { createDeliveryId } from '../delivery'

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
    rpc, onNotification: () => () => {}, notifyQueueChanged: () => {}, listPendingServerRequests: () => [],
  } as never, { directory, startRecovery: false, context: async () => 'fixture-account' })
  cleanups.push(async () => { await processor.dispose(); await rm(directory, { recursive: true, force: true }) })
  const message = { id: createDeliveryId(), text: 'fixture', imageUrls: [], skills: [], fileAttachments: [], collaborationMode: 'default' as const, model: 'saved-model', effort: 'ultra' }
  return { processor, rpc, message, busy: (value: boolean) => { status = value ? 'active' : 'idle' }, unload: () => { status = 'notLoaded' } }
}

describe('durable bridge delivery', () => {
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
