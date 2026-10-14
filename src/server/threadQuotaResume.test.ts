import { mkdtemp, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { ThreadQuotaResume } from './threadQuotaResume.js'
import * as persistence from './apiProxy/store.js'
const homes: string[] = []
const services: ThreadQuotaResume[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(services.splice(0).map(service => service.close()))
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

it('halts failed enabling without publishing an intent or sending after storage recovers', async () => {
  const { home, service, runtime } = await fixture()
  await service.ready
  const path = join(home, 'codexapp-quota-resume.json')
  await mkdir(path)
  await expect(service.set('thread-a', true)).rejects.toThrow('保存结果未确认')
  await rm(path, { recursive: true })
  runtime.available.mockResolvedValue(true)
  await expect(service.tick()).rejects.toThrow('已停止续跑')
  await expect(service.snapshot()).rejects.toThrow('已停止续跑')
  const restarted = new ThreadQuotaResume(home, runtime, false)
  services.push(restarted)
  await restarted.tick()
  expect(await restarted.snapshot()).toEqual({})
  expect(runtime.submit).not.toHaveBeenCalled()
})

it('recovers a failed pre-send claim from durable waiting state instead of becoming stuck submitted', async () => {
  const { home, service, runtime } = await fixture()
  const path = join(home, 'codexapp-quota-resume.json')
  await service.set('thread-a', true)
  await rename(path, `${path}.saved`)
  await mkdir(path)
  runtime.available.mockResolvedValue(true)
  await expect(service.tick()).rejects.toThrow('保存结果未确认')
  await rm(path, { recursive: true })
  await rename(`${path}.saved`, path)
  await expect(service.tick()).rejects.toThrow('已停止续跑')
  expect(runtime.submit).not.toHaveBeenCalled()
  expect(JSON.parse(await readFile(path, 'utf8')).marks['thread-a'].status).toBe('waiting')
  const restarted = new ThreadQuotaResume(home, runtime, false)
  services.push(restarted)
  await restarted.tick()
  await restarted.tick()
  expect(runtime.submit).toHaveBeenCalledTimes(1)
})

it('reconciles an ambiguous committed claim before any retry after restart', async () => {
  const { home, service, runtime } = await fixture()
  await service.set('thread-a', true)
  const write = persistence.privateJson
  vi.spyOn(persistence, 'privateJson').mockImplementationOnce(async (...args) => {
    await write(...args)
    throw Object.assign(new Error('post-rename failure'), { code: 'EIO' })
  })
  runtime.available.mockResolvedValue(true)
  await expect(service.tick()).rejects.toThrow('保存结果未确认')
  await expect(service.tick()).rejects.toThrow('已停止续跑')
  expect(runtime.submit).not.toHaveBeenCalled()
  const reconcile = vi.fn(async () => 'unknown' as const)
  const restarted = new ThreadQuotaResume(home, { ...runtime, reconcile }, false)
  services.push(restarted)
  await restarted.tick()
  expect(reconcile).toHaveBeenCalledOnce()
  expect((await restarted.snapshot())['thread-a']?.status).toBe('unknown')
  expect(runtime.submit).not.toHaveBeenCalled()
})

it('does not treat a failed notification as failed persistence or skip a durable submission', async () => {
  const { service, runtime } = await fixture()
  runtime.changed.mockImplementation(() => { throw new Error('notification unavailable') })
  await service.set('thread-a', true)
  runtime.available.mockResolvedValue(true)
  await service.tick()
  expect(runtime.submit).toHaveBeenCalledOnce()
  expect((await service.snapshot())['thread-a']?.status).toBe('submitted')
})

it('does not swallow a persistence failure as an unreadable thread and dispatch other work', async () => {
  const { service, runtime } = await fixture()
  runtime.inspect.mockResolvedValue({ active: false, turnId: 'done', status: 'completed', error: '' })
  await service.set('thread-a', true)
  runtime.inspect.mockResolvedValue({ active: false, turnId: 'failed-turn', status: 'failed', error: 'quota' })
  await service.set('thread-b', true)
  vi.spyOn(persistence, 'privateJson').mockRejectedValueOnce(new Error('storage unavailable'))
  runtime.available.mockResolvedValue(true)
  await expect(service.tick()).rejects.toThrow('保存结果未确认')
  expect(runtime.available).not.toHaveBeenCalled()
  expect(runtime.submit).not.toHaveBeenCalled()
})

it('keeps a failed removal halted and restores its durable intent on restart', async () => {
  const { home, service, runtime } = await fixture()
  await service.set('thread-a', true)
  vi.spyOn(persistence, 'privateJson').mockRejectedValueOnce(new Error('storage unavailable'))
  await expect(service.set('thread-a', false)).rejects.toThrow('保存结果未确认')
  await expect(service.tick()).rejects.toThrow('已停止续跑')
  const restarted = new ThreadQuotaResume(home, runtime, false)
  services.push(restarted)
  expect((await restarted.snapshot())['thread-a']?.status).toBe('waiting')
  expect(runtime.submit).not.toHaveBeenCalled()
})
async function fixture() {
  const home = await mkdtemp(tmpdir() + '/quota-resume-')
  homes.push(home)
  const runtime = { inspect: vi.fn(async (_id: string) => ({ active: false, turnId: 'failed-turn', status: 'failed', error: 'quota' })), available: vi.fn(async () => false), submit: vi.fn(async () => {}), cancel: vi.fn(async () => {}), changed: vi.fn() }
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

it('recovers missed quota completion events and does not replay against the old failed turn', async () => {
  const { service, runtime } = await fixture()
  runtime.inspect.mockResolvedValue({ active: true, turnId: 'turn-a', status: 'inProgress', error: '' })
  await service.set('thread-a', true)
  runtime.inspect.mockResolvedValue({ active: false, turnId: 'turn-a', status: 'failed', error: 'usageLimitExceeded' })
  runtime.available.mockResolvedValue(true)
  await service.tick()
  await service.tick()
  expect(runtime.submit).toHaveBeenCalledTimes(1)
  expect((await service.snapshot())['thread-a']?.status).toBe('submitted')
})

it('skips an unreadable waiting thread and continues other eligible work', async () => {
  const { service, runtime } = await fixture()
  await service.set('thread-a', true)
  await service.set('thread-b', true)
  runtime.available.mockResolvedValue(true)
  runtime.inspect.mockRejectedValueOnce(new Error('unreadable'))
  await service.tick()
  expect(runtime.submit).toHaveBeenCalledExactlyOnceWith('thread-b', expect.any(String))
})

it('records known pre-send failure and retries with an explicit continuation', async () => {
  const { service, runtime } = await fixture()
  await service.set('thread-a', true)
  runtime.available.mockResolvedValue(true)
  runtime.submit.mockRejectedValueOnce(Object.assign(new Error('续跑参数准备未完成，稍后重试'), { retryableQuota: true }))
  await service.tick()
  expect((await service.snapshot())['thread-a']).toMatchObject({ status: 'waiting', lastError: '续跑参数准备未完成，稍后重试' })
  await service.tick()
  expect((await service.snapshot())['thread-a']?.lastError).toBeUndefined()
  expect(runtime.submit).toHaveBeenCalledTimes(2)
})

it('rotates past eight permanently busy waiting threads without increasing batch or submission limits', async () => {
  const { service, runtime } = await fixture()
  for (let i = 0; i < 10; i++) await service.set(`thread-${i}`, true)
  runtime.available.mockResolvedValue(true)
  runtime.inspect.mockImplementation(async id => ({ active: Number(id.split('-')[1]) < 8, turnId: 'failed-turn', status: 'failed', error: 'quota' }))
  runtime.inspect.mockClear()
  await service.tick()
  expect(runtime.inspect).toHaveBeenCalledTimes(8)
  expect(runtime.submit).not.toHaveBeenCalled()
  runtime.inspect.mockClear()
  await service.tick()
  expect(runtime.inspect.mock.calls.length).toBeLessThanOrEqual(8)
  expect(runtime.submit).toHaveBeenCalledOnce()
  expect(runtime.submit).toHaveBeenCalledWith('thread-8', expect.any(String))
  expect((await service.snapshot())['thread-9']?.status).toBe('waiting')
})

it('eventually reconciles the ninth unknown delivery without replaying the earlier uncertain sends', async () => {
  const { home, service, runtime } = await fixture()
  runtime.available.mockResolvedValue(true)
  runtime.submit.mockRejectedValue(new Error('unknown after send'))
  for (let i = 0; i < 9; i++) {
    await service.set(`thread-${i}`, true)
    await service.tick()
  }
  expect(runtime.submit).toHaveBeenCalledTimes(9)
  await service.close()
  runtime.available.mockResolvedValue(false)
  const reconcile = vi.fn(async (id: string) => id === 'thread-8' ? 'waiting' as const : 'unknown' as const)
  const resumed = new ThreadQuotaResume(home, { ...runtime, reconcile }, false)
  services.push(resumed)
  await resumed.tick()
  expect(reconcile).toHaveBeenCalledTimes(8)
  expect((await resumed.snapshot())['thread-8']?.status).toBe('unknown')
  reconcile.mockClear()
  await resumed.tick()
  expect(reconcile).toHaveBeenCalledTimes(8)
  expect((await resumed.snapshot())['thread-8']).toMatchObject({ status: 'waiting', attemptId: null })
  expect((await resumed.snapshot())['thread-0']?.status).toBe('unknown')
  expect(runtime.submit).toHaveBeenCalledTimes(9)
})

it.each([
  { status: 'interrupted', error: '' },
  { status: 'failed', error: 'model unavailable' },
  { status: 'failed', error: 'network disconnected' },
])('arms $status/$error without immediately resuming non-quota work', async state => {
  const { service, runtime } = await fixture()
  runtime.inspect.mockResolvedValue({ active: false, turnId: 'non-quota-turn', ...state })
  runtime.available.mockResolvedValue(true)
  await service.set('thread-a', true)
  await service.tick()
  await service.tick()
  expect(runtime.submit).not.toHaveBeenCalled()
  expect((await service.snapshot())['thread-a']?.status).toBe('armed')
  runtime.inspect.mockResolvedValue({ active: false, turnId: 'later-quota-turn', status: 'failed', error: 'quota' })
  await service.tick()
  expect(runtime.submit).toHaveBeenCalledTimes(1)
})

it.each(['same-turn-nonquota', 'new-turn-interrupted', 'new-turn-completed'])('rechecks waiting work after the user changes its state: %s', async scenario => {
  const { service, runtime } = await fixture()
  await service.set('thread-a', true)
  runtime.available.mockResolvedValue(true)
  runtime.inspect.mockResolvedValue({
    active: false, turnId: scenario === 'same-turn-nonquota' ? 'failed-turn' : 'new-turn',
    status: scenario === 'new-turn-completed' ? 'completed' : 'interrupted', error: '',
  })
  await service.tick()
  expect(runtime.submit).not.toHaveBeenCalled()
  expect((await service.snapshot())['thread-a']?.status).toBe('armed')
})
