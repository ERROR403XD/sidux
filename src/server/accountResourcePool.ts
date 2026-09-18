import type { AutomationPreparation } from './automationPreparation.js'

export type WorkerPoolErrorCode =
  /** Pool full and every worker was busy: nothing reclaimable right now. */
  | 'pool_full'
  /** A worker is mid-reclaim, so allocation cannot start yet. */
  | 'worker_reclaiming'
  /** An idle/background-terminal check on a candidate exceeded its per-check cap. */
  | 'idle_check_timeout'
  /** The whole allocation (queue wait + checks + create) exceeded its total cap. */
  | 'allocation_timeout'
  /** The resource factory threw. */
  | 'allocation_failed'
  /** Eviction is disabled for this caller and the pool is full. */
  | 'eviction_denied'

export class WorkerPoolAllocationError extends Error {
  readonly code: WorkerPoolErrorCode
  readonly retryable: boolean
  constructor(code: WorkerPoolErrorCode, message: string, retryable: boolean, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'WorkerPoolAllocationError'
    this.code = code
    this.retryable = retryable
  }
}

/** User-facing copy per failure class; callers without a code fall back to the generic one. */
export function workerPoolAllocationUserMessage(code: WorkerPoolErrorCode | undefined): string {
  if (code === 'pool_full') return '会话运行资源已满，空闲会话正在回收，请稍后重试。'
  return '当前会话运行资源正在回收或暂时不可用，请稍后重试。'
}

export type WorkerPoolResourceMetrics = {
  /** True when the worker owns turns, RPCs or server requests right now. */
  busy: boolean
  activeTurns: number
  nativeRpcs: number
  serverRequests: number
}

export type WorkerPoolDiagnosticSnapshot = {
  capacity: number
  size: number
  busyWorkers: number | null
  idleWorkers: number | null
  reclaimingWorkers: number
  activeTurns: number | null
  pendingNativeRpcs: number | null
  pendingServerRequests: number | null
  allocationInFlight: boolean
  allocationPhase: 'idle' | 'idle_checks' | 'disposing' | 'creating'
  allocationStartedAt: number | null
  allocationWaitingCount: number
  lastReclaimFailure: { at: number; code: string; message: string } | null
  lastAllocationFailure: { at: number; code: string; message: string } | null
}

type PoolOptions<T> = {
  capacity: number
  idle: (resource: T, key: string, preparation?: AutomationPreparation) => boolean | Promise<boolean>
  dispose: (resource: T) => void | Promise<void>
  /** Cheap per-resource counters for diagnostics; must stay identity-free. */
  metrics?: (resource: T, key: string) => WorkerPoolResourceMetrics | null
  /** Total wall clock for one getOrCreate, including queue wait. Default: unbounded (legacy). */
  allocationTimeoutMs?: number
  /** Cap for one candidate idle check during reclaim scans. Default: unbounded (legacy). */
  idleCheckTimeoutMs?: number
  /** Cap for awaiting a reclaiming worker's real shutdown. Default: unbounded (legacy). */
  disposeTimeoutMs?: number
}

function raceWithTimeout<T>(work: Promise<T>, timeoutMs: number, createError: () => Error): Promise<T> {
  if (!Number.isFinite(timeoutMs)) return work
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(createError()), timeoutMs)
  })
  timer?.unref?.()
  return Promise.race([work, timeout]).finally(() => { if (timer) clearTimeout(timer) })
}

/**
 * Bounded lazy resources shared by API and automation account adapters.
 *
 * Allocation is serialized: one chain settles before the next starts. Without
 * guards a single hung idle check would wedge the chain forever (every later
 * caller queues behind it), so pools configured with deadlines race each
 * allocation against a total deadline and mark abandoned work, which stops at
 * its next checkpoint instead of creating or reclaiming anything. The chain
 * promise always settles, so a timed-out allocation can never block the next
 * one.
 */
export class AccountResourcePool<T> extends Map<string, T> {
  private readonly accesses = new Map<string, number>()
  private allocation: Promise<unknown> = Promise.resolve()
  private allocationWaitingCount = 0
  private reclaimingWorkers = 0
  private phase: WorkerPoolDiagnosticSnapshot['allocationPhase'] = 'idle'
  private allocationStartedAt: number | null = null
  private lastReclaimFailure: WorkerPoolDiagnosticSnapshot['lastReclaimFailure'] = null
  private lastAllocationFailure: WorkerPoolDiagnosticSnapshot['lastAllocationFailure'] = null
  private scanSawIdleTimeout = false

  constructor(private options: PoolOptions<T>) { super() }

  getOrCreate(key: string, create: () => T, allowEviction = true, preparation?: AutomationPreparation): Promise<T | null> {
    preparation?.assertActive()
    const cached = this.get(key)
    if (cached) {
      this.accesses.set(key, (this.accesses.get(key) || 0) + 1)
      return Promise.resolve(cached)
    }
    // Only allocation is serialized. Work on existing accounts stays independent.
    const token = { abandoned: false }
    this.allocationWaitingCount++
    const work = this.allocation.then(() => {
      this.allocationWaitingCount--
      return this.runAllocation(key, create, allowEviction, preparation, token)
    })
    const totalTimeoutMs = this.options.allocationTimeoutMs ?? Number.POSITIVE_INFINITY
    let totalTimer: ReturnType<typeof setTimeout> | undefined
    const guarded = new Promise<T | null>((resolve, reject) => {
      if (Number.isFinite(totalTimeoutMs)) {
        totalTimer = setTimeout(() => {
          token.abandoned = true
          reject(new WorkerPoolAllocationError('allocation_timeout', 'worker allocation exceeded its total deadline', true))
        }, totalTimeoutMs)
        totalTimer.unref?.()
      }
      work.then(resolve, reject)
    })
    // The chain must always settle, even when the raced work hangs: abandoned
    // work stops at its next checkpoint instead of blocking later callers.
    this.allocation = guarded.then(() => undefined, () => undefined)
    return preparation ? preparation.read(() => guarded) : guarded
  }

  private async runAllocation(
    key: string,
    create: () => T,
    allowEviction: boolean,
    preparation: AutomationPreparation | undefined,
    token: { abandoned: boolean },
  ): Promise<T | null> {
    if (this.allocationStartedAt === null) this.allocationStartedAt = Date.now()
    try {
      preparation?.assertActive()
      if (token.abandoned) throw new WorkerPoolAllocationError('allocation_timeout', 'worker allocation exceeded its total deadline', true)
      const existing = this.get(key)
      if (existing) {
        this.accesses.set(key, (this.accesses.get(key) || 0) + 1)
        return existing
      }
      if (this.size >= this.options.capacity) {
        if (!allowEviction) {
          this.recordAllocationFailure('eviction_denied', 'pool is full and eviction is disabled for this caller')
          return null
        }
        const reclaimed = await this.reclaimOne(preparation, token)
        if (!reclaimed) {
          if (token.abandoned) throw new WorkerPoolAllocationError('allocation_timeout', 'worker allocation exceeded its total deadline', true)
          throw this.poolExhaustedError()
        }
      }
      preparation?.assertActive()
      if (token.abandoned) throw new WorkerPoolAllocationError('allocation_timeout', 'worker allocation exceeded its total deadline', true)
      this.phase = 'creating'
      let resource: T
      try {
        resource = create()
      } catch (error) {
        this.recordAllocationFailure('allocation_failed', error instanceof Error ? error.message : String(error))
        throw new WorkerPoolAllocationError('allocation_failed', 'worker initialization failed', false, { cause: error })
      }
      this.set(key, resource)
      this.accesses.set(key, 0)
      return resource
    } finally {
      if (this.allocationWaitingCount === 0) {
        this.phase = 'idle'
        this.allocationStartedAt = null
      }
    }
  }

  private poolExhaustedError(): WorkerPoolAllocationError {
    if (this.reclaimingWorkers > 0) {
      return new WorkerPoolAllocationError('worker_reclaiming', 'a worker is being reclaimed', true)
    }
    if (this.scanSawIdleTimeout) {
      return new WorkerPoolAllocationError('idle_check_timeout', 'worker idle checks exceeded their per-check deadline', true)
    }
    return new WorkerPoolAllocationError('pool_full', 'no reclaimable worker was found', true)
  }

  private async reclaimOne(
    preparation: AutomationPreparation | undefined,
    token: { abandoned: boolean },
  ): Promise<boolean> {
    this.phase = 'idle_checks'
    this.scanSawIdleTimeout = false
    for (const [candidateKey, candidate] of this) {
      if (token.abandoned) return false
      preparation?.assertActive()
      const observed = this.accesses.get(candidateKey)
      let idle: boolean
      try {
        idle = await raceWithTimeout(
          Promise.resolve(preparation
            ? preparation.read(async () => this.options.idle(candidate, candidateKey, preparation))
            : this.options.idle(candidate, candidateKey)),
          this.options.idleCheckTimeoutMs ?? Number.POSITIVE_INFINITY,
          () => new WorkerPoolAllocationError('idle_check_timeout', 'worker idle check exceeded its deadline', true),
        )
      } catch (error) {
        // Cancellation must propagate; a broken or slow check only skips its
        // own candidate so the remaining workers can still be examined.
        if (preparation) preparation.assertActive()
        this.scanSawIdleTimeout = true
        this.lastReclaimFailure = {
          at: Date.now(),
          code: error instanceof WorkerPoolAllocationError ? error.code : 'idle_check_failed',
          message: error instanceof Error ? error.message : String(error),
        }
        continue
      }
      preparation?.assertActive()
      if (token.abandoned) return false
      if (!idle) continue
      if (this.accesses.get(candidateKey) !== observed || this.get(candidateKey) !== candidate) continue
      this.phase = 'disposing'
      this.reclaimingWorkers++
      let disposeFailure: { code: string; message: string } | null = null
      try {
        await raceWithTimeout(
          Promise.resolve(this.options.dispose(candidate)),
          this.options.disposeTimeoutMs ?? Number.POSITIVE_INFINITY,
          () => new WorkerPoolAllocationError('worker_reclaiming', 'worker disposal exceeded its deadline', true),
        )
      } catch (error) {
        disposeFailure = {
          code: error instanceof WorkerPoolAllocationError ? 'dispose_timeout' : 'dispose_failed',
          message: error instanceof Error ? error.message : String(error),
        }
      } finally {
        this.reclaimingWorkers--
      }
      this.delete(candidateKey)
      this.accesses.delete(candidateKey)
      if (disposeFailure) {
        this.lastReclaimFailure = { at: Date.now(), ...disposeFailure }
        // The dispose keeps running in the background and the worker's own
        // exit handler still cleans its state; the pool must not keep a
        // half-shut worker hostage, so the slot is released either way.
      }
      return true
    }
    return false
  }

  private recordAllocationFailure(code: string, message: string): void {
    this.lastAllocationFailure = { at: Date.now(), code, message }
  }

  private diagnosticCounters(): { busy: number | null; activeTurns: number; nativeRpcs: number; serverRequests: number } {
    if (!this.options.metrics) return { busy: null, activeTurns: 0, nativeRpcs: 0, serverRequests: 0 }
    let busy = 0
    let activeTurns = 0
    let nativeRpcs = 0
    let serverRequests = 0
    for (const [key, resource] of this) {
      const row = this.options.metrics(resource, key)
      if (!row) continue
      if (row.busy) busy++
      activeTurns += row.activeTurns
      nativeRpcs += row.nativeRpcs
      serverRequests += row.serverRequests
    }
    return { busy, activeTurns, nativeRpcs, serverRequests }
  }

  snapshot(): WorkerPoolDiagnosticSnapshot {
    const counters = this.diagnosticCounters()
    return {
      capacity: this.options.capacity,
      size: this.size,
      busyWorkers: counters.busy,
      idleWorkers: counters.busy === null ? null : this.size - counters.busy,
      reclaimingWorkers: this.reclaimingWorkers,
      activeTurns: counters.activeTurns,
      pendingNativeRpcs: counters.nativeRpcs,
      pendingServerRequests: counters.serverRequests,
      allocationInFlight: this.phase !== 'idle',
      allocationPhase: this.phase,
      allocationStartedAt: this.allocationStartedAt,
      allocationWaitingCount: this.allocationWaitingCount,
      lastReclaimFailure: this.lastReclaimFailure,
      lastAllocationFailure: this.lastAllocationFailure,
    }
  }

  /** Compact identity-free line for logs: counters and failure codes only. */
  snapshotJson(): string {
    const snapshot = this.snapshot()
    return JSON.stringify({
      size: snapshot.size,
      capacity: snapshot.capacity,
      idle: snapshot.idleWorkers,
      reclaiming: snapshot.reclaimingWorkers,
      turns: snapshot.activeTurns,
      nativeRpcs: snapshot.pendingNativeRpcs,
      serverRequests: snapshot.pendingServerRequests,
      phase: snapshot.allocationPhase,
      waiting: snapshot.allocationWaitingCount,
      lastReclaim: snapshot.lastReclaimFailure?.code ?? null,
      lastAllocation: snapshot.lastAllocationFailure?.code ?? null,
    })
  }
}
