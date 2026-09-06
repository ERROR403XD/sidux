import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { DeliveryRecord } from '../delivery'
import { DeliveryStore } from './deliveryStore'

const stores: DeliveryStore[] = []
const dirs: string[] = []
const now = 1788710000000
function input(number = 1) {
  return { threadId: 'thread', mode: 'queue' as const, contextId: 'account/provider', message: { id: `d-${now}-${number}`, text: 'original', imageUrls: [], skills: [], fileAttachments: [], collaborationMode: 'default' as const, model: 'selected-model', effort: 'high', serviceTier: 'fast' } }
}
async function fixture(options: ConstructorParameters<typeof DeliveryStore>[1] = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'delivery-'))
  dirs.push(dir)
  const store = new DeliveryStore(dir, { now: () => now, ...options })
  stores.push(store)
  return { dir, store }
}
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.dispose().catch(() => {})))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe('durable delivery records', () => {
  it('waits for the previous runtime to release its writer before initializing', async () => {
    const { store: old, dir } = await fixture()
    await old.add(input())
    let release!: () => void
    const previousRuntimeStopped = new Promise<void>(resolve => { release = resolve })
    const current = new DeliveryStore(dir, { previousRuntimeStopped })
    stores.push(current)
    let finished = false
    const reading = current.records().then(rows => { finished = true; return rows })
    await Promise.resolve()
    expect(finished).toBe(false)
    await old.dispose()
    release()
    expect(await reading).toHaveLength(1)
  })

  it('stops dispatch after a filesystem publication failure', async () => {
    const { store, dir } = await fixture()
    const row = await store.add(input()) as DeliveryRecord
    await rm(join(dir, 'pending.json'))
    await mkdir(join(dir, 'pending.json'))
    await expect(store.sending(row.message.id, row.revision, {}, row.contextId)).rejects.toThrow()
    await expect(store.records()).rejects.toThrow('发送记录保存失败')
  })

  it('coalesces concurrent request IDs and rejects changed content', async () => {
    const { store } = await fixture()
    const [a, b] = await Promise.all([store.add(input()), store.add(input())])
    expect(a).toEqual(b)
    expect(await store.records()).toHaveLength(1)
    await expect(store.add({ ...input(), message: { ...input().message, text: 'different' } })).rejects.toThrow('内容已变化')
  })

  it('persists before submission and recovers sending as unknown after restart', async () => {
    const { store, dir } = await fixture()
    const row = await store.add(input()) as DeliveryRecord
    await store.sending(row.message.id, row.revision, { clientUserMessageId: row.message.id, model: row.message.model }, row.contextId)
    expect(JSON.parse(await readFile(join(dir, 'pending.json'), 'utf8')).records[0].status).toBe('sending')
    await store.dispose()
    const reopened = new DeliveryStore(dir, { now: () => now + 1000 })
    stores.push(reopened)
    const recovered = (await reopened.records())[0]!
    expect(recovered.status).toBe('unknown')
    expect(recovered.params?.clientUserMessageId).toBe(row.message.id)
    await expect(reopened.resume(row.message.id, recovered.revision)).rejects.toThrow('不能重新排队')
    await expect(reopened.remove(row.message.id, recovered.revision)).rejects.toThrow('可能已经送达')
  })

  it('keeps an accepted receipt after removing the pending row', async () => {
    const { store } = await fixture()
    const row = await store.add(input()) as DeliveryRecord
    await store.sending(row.message.id, row.revision, {}, row.contextId)
    const receipt = await store.confirm(row.message.id, 'native-turn')
    expect(receipt).toMatchObject({ status: 'accepted', turnId: 'native-turn' })
    expect(await store.records()).toHaveLength(0)
    expect(await store.add(input())).toEqual(receipt)
    expect(await store.records()).toHaveLength(0)
  })

  it('reconciles a crash after receipt publication but before pending removal', async () => {
    const { store, dir } = await fixture()
    const row = await store.add(input()) as DeliveryRecord
    await store.sending(row.message.id, row.revision, {}, row.contextId)
    const sendingState = await readFile(join(dir, 'pending.json'))
    await store.confirm(row.message.id, 'native-turn')
    await store.dispose()
    await writeFile(join(dir, 'pending.json'), sendingState)
    const reopened = new DeliveryStore(dir, { now: () => now })
    stores.push(reopened)
    expect(await reopened.records()).toHaveLength(0)
    expect(await reopened.add(input())).toMatchObject({ status: 'accepted', turnId: 'native-turn' })
  })

  it('holds edited messages across reload and preserves captured model settings', async () => {
    const { store, dir } = await fixture()
    const row = await store.add(input()) as DeliveryRecord
    const editing = await store.edit(row.message.id, row.revision, 'editor')
    await expect(store.sending(row.message.id, row.revision, {}, row.contextId)).rejects.toThrow('状态已变化')
    await store.dispose()
    const reopened = new DeliveryStore(dir, { now: () => now })
    stores.push(reopened)
    expect((await reopened.records())[0]?.status).toBe('editing')
    await expect(reopened.edit(row.message.id, editing.revision, 'another-editor', { text: 'changed', imageUrls: [], skills: [], fileAttachments: [] })).rejects.toThrow('编辑状态已变化')
    const saved = await reopened.edit(row.message.id, editing.revision, 'editor', { text: 'changed', imageUrls: [], skills: [], fileAttachments: [] })
    expect(saved.message).toMatchObject({ text: 'changed', model: 'selected-model', effort: 'high', serviceTier: 'fast' })
    expect(saved.status).toBe('queued')
    await expect(reopened.remove(row.message.id, editing.revision)).rejects.toThrow('状态已变化')
  })

  it('retries only a known preflight failure and refuses an account context change', async () => {
    const { store } = await fixture()
    const row = await store.add(input()) as DeliveryRecord
    await expect(store.sending(row.message.id, row.revision, {}, 'other-account')).rejects.toThrow('账号或供应方已变化')
    await store.failed(row.message.id, row.revision, 'model unavailable before send')
    const failed = (await store.records())[0]!
    await store.resume(row.message.id, failed.revision)
    expect((await store.records())[0]?.status).toBe('queued')
  })

  it('keeps cancelled IDs as tombstones so stale add requests cannot recreate them', async () => {
    const { store } = await fixture()
    const row = await store.add(input()) as DeliveryRecord
    await store.remove(row.message.id, row.revision)
    expect(await store.add(input())).toMatchObject({ status: 'cancelled' })
    expect(await store.records()).toHaveLength(0)
  })

  it('reorders queued messages and rejects a stale delete or an in-flight move', async () => {
    const { store } = await fixture()
    const a = await store.add(input(1)) as DeliveryRecord
    const b = await store.add(input(2)) as DeliveryRecord
    await store.move(b.message.id, b.revision, a.message.id)
    expect((await store.records()).map(row => row.message.id)).toEqual([b.message.id, a.message.id])
    await expect(store.remove(b.message.id, b.revision)).rejects.toThrow('状态已变化')
    await store.sending(a.message.id, a.revision, {}, a.contextId)
    await expect(store.move(a.message.id, a.revision + 1, b.message.id)).rejects.toThrow('只能重排')
  })

  it('migrates a legacy queue once even if clearing the old field was interrupted', async () => {
    let clearCalls = 0
    const { store, dir } = await fixture({ readLegacy: async () => ({ thread: [input().message] }), clearLegacy: async () => { if (++clearCalls === 1) throw new Error('interrupted clear') } })
    await expect(store.init()).rejects.toThrow('interrupted clear')
    expect(JSON.parse(await readFile(join(dir, 'pending.json'), 'utf8')).records).toHaveLength(1)
    await store.init()
    expect(await store.records()).toHaveLength(1)
    expect(clearCalls).toBe(2)
  })

  it('rejects a second writer and preserves corrupt state rather than treating it as empty', async () => {
    const { store, dir } = await fixture()
    await store.init()
    const second = new DeliveryStore(dir, { now: () => now })
    stores.push(second)
    await expect(second.init()).rejects.toThrow('另一个进程')
    await store.dispose()
    await writeFile(join(dir, 'pending.json'), '{')
    await expect(second.init()).rejects.toThrow()
    expect(await readFile(join(dir, 'pending.json'), 'utf8')).toBe('{')
  })

  it('does not expose mutable internal state through add results', async () => {
    const { store } = await fixture()
    const row = await store.add(input()) as DeliveryRecord
    row.message.text = 'external mutation'
    expect((await store.records())[0]?.message.text).toBe('original')
  })

  it('rejects an expired ID after its receipt is pruned', async () => {
    let clock = now
    const { store } = await fixture({ now: () => clock })
    const row = await store.add(input()) as DeliveryRecord
    await store.remove(row.message.id, row.revision)
    clock += 8 * 86400000
    expect(await store.pruneReceipts()).toBe(1)
    await expect(store.add(input())).rejects.toThrow('发送 ID 已过期')
    expect(await store.records()).toHaveLength(0)
  })
})
