import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeliveryRecord } from '../delivery'
import { DeliveryService } from './deliveryService'
import { DeliveryStore } from './deliveryStore'

const services: DeliveryService[] = []
const dirs: string[] = []
const now = 1788710000000
function input(n = 1, threadId = 'thread') {
  return { threadId, mode: 'immediate' as const, message: { id: `d-${now}-${n}`, text: 'request', model: 'captured-model', effort: 'high', imageUrls: [], skills: [], fileAttachments: [], collaborationMode: 'default' as const } }
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'delivery-service-'))
  dirs.push(dir)
  const store = new DeliveryStore(dir, { now: () => now })
  const dependencies = {
    accountBusy: vi.fn(() => false), context: vi.fn(async () => 'account/provider'), canStart: vi.fn(async () => true),
    submissionBlocked: vi.fn(() => false),
    prepare: vi.fn(async (row: DeliveryRecord): Promise<Record<string, unknown>> => ({ threadId: row.threadId, input: [{ type: 'text', text: row.message.text }], model: row.message.model })),
    start: vi.fn(async (_params: Record<string, unknown>) => ({ turnId: 'native-turn' })),
    inspect: vi.fn(async (_row: DeliveryRecord): Promise<{ turnId?: string }> => ({})), changed: vi.fn(),
  }
  const service = new DeliveryService(store, dependencies)
  services.push(service)
  return { service, store, dependencies }
}
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.dispose()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe('delivery before replay', () => {
  it('records a local quota rejection as unsent rather than an ambiguous upstream submission', async () => {
    const { service, dependencies } = await fixture()
    dependencies.start.mockRejectedValue(Object.assign(new Error('账号额度已保留'), { submissionNotSent: true }))
    const result = await service.submit(input())
    expect(result).toMatchObject({ status: 'failed', error: '账号额度已保留' })
    expect(dependencies.inspect).not.toHaveBeenCalled()
  })
  it('persists during credential refresh and waits to dispatch until refresh ends', async () => {
    const { service, dependencies } = await fixture()
    dependencies.accountBusy.mockReturnValue(true)
    expect(await service.submit(input())).toMatchObject({ status: 'queued' })
    expect(dependencies.start).not.toHaveBeenCalled()
    dependencies.accountBusy.mockReturnValue(false)
    await service.process('thread')
    expect(await service.result(input().message.id)).toMatchObject({ status: 'accepted' })
    expect(dependencies.start).toHaveBeenCalledTimes(1)
  })

  it('rejects a new submission during an explicit account change', async () => {
    const { service, dependencies, store } = await fixture()
    dependencies.submissionBlocked.mockReturnValue(true)
    await expect(service.submit(input())).rejects.toThrow('账号操作')
    expect(await store.records()).toEqual([])
  })

  it('keeps the browser account snapshot when an offline submission arrives after a switch', async () => {
    const { service, dependencies, store } = await fixture()
    dependencies.context.mockResolvedValue('new-account/provider')
    const result = await service.submit({ ...input(), expectedContextId: 'original-account/provider' })
    expect(result).toMatchObject({ status: 'failed', contextId: 'original-account/provider' })
    expect(dependencies.start).not.toHaveBeenCalled()
    expect((await store.records())[0].error).toContain('账号或供应方已变化')
  })

  it('steers a stored message with its captured model and never restores it after a lost response', async () => {
    const { service, dependencies, store } = await fixture()
    const queued = await service.submit({ ...input(), mode: 'queue' }) as DeliveryRecord
    dependencies.canStart.mockResolvedValue(false)
    dependencies.start.mockRejectedValue(new Error('response lost'))
    const result = await service.steer(queued.message.id, queued.revision)
    expect(result).toMatchObject({ status: 'unknown', mode: 'steer' })
    expect(dependencies.start.mock.calls[0]?.[0]).toMatchObject({ model: 'captured-model', clientUserMessageId: queued.message.id })
    expect(await store.records()).toHaveLength(1)
    await service.process('thread')
    expect(dependencies.start).toHaveBeenCalledTimes(1)
  })

  it('coalesces simultaneous evidence checks for the same unknown request', async () => {
    const { service, dependencies } = await fixture()
    dependencies.start.mockRejectedValue(new Error('response lost'))
    await service.submit(input())
    dependencies.inspect.mockClear()
    let finish: (value: { turnId: string }) => void = () => {}
    dependencies.inspect.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const first = service.reconcile(input().message.id)
    const second = service.reconcile(input().message.id)
    await vi.waitFor(() => expect(dependencies.inspect).toHaveBeenCalledTimes(1))
    finish({ turnId: 'native-turn' })
    expect(await first).toMatchObject({ status: 'accepted' })
    expect(await second).toMatchObject({ status: 'accepted' })
  })

  it('submits concurrent identical IDs only once and exposes the native turn receipt', async () => {
    const { service, dependencies, store } = await fixture()
    dependencies.start.mockImplementation(async params => {
      expect((await store.records())[0]?.status).toBe('sending')
      expect(params.clientUserMessageId).toBe(input().message.id)
      return { turnId: 'native-turn' }
    })
    const results = await Promise.all([service.submit(input()), service.submit(input())])
    expect(dependencies.start).toHaveBeenCalledTimes(1)
    expect(results).toEqual([expect.objectContaining({ status: 'accepted', turnId: 'native-turn' }), expect.objectContaining({ status: 'accepted', turnId: 'native-turn' })])
  })

  it('reconciles a lost RPC response by ID without replaying the turn', async () => {
    const { service, dependencies } = await fixture()
    dependencies.start.mockRejectedValue(new Error('response lost'))
    dependencies.inspect.mockResolvedValue({ turnId: 'actually-started' })
    expect(await service.submit(input())).toMatchObject({ status: 'accepted', turnId: 'actually-started' })
    expect(await service.submit(input())).toMatchObject({ status: 'accepted' })
    expect(dependencies.start).toHaveBeenCalledTimes(1)
  })

  it('keeps an unproven submission unknown through repeated drains and retries', async () => {
    const { service, dependencies, store } = await fixture()
    dependencies.start.mockRejectedValue(new Error('connection closed'))
    expect(await service.submit(input())).toMatchObject({ status: 'unknown' })
    await service.process('thread')
    await service.submit(input())
    expect(dependencies.start).toHaveBeenCalledTimes(1)
    await service.submit({ ...input(2), mode: 'queue' })
    await service.process('thread')
    expect((await store.records()).map(row => row.status)).toEqual(['unknown', 'queued'])
  })

  it('never sends when preparation fails, and allows an explicit retry', async () => {
    const { service, dependencies, store } = await fixture()
    dependencies.prepare.mockRejectedValueOnce(new Error('resume unavailable'))
    const failed = await service.submit(input()) as DeliveryRecord
    expect(failed.status).toBe('failed')
    expect(dependencies.start).not.toHaveBeenCalled()
    await store.resume(failed.message.id, failed.revision)
    await service.process('thread')
    expect(dependencies.start).toHaveBeenCalledTimes(1)
  })

  it('does not overwrite an edit made while a thread was being prepared', async () => {
    const { service, dependencies, store } = await fixture()
    dependencies.prepare.mockImplementation(async row => {
      await store.edit(row.message.id, row.revision, 'editor')
      return { threadId: row.threadId }
    })
    expect(await service.submit(input())).toMatchObject({ status: 'editing' })
    expect(dependencies.start).not.toHaveBeenCalled()
  })

  it('defers a normal send on a busy thread and blocks an account operation', async () => {
    const { service, dependencies } = await fixture()
    dependencies.canStart.mockResolvedValue(false)
    expect(await service.submit(input())).toMatchObject({ status: 'queued' })
    expect(dependencies.start).not.toHaveBeenCalled()
    dependencies.accountBusy.mockReturnValue(true)
    dependencies.submissionBlocked.mockReturnValue(true)
    await expect(service.submit(input(2))).rejects.toThrow('账号操作')
  })

  it('accepts only the matching native user clientId from the correct thread', async () => {
    const { service, dependencies } = await fixture()
    dependencies.start.mockRejectedValue(new Error('response lost'))
    await service.submit(input())
    const event = { method: 'item/started', params: { threadId: 'other', turnId: 'native-turn', item: { type: 'userMessage', clientId: input().message.id } } }
    await service.observe(event)
    expect(await service.result(input().message.id)).toMatchObject({ status: 'unknown' })
    event.params.threadId = 'thread'
    await service.observe(event)
    expect(await service.result(input().message.id)).toMatchObject({ status: 'accepted', turnId: 'native-turn' })
  })

  it('limits concurrent thread dispatch to four and leaves excess work queued', async () => {
    const { service, dependencies, store } = await fixture()
    const release: Array<() => void> = []
    dependencies.start.mockImplementation(() => new Promise(resolve => { release.push(() => resolve({ turnId: 'turn' })) }))
    const work = Array.from({ length: 5 }, (_, i) => service.submit(input(i + 1, `thread-${i}`)))
    await vi.waitFor(() => expect(dependencies.start).toHaveBeenCalledTimes(4))
    release.forEach(resolve => resolve())
    await Promise.all(work)
    expect(await store.records()).toHaveLength(1)
    dependencies.start.mockResolvedValue({ turnId: 'last-turn' })
    await service.process((await store.records())[0]!.threadId)
    expect(await store.records()).toHaveLength(0)
  })
})
