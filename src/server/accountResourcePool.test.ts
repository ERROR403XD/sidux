import { describe, expect, it, vi } from 'vitest'
import { AccountResourcePool, WorkerPoolAllocationError, workerPoolAllocationUserMessage } from './accountResourcePool'
import { AutomationPreparation } from './automationPreparation'

const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))

function flushQueue(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

describe('AccountResourcePool allocation lifecycle', () => {
  it('creates a new worker when the pool is not full and reuses cached workers', async () => {
    const pool = new AccountResourcePool<{ id: string }>({ capacity: 2, idle: () => true, dispose: () => {} })
    const a = await pool.getOrCreate('a', () => ({ id: 'a' }))
    const b = await pool.getOrCreate('b', () => ({ id: 'b' }))
    expect(pool.size).toBe(2)
    expect(await pool.getOrCreate('a', () => ({ id: 'other' }))).toBe(a)
    expect(a).toEqual({ id: 'a' })
    expect(b).toEqual({ id: 'b' })
  })

  it('reclaims an idle worker when the pool is full and waits for its disposal', async () => {
    const order: string[] = []
    const dispose = vi.fn(async () => {
      await tick(20)
      order.push('disposed')
    })
    const pool = new AccountResourcePool<{ id: string }>({ capacity: 1, idle: () => true, dispose })
    const a = await pool.getOrCreate('a', () => ({ id: 'a' }))
    const bPromise = pool.getOrCreate('b', () => {
      order.push('created')
      return { id: 'b' }
    })
    const b = await bPromise
    expect(dispose).toHaveBeenCalledWith(a)
    expect(order).toEqual(['disposed', 'created'])
    expect(b).toEqual({ id: 'b' })
    expect(pool.size).toBe(1)
    expect(pool.get('a')).toBeUndefined()
  })

  it('returns a structured pool_full error in bounded time when no worker is reclaimable', async () => {
    const pool = new AccountResourcePool<{ id: string }>({
      capacity: 1,
      idle: () => false,
      dispose: () => {},
      allocationTimeoutMs: 1_000,
    })
    await pool.getOrCreate('a', () => ({ id: 'a' }))
    const startedAt = Date.now()
    const failure = await pool.getOrCreate('b', () => ({ id: 'b' })).then(() => null, (error: unknown) => error)
    expect(failure).toBeInstanceOf(WorkerPoolAllocationError)
    expect((failure as WorkerPoolAllocationError).code).toBe('pool_full')
    expect(Date.now() - startedAt).toBeLessThan(900)
    expect(workerPoolAllocationUserMessage('pool_full')).toBe('会话运行资源已满，空闲会话正在回收，请稍后重试。')
  })

  it('keeps allocating when one candidate idle check hangs, and reports idle_check_timeout', async () => {
    const pool = new AccountResourcePool<{ id: string }>({
      capacity: 1,
      idle: () => new Promise<boolean>(() => {}),
      dispose: () => {},
      allocationTimeoutMs: 1_000,
      idleCheckTimeoutMs: 20,
    })
    await pool.getOrCreate('a', () => ({ id: 'a' }))
    const failure = await pool.getOrCreate('b', () => ({ id: 'b' })).then(() => null, (error: unknown) => error)
    expect(failure).toBeInstanceOf(WorkerPoolAllocationError)
    expect((failure as WorkerPoolAllocationError).code).toBe('idle_check_timeout')
    // The cached path stays independent of the wedged check…
    expect(await pool.getOrCreate('a', () => ({ id: 'a' }))).toEqual({ id: 'a' })
    // …and a later allocation still runs to completion instead of queueing forever.
    const secondFailure = await pool.getOrCreate('c', () => ({ id: 'c' })).then(() => null, (error: unknown) => error)
    expect(secondFailure).toBeInstanceOf(WorkerPoolAllocationError)
    expect((secondFailure as WorkerPoolAllocationError).code).toBe('idle_check_timeout')
    expect(pool.snapshot().lastReclaimFailure?.code).toBe('idle_check_timeout')
  })

  it('recovers with a fresh allocation after a total allocation timeout', async () => {
    let created = 0
    const pool = new AccountResourcePool<{ id: string }>({
      capacity: 1,
      idle: () => new Promise<boolean>(() => {}),
      dispose: () => {},
      allocationTimeoutMs: 60,
      idleCheckTimeoutMs: 5_000,
    })
    await pool.getOrCreate('a', () => ({ id: 'a' }))
    const timedOut = await pool.getOrCreate('b', () => ({ id: 'b' })).then(() => null, (error: unknown) => error)
    expect(timedOut).toBeInstanceOf(WorkerPoolAllocationError)
    expect((timedOut as WorkerPoolAllocationError).code).toBe('allocation_timeout')
    await flushQueue()
    // The abandoned allocation must not have created or evicted anything.
    expect(pool.size).toBe(1)
    expect(created).toBe(0)
    // The chain settled, so the next allocation starts immediately.
    const next = await pool.getOrCreate('a', () => ({ id: 'again' }))
    expect(next).toEqual({ id: 'a' })
  })

  it('does not create a resource after the allocation was abandoned', async () => {
    const create = vi.fn(() => ({ id: 'late' }))
    const pool = new AccountResourcePool<{ id: string }>({
      capacity: 1,
      idle: () => new Promise<boolean>(() => {}),
      dispose: () => {},
      allocationTimeoutMs: 40,
      idleCheckTimeoutMs: 10_000,
    })
    await pool.getOrCreate('a', () => ({ id: 'a' }))
    const timedOut = pool.getOrCreate('b', create).then(() => null, (error: unknown) => error)
    const failure = await timedOut
    expect((failure as WorkerPoolAllocationError).code).toBe('allocation_timeout')
    await tick(50)
    expect(create).not.toHaveBeenCalled()
    expect(pool.size).toBe(1)
  })

  it('caps disposal waiting, records the failure and still releases the slot', async () => {
    const dispose = vi.fn(() => new Promise<void>(() => {}))
    const pool = new AccountResourcePool<{ id: string }>({
      capacity: 1,
      idle: () => true,
      dispose,
      allocationTimeoutMs: 1_000,
      disposeTimeoutMs: 20,
    })
    await pool.getOrCreate('a', () => ({ id: 'a' }))
    const b = await pool.getOrCreate('b', () => ({ id: 'b' }))
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(b).toEqual({ id: 'b' })
    expect(pool.size).toBe(1)
    expect(pool.snapshot().lastReclaimFailure?.code).toBe('dispose_timeout')
  })

  it('reclaims workers in pool insertion order', async () => {
    const disposed: string[] = []
    const pool = new AccountResourcePool<{ id: string }>({
      capacity: 2,
      idle: () => true,
      dispose: resource => { disposed.push(resource.id) },
    })
    await pool.getOrCreate('a', () => ({ id: 'a' }))
    await pool.getOrCreate('a', () => ({ id: 'a' })) // reuse must not change the order
    await pool.getOrCreate('b', () => ({ id: 'b' }))
    await pool.getOrCreate('c', () => ({ id: 'c' }))
    expect(disposed).toEqual(['a'])
    expect(pool.size).toBe(2)
    expect(pool.has('b')).toBe(true)
  })

  it('returns null instead of reclaiming when eviction is disabled', async () => {
    const dispose = vi.fn(() => {})
    const pool = new AccountResourcePool<{ id: string }>({ capacity: 1, idle: () => true, dispose })
    await pool.getOrCreate('a', () => ({ id: 'a' }))
    expect(await pool.getOrCreate('b', () => ({ id: 'b' }), false)).toBeNull()
    expect(dispose).not.toHaveBeenCalled()
    expect(pool.size).toBe(1)
  })

  it('propagates preparation cancellation instead of swallowing it during reclaim scans', async () => {
    const pool = new AccountResourcePool<{ id: string }>({
      capacity: 1,
      idle: () => new Promise<boolean>(() => {}),
      dispose: () => {},
    })
    await pool.getOrCreate('a', () => ({ id: 'a' }))
    const scope = new AutomationPreparation()
    const pending = pool.getOrCreate('b', () => ({ id: 'b' }), true, scope).then(() => 'resolved', (error: unknown) => error)
    await tick(10)
    scope.cancel(new Error('自动化准备超时'))
    const outcome = await pending
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toBe('自动化准备超时')
  })

  it('exposes identity-free diagnostics through metrics', async () => {
    const pool = new AccountResourcePool<{ id: string; turns: number; rpcs: number; requests: number }>({
      capacity: 4,
      idle: () => true,
      dispose: () => {},
      metrics: resource => ({
        busy: resource.turns > 0 || resource.rpcs > 0 || resource.requests > 0,
        activeTurns: resource.turns,
        nativeRpcs: resource.rpcs,
        serverRequests: resource.requests,
      }),
      allocationTimeoutMs: 1_000,
    })
    await pool.getOrCreate('busy', () => ({ id: 'busy', turns: 2, rpcs: 1, requests: 3 }))
    await pool.getOrCreate('idle', () => ({ id: 'idle', turns: 0, rpcs: 0, requests: 0 }))
    const snapshot = pool.snapshot()
    expect(snapshot).toMatchObject({
      capacity: 4,
      size: 2,
      busyWorkers: 1,
      idleWorkers: 1,
      activeTurns: 2,
      pendingNativeRpcs: 1,
      pendingServerRequests: 3,
      allocationInFlight: false,
      allocationPhase: 'idle',
    })
    // The log line stays identity-free as well.
    expect(JSON.parse(pool.snapshotJson())).toMatchObject({ size: 2, idle: 1 })
    expect(pool.snapshotJson()).not.toContain('busy-worker-id')
  })

  it('maps allocation failures to the required user messages', () => {
    expect(workerPoolAllocationUserMessage('pool_full')).toBe('会话运行资源已满，空闲会话正在回收，请稍后重试。')
    expect(workerPoolAllocationUserMessage('worker_reclaiming')).toBe('当前会话运行资源正在回收或暂时不可用，请稍后重试。')
    expect(workerPoolAllocationUserMessage('idle_check_timeout')).toBe('当前会话运行资源正在回收或暂时不可用，请稍后重试。')
    expect(workerPoolAllocationUserMessage('allocation_timeout')).toBe('当前会话运行资源正在回收或暂时不可用，请稍后重试。')
    expect(workerPoolAllocationUserMessage(undefined)).toBe('当前会话运行资源正在回收或暂时不可用，请稍后重试。')
  })
})
