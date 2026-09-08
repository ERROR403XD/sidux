import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { ThreadQuotaResume } from './threadQuotaResume.js'
const homes: string[] = []
const services: ThreadQuotaResume[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()))
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})
async function fixture() {
  const home = await mkdtemp(tmpdir() + '/quota-resume-')
  homes.push(home)
  const runtime = { inspect: vi.fn(async () => ({ active: false, turnId: 'failed-turn', status: 'failed', error: 'quota' })), available: vi.fn(async () => false), submit: vi.fn(async () => {}), cancel: vi.fn(async () => {}), changed: vi.fn() }
  const service = new ThreadQuotaResume(home, runtime, false)
  services.push(service)
  return { home, runtime, service }
}
it('waits for usable unreserved quota and submits once, then cancels queued continuation', async () => {
  const { service, runtime } = await fixture()
  await service.set('thread-a', true)
  await service.tick()
  expect(runtime.submit).not.toHaveBeenCalled()
  runtime.available.mockResolvedValue(true)
  await service.tick()
  await service.tick()
  expect(runtime.submit).toHaveBeenCalledTimes(1)
  const attempt = (await service.snapshot())['thread-a']!.attemptId
  await service.set('thread-a', false)
  expect(runtime.cancel).toHaveBeenCalledWith(attempt)
  expect(await service.snapshot()).toEqual({})
})
it('does not replay ambiguous submissions after restart', async () => {
  const { home, service, runtime } = await fixture()
  runtime.available.mockResolvedValue(true)
  runtime.submit.mockRejectedValue(new Error('connection lost after send'))
  await service.set('thread-a', true)
  await service.tick()
  await service.close()
  const restarted = new ThreadQuotaResume(home, runtime, false)
  services.push(restarted)
  await restarted.tick()
  expect((await restarted.snapshot())['thread-a']?.status).toBe('unknown')
  expect(runtime.submit).toHaveBeenCalledTimes(1)
})
it('returns to waiting only when quota rejection is known to precede sending', async () => {
  const { service, runtime } = await fixture()
  runtime.available.mockResolvedValue(true)
  runtime.submit.mockRejectedValueOnce(Object.assign(new Error('quota'), { retryableQuota: true }))
  await service.set('thread-a', true)
  await service.tick()
  expect((await service.snapshot())['thread-a']?.status).toBe('waiting')
  await service.tick()
  expect(runtime.submit).toHaveBeenCalledTimes(2)
})
it('arms completed threads, waits for quota interruption, and avoids replaying user-completed work', async () => {
  const { service, runtime } = await fixture()
  runtime.inspect.mockResolvedValue({ active: false, turnId: 'complete-turn', status: 'completed', error: '' })
  runtime.available.mockResolvedValue(true)
  await service.set('thread-a', true)
  await service.tick()
  expect(runtime.submit).not.toHaveBeenCalled()
  await service.blocked('thread-a', 'failed-turn')
  await service.tick()
  expect((await service.snapshot())['thread-a']?.status).toBe('armed')
  expect(runtime.submit).not.toHaveBeenCalled()
})

it('reconciles a known pre-submission failure, while preserving ambiguous deliveries', async () => {
  const { home, runtime, service } = await fixture()
  runtime.available.mockResolvedValue(true)
  runtime.submit.mockRejectedValueOnce(new Error('prepare failed'))
  await service.set('thread-a', true)
  await service.tick()
  await service.close()
  const reconcile = vi.fn(async () => 'waiting' as const)
  const restarted = new ThreadQuotaResume(home, { ...runtime, reconcile }, false)
  services.push(restarted)
  await restarted.tick()
  expect(reconcile).toHaveBeenCalledWith('thread-a', expect.any(String), expect.any(Number))
  expect(runtime.submit).toHaveBeenCalledTimes(2)
  expect((await restarted.snapshot())['thread-a']?.status).toBe('submitted')
})
