import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { AccountActivationScheduler } from './accountActivationScheduler'
import { nextActivationAt, validateActivationSettings } from '../accountActivation'
const settings = { enabled: true, accountIds: ['a'], times: ['08:00', '13:00'], timezone: 'UTC' }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture() {
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
    quota: vi.fn(async () => ({ usedPercent: 0, windowMinutes: 300 })),
    prepare: vi.fn(async () => ({ send, dispose })),
  }
  const service = new AccountActivationScheduler(directory, dependencies, () => now, false)
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
  it.each([0.01, 10, 100, NaN])('only admits raw usedPercent exactly zero, got %s', async usedPercent => {
    const f = await fixture()
    f.dependencies.quota.mockResolvedValue({ usedPercent, windowMinutes: 300 })
    await f.service.configure(settings)
    f.setNow('2026-09-08T08:00:00Z')
    await f.service.tick()
    expect(f.send).not.toHaveBeenCalled()
    expect(f.dependencies.prepare).not.toHaveBeenCalled()
    expect((await f.service.snapshot()).runs[0].status).toBe('skipped')
  })
  it('skips busy accounts before querying quota, and never substitutes another quota window', async () => {
    const f = await fixture()
    await f.service.configure(settings)
    f.setBusy(true)
    f.setNow('2026-09-08T08:00:00Z')
    await f.service.tick()
    expect(f.dependencies.quota).not.toHaveBeenCalled()
    f.setBusy(false)
    f.dependencies.quota.mockResolvedValue({ usedPercent: 0, windowMinutes: 10080 })
    f.setNow('2026-09-08T13:00:00Z')
    await f.service.tick()
    expect(f.send).not.toHaveBeenCalled()
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
  it('does not backfill missed slots or retry an uncertain request after restart', async () => {
    const f = await fixture()
    await f.service.configure(settings)
    f.setNow('2026-09-08T08:02:00Z')
    await f.service.tick()
    expect(f.send).not.toHaveBeenCalled()
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
  it('rejects invalid/empty enabled schedules and handles DST without running missing local times', () => {
    expect(() => validateActivationSettings({ ...settings, times: ['25:00'] })).toThrow()
    expect(() => validateActivationSettings({ ...settings, accountIds: [] })).toThrow()
    const next = nextActivationAt({ ...settings, times: ['02:30'], timezone: 'America/New_York' }, Date.parse('2026-03-08T06:59:00Z'))
    expect(new Date(next!).toISOString()).toBe('2026-03-09T06:30:00.000Z')
  })
})
