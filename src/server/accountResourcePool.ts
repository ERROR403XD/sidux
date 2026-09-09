/** Bounded lazy resources shared by API and automation account adapters. */
export class AccountResourcePool<T> extends Map<string, T> {
  private readonly accesses = new Map<string, number>()
  private allocation: Promise<unknown> = Promise.resolve()
  constructor(private options: { capacity: number; idle: (resource: T, key: string) => boolean | Promise<boolean>; dispose: (resource: T) => void | Promise<void> }) { super() }
  getOrCreate(key: string, create: () => T): Promise<T | null> {
    const cached = this.get(key)
    if (cached) {
      this.accesses.set(key, (this.accesses.get(key) || 0) + 1)
      return Promise.resolve(cached)
    }
    // Only allocation is serialized. Work on existing accounts stays independent.
    const next = this.allocation.then(async () => {
      const existing = this.get(key)
      if (existing) {
        this.accesses.set(key, (this.accesses.get(key) || 0) + 1)
        return existing
      }
      if (this.size >= this.options.capacity) {
        let evicted = false
        for (const [candidateKey, candidate] of this) {
          const observed = this.accesses.get(candidateKey)
          if (!await this.options.idle(candidate, candidateKey)) continue
          if (this.accesses.get(candidateKey) !== observed || this.get(candidateKey) !== candidate) continue
          this.delete(candidateKey)
          this.accesses.delete(candidateKey)
          await this.options.dispose(candidate)
          evicted = true
          break
        }
        if (!evicted) return null
      }
      const resource = create()
      this.set(key, resource)
      this.accesses.set(key, 0)
      return resource
    })
    this.allocation = next.catch(() => undefined)
    return next
  }
}
