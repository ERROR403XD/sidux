import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { AccountActivationScheduler } from './accountActivationScheduler'
import { nextActivationAt, validateActivationSettings } from '../accountActivation'
const settings = { enabled: true, accountIds: ['a'], times: ['08:00', '13:00'], timezone: 'UTC' }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture(options: Partial<ConstructorParameters<typeof AccountActivationScheduler>[1]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'activation-test-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  let now = Date.parse('2026-09-08T07:59:30Z')
  let busy = false
  let stamp = '0'
  const send = vi.fn(async () => {})
  const dispose = vi.fn(async () => {})
  const dependencies = {
    model: 'test-model', accountExists: vi.fn(async () => true), busy: () => busy,
    check: vi.fn(async () => ({ allowed: !busy, reason: busy ? '有连接' : '', stamp })),
    wait: vi.fn(async () => { busy = false }),
    prepare: vi.fn(async (_id: string) => ({ send, dispose })),
  }
  const service = new AccountActivationScheduler(directory, { ...dependencies, ...options }, () => now, false)
  cleanups.push(() => service.dispose())
  await service.ready
  return { service, dependencies, directory, send, dispose, setNow(value: string) { now = Date.parse(value) }, setBusy(value: boolean) { busy = value }, setStamp(value: string) { stamp = value } }
}
describe('account activation scheduling and admission', () => {
  it('starts disabled, supports multiple sorted unique times, and sends once per slot', async () => {
    const f = await fixture()
    expect((await f.service.snapshot()).settings.enabled).toBe(false)
    await f.service.configure({ ...settings, times: ['13:00', '08:00', '08:00'] })
    expect((await f.service.snapshot()).settings.times).toEqual(['08:00', '13:00'])
    expect(f.send).not.toHaveBeenCalled()
    f.setNow('2026-09-08T08:00:00Z')
    await Promise.all([f.service.tick(), f.service.tick()])
    await f.service.tick()
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.dispose).toHaveBeenCalledTimes(1)
    f.setNow('2026-09-08T13:00:00Z')
    await f.service.tick()
    expect(f.send).toHaveBeenCalledTimes(2)
    expect((await f.service.snapshot()).runs.every(run => run.status === 'sent')).toBe(true)
  })
  it('skips busy accounts without waiting, reading quota or replaying the slot', async () => {
    const f = await fixture()
    await f.service.configure(settings)
    f.setBusy(true)
    f.setNow('2026-09-08T08:00:00Z')
    await f.service.tick()
    expect(f.dependencies.wait).not.toHaveBeenCalled()
    expect(f.dependencies.check).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
    f.setBusy(false)
    await f.service.tick()
    expect(f.send).not.toHaveBeenCalled()
    expect((await f.service.snapshot()).runs[0].status).toBe('skipped')
  })
  it('serializes accounts even when completion exceeds the original one-minute slot', async () => {
    const f = await fixture()
    const order: string[] = []
    f.dependencies.prepare.mockImplementation(async (id?: string) => ({
      send: vi.fn(async () => { order.push(id!); f.setNow('2026-09-08T08:03:00Z') }),
      dispose: f.dispose,
    }))
    await f.service.configure({ ...settings, accountIds: ['a', 'b'] })
    f.setNow('2026-09-08T08:00:00Z')
    await f.service.tick()
    expect(order).toEqual(['a', 'b'])
    expect(f.dispose).toHaveBeenCalledTimes(2)
  })
  it('foreground connection/activity wins during preparation', async () => {
    const f = await fixture()
    f.dependencies.prepare.mockImplementation(async () => { f.setStamp('changed'); return { send: f.send, dispose: f.dispose } })
    await f.service.configure(settings)
    f.setNow('2026-09-08T08:00:00Z')
    await f.service.tick()
    expect(f.send).not.toHaveBeenCalled()
    expect(f.dispose).toHaveBeenCalledOnce()
    expect((await f.service.snapshot()).runs[0].status).toBe('skipped')
  })
  it('disabling during preparation cancels admission and retains configured times', async () => {
    const f = await fixture()
    f.dependencies.prepare.mockImplementation(async () => { await f.service.configure({ ...settings, enabled: false }); return { send: f.send, dispose: f.dispose } })
    await f.service.configure(settings)
    f.setNow('2026-09-08T08:00:00Z')
    await f.service.tick()
    expect(f.send).not.toHaveBeenCalled()
    expect((await f.service.snapshot()).settings.times).toEqual(settings.times)
  })
  it('allows imprecise timing but never retries an uncertain request after restart', async () => {
    const f = await fixture()
    await f.service.configure(settings)
    f.setNow('2026-09-08T08:02:00Z')
    await f.service.tick()
    expect(f.send).toHaveBeenCalledOnce()
    f.send.mockClear()
    f.send.mockRejectedValue(new Error('结果未知'))
    f.setNow('2026-09-08T13:00:00Z')
    await f.service.tick()
    await f.service.tick()
    expect(f.send).toHaveBeenCalledOnce()
    expect((await f.service.snapshot()).runs[0].status).toBe('unknown')
    await f.service.dispose()
    const restarted = new AccountActivationScheduler(f.directory, f.dependencies, () => Date.parse('2026-09-08T13:00:30Z'), false)
    cleanups.push(() => restarted.dispose())
    await restarted.ready
    await restarted.tick()
    expect(f.send).toHaveBeenCalledOnce()
    const saved = JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8'))
    expect(saved.claims).toHaveProperty(JSON.stringify(['a', 'UTC', '2026-09-08', '13:00']))
  })
  it('rejects invalid times, allows editing empty schedules and handles DST without running missing local times', () => {
    expect(() => validateActivationSettings({ ...settings, times: ['25:00'] })).toThrow()
    expect(nextActivationAt(validateActivationSettings({ ...settings, accountIds: [] }), Date.now())).toBeNull()
    const next = nextActivationAt({ ...settings, times: ['02:30'], timezone: 'America/New_York' }, Date.parse('2026-03-08T06:59:00Z'))
    expect(new Date(next!).toISOString()).toBe('2026-03-09T06:30:00.000Z')
  })
})


describe('optional activation failures do not stall scheduling', () => {
  it('bounds a hung send and cleanup and continues the next account', async () => {
    const f = await fixture({ timeoutMs: 30, cleanupMs: 10 })
    let calls = 0
    f.dependencies.prepare.mockImplementation(async () => ++calls === 1
      ? { send: vi.fn(() => new Promise<void>(() => {})), dispose: vi.fn(() => new Promise<void>(() => {})) }
      : { send: f.send, dispose: f.dispose })
    await f.service.configure({ ...settings, accountIds: ['a', 'b'] })
    f.setNow('2026-09-08T08:00:00Z')
    await f.service.tick()
    const result = await f.service.snapshot()
    expect(result.error).toBe('')
    expect(result.runs.map(run => run.status)).toEqual(['sent', 'unknown'])
    expect(f.send).toHaveBeenCalledOnce()
  })
  it('records completion before quota sync and never resends when sync fails or hangs', async () => {
    let f: Awaited<ReturnType<typeof fixture>>
    const afterSend = vi.fn(async () => {
      expect(f.dispose).toHaveBeenCalled()
      expect((await f.service.snapshot()).runs[0].status).toBe('sent')
      return new Promise<string>(() => {})
    })
    f = await fixture({ afterSend, syncMs: 10 })
    await f.service.configure({ ...settings, accountIds: ['a','b'] })
    f.setNow('2026-09-08T08:00:00Z')
    await f.service.tick()
    await f.service.tick()
    expect(f.send).toHaveBeenCalledTimes(2)
    expect((await f.service.snapshot()).runs.every(run => run.status === 'sent' && run.reason.includes('额度同步失败'))).toBe(true)
  })
  it('disabling aborts a hung request promptly without waiting for the run deadline', async () => {
    const f = await fixture({ timeoutMs: 10000 })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    f.send.mockImplementation(async () => { entered(); await new Promise<void>(() => {}) })
    await f.service.configure(settings)
    f.setNow('2026-09-08T08:00:00Z')
    const pending = f.service.tick()
    await started
    await f.service.configure({ ...settings, enabled: false })
    await pending
    expect((await f.service.snapshot()).runs[0].status).toBe('unknown')
    expect(f.dispose).toHaveBeenCalledOnce()
  })
  it('disposes a preparation that resolves after its timeout without sending', async () => {
    const f = await fixture({ timeoutMs: 10 })
    let resolve!: (value: {send: typeof f.send; dispose: typeof f.dispose}) => void
    f.dependencies.prepare.mockImplementation(() => new Promise(done => { resolve = done }))
    await f.service.configure(settings)
    f.setNow('2026-09-08T08:00:00Z')
    await f.service.tick()
    resolve({send:f.send,dispose:f.dispose})
    await new Promise(done => setTimeout(done, 0))
    expect(f.send).not.toHaveBeenCalled()
    expect(f.dispose).toHaveBeenCalledOnce()
  })
})
