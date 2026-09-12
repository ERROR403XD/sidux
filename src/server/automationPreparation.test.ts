import { expect, it, vi } from 'vitest'
import { AutomationPreparation } from './automationPreparation'
import { AccountResourcePool } from './accountResourcePool'

it('abandons late reads but keeps an issued effect and its cleanup owned until they settle', async () => {
  const scope = new AutomationPreparation(10000)
  let readDone!: (value: string) => void
  let effectDone!: (value: string) => void
  let cleanupDone!: () => void
  const read = scope.read(() => new Promise<string>(resolve => { readDone = resolve })).catch(error => error)
  let effectSettled = false
  const effect = scope.effect(() => new Promise<string>(resolve => { effectDone = resolve })).catch(error => error).finally(() => { effectSettled = true })
  scope.onCancel(() => new Promise<void>(resolve => { cleanupDone = resolve }))
  const cancelled = new Error('cancelled')
  scope.cancel(cancelled)
  expect(await read).toBe(cancelled)
  readDone('late')
  expect(effectSettled).toBe(false)
  let clean = false
  const settlement = scope.settle().then(() => { clean = true })
  effectDone('applied')
  expect(await effect).toBe(cancelled)
  expect(clean).toBe(false)
  cleanupDone()
  await settlement
  expect(clean).toBe(true)
  await expect(scope.read(async () => 'new work')).rejects.toBe(cancelled)
})

it('a cancelled idle check cannot evict or allocate when its late response arrives', async () => {
  let done!: (idle: boolean) => void
  const close = vi.fn()
  const create = vi.fn(() => ({}))
  const pool = new AccountResourcePool({ capacity: 1, idle: () => new Promise<boolean>(resolve => { done = resolve }), dispose: close })
  const original = await pool.getOrCreate('a', create)
  const scope = new AutomationPreparation(10000)
  const pending = pool.getOrCreate('b', create, true, scope).catch(error => error)
  await vi.waitFor(() => expect(done).toBeTypeOf('function'))
  scope.cancel(new Error('timeout'))
  expect(await pending).toBe(scope.signal.reason)
  done(true)
  await scope.settle()
  expect(await pool.getOrCreate('a', create)).toBe(original)
  expect(close).not.toHaveBeenCalled()
  expect(create).toHaveBeenCalledTimes(1)
  expect(pool.has('b')).toBe(false)
})

it('does not relabel a manual cancellation as a later timeout and propagates failed cleanup', async () => {
  const timedOut = vi.fn()
  const scope = new AutomationPreparation(5, timedOut)
  scope.onCancel(async () => { throw new Error('exit not confirmed') })
  scope.cancel(new Error('user cancelled'))
  await new Promise(resolve => setTimeout(resolve, 15))
  expect(timedOut).not.toHaveBeenCalled()
  await expect(scope.settle()).rejects.toThrow('exit not confirmed')
})
