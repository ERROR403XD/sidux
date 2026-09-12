/** One preparation attempt. Cancellation never claims that an issued effect was undone. */
export class AutomationPreparation {
  readonly controller = new AbortController()
  readonly signal = this.controller.signal
  readonly discardedThreadIds = new Set<string>()
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly cleanup = new Set<Promise<void>>()
  private readonly cancellations = new Set<() => void | Promise<void>>()

  constructor(timeoutMs = 90_000, onTimeout: () => void = () => {}) {
    this.timer = setTimeout(() => {
      if (this.signal.aborted) return
      this.cancel(new Error('自动化准备超时'))
      onTimeout()
    }, timeoutMs)
    this.timer.unref?.()
  }

  assertActive(): void {
    if (this.signal.aborted) throw this.signal.reason
  }

  /** Shared reads may finish later; the cancelled caller cannot continue using their result. */
  async read<T>(operation: () => Promise<T>): Promise<T> {
    this.assertActive()
    let abort!: () => void
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(this.signal.reason)
      this.signal.addEventListener('abort', abort, { once: true })
    })
    try {
      const result = await Promise.race([operation(), interrupted])
      this.assertActive()
      return result
    } finally {
      this.signal.removeEventListener('abort', abort)
    }
  }

  /** Wait for an issued effect to settle, including after cancellation, before releasing ownership. */
  async effect<T>(operation: () => Promise<T>): Promise<T> {
    this.assertActive()
    try {
      const result = await operation()
      this.assertActive()
      return result
    } catch (error) {
      // Owned-process shutdown may reject the issued RPC first. Once it really
      // settles, report the preparation cancellation that caused the shutdown.
      this.assertActive()
      throw error
    }
  }

  onCancel(handler: () => void | Promise<void>): () => void {
    this.cancellations.add(handler)
    if (this.signal.aborted) this.runCleanup(handler)
    return () => this.cancellations.delete(handler)
  }

  private runCleanup(handler: () => void | Promise<void>): void {
    const work = Promise.resolve().then(handler)
    this.cleanup.add(work)
    // Keep the rejected result for settle(), without an unhandled-rejection window.
    void work.catch(() => {})
  }

  cancel(reason: Error): void {
    if (this.signal.aborted) return
    this.controller.abort(reason)
    for (const handler of this.cancellations) this.runCleanup(handler)
  }

  async settle(): Promise<void> {
    clearTimeout(this.timer)
    let pending: Promise<void>[]
    do {
      pending = [...this.cleanup]
      await Promise.all(pending)
    } while (pending.length !== this.cleanup.size)
    this.cancellations.clear()
  }
}
