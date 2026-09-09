/** Bounded lazy resources shared by API and automation account adapters. */
export class AccountResourcePool<T> extends Map<string, T> {
  private allocation: Promise<unknown> = Promise.resolve()
  constructor(private options: { capacity: number; idle: (resource: T, key: string) => boolean | Promise<boolean>; dispose: (resource: T) => void | Promise<void> }) { super() }
  getOrCreate(key: string, create: () => T): Promise<T | null> {
    const cached = this.get(key)
    if (cached) return Promise.resolve(cached)
    // Only allocation is serialized. Work on existing accounts stays independent.
    const next = this.allocation.then(async () => {
      const existing = this.get(key)
      if (existing) return existing
      if (this.size >= this.options.capacity) {
        let evicted = false
        for (const [candidateKey, candidate] of this) {
          if (!await this.options.idle(candidate, candidateKey)) continue
          await this.options.dispose(candidate)
          this.delete(candidateKey)
          evicted = true
          break
        }
        if (!evicted) return null
      }
      const resource = create()
      this.set(key, resource)
      return resource
    })
    this.allocation = next.catch(() => undefined)
    return next
  }
}
