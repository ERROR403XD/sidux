import { expect, it, vi } from 'vitest'
import { AccountExecutionRegistry, resolveAccountSelection } from './accountExecution.js'
import { AccountResourcePool } from './accountResourcePool.js'

it('resolves all outlets by explicit selection, API default, then primary, without falling back from a removed binding', () => {
  const state = { activeStorageId: 'a', accounts: [{ storageId: 'a' }, { storageId: 'b' }, { storageId: 'c' }] }
  expect(resolveAccountSelection(state)).toEqual({ storageId: 'a', followsPrimary: true })
  expect(resolveAccountSelection(state, { defaultStorageId: 'b' })).toEqual({ storageId: 'b', followsPrimary: false })
  expect(resolveAccountSelection(state, { accountStorageId: 'c', defaultStorageId: 'b' }).storageId).toBe('c')
  expect(() => resolveAccountSelection(state, { accountStorageId: 'removed', defaultStorageId: 'b' })).toThrow('已移除')
})
it('revokes every selected-account adapter while preserving other accounts and invalidating old leases after relogin', () => {
  const registry = new AccountExecutionRegistry()
  const kinds = ['primary', 'api', 'automation', 'activation'] as const
  const close = kinds.map(() => vi.fn())
  const before = registry.generation()
  const leases = kinds.map((kind, index) => registry.register({ storageId: 'a', kind, ownerId: kind, disconnect: close[index]! }))
  const other = vi.fn()
  registry.register({ storageId: 'b', kind: 'api', ownerId: 'b', disconnect: other })
  registry.revoke('a')
  expect(close.every(fn => fn.mock.calls.length === 1)).toBe(true)
  expect(other).not.toHaveBeenCalled()
  expect(registry.removedAfter('a', before)).toBe(true)
  expect(registry.busyAccounts()).toEqual(['b'])
  registry.reopen('a')
  for (const lease of leases) expect(() => lease.assertCurrent()).toThrow('关闭')
  expect(registry.register({ storageId: 'a', kind: 'primary', ownerId: 'new', disconnect: () => {} }).signal.aborted).toBe(false)
})
it('coalesces resource allocation and keeps capacity bounded during concurrent new-account requests', async () => {
  const pool = new AccountResourcePool<{ busy: boolean }>({ capacity: 2, idle: item => !item.busy, dispose: vi.fn(async () => {}) })
  const create = vi.fn(() => ({ busy: true }))
  const resources = await Promise.all([pool.getOrCreate('a', create), pool.getOrCreate('a', create), pool.getOrCreate('b', create), pool.getOrCreate('c', create)])
  expect(resources[0]).toBe(resources[1])
  expect(resources[3]).toBeNull()
  expect(pool.size).toBe(2)
  pool.get('a')!.busy = false
  expect(await pool.getOrCreate('c', create)).toBeTruthy()
  expect(pool.size).toBe(2)
  expect(pool.has('b')).toBe(true)
})

it('continues revocation after one adapter throws during disconnect', () => {
  const registry = new AccountExecutionRegistry()
  registry.register({ storageId: 'a', kind: 'primary', ownerId: 'broken', disconnect: () => { throw new Error('closed transport') } })
  const close = vi.fn()
  const lease = registry.register({ storageId: 'a', kind: 'api', ownerId: 'api', disconnect: close })
  expect(() => registry.revoke('a')).not.toThrow()
  expect(close).toHaveBeenCalledOnce()
  expect(lease.signal.aborted).toBe(true)
  expect(registry.snapshot()).toEqual([])
})

it('does not evict a resource reused while its idle check was pending', async () => {
  let resolveIdle!: (value: boolean) => void
  const dispose = vi.fn()
  const pool = new AccountResourcePool({ capacity: 1, idle: () => new Promise<boolean>(resolve => { resolveIdle = resolve }), dispose })
  const a = await pool.getOrCreate('a', () => ({}))
  const pending = pool.getOrCreate('b', () => ({}))
  await Promise.resolve()
  expect(await pool.getOrCreate('a', () => ({}))).toBe(a)
  resolveIdle(true)
  expect(await pending).toBeNull()
  expect(dispose).not.toHaveBeenCalled()
})
