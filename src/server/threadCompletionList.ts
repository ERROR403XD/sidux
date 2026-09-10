import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export class ThreadCompletionList {
  private entries: Record<string, string> = Object.create(null)
  private seen: string[] = []
  private pending: Promise<unknown>
  private ready: Promise<unknown>
  constructor(private path: string, private changed: (threadId: string, token: string | null) => void = () => {}) {
    this.ready = readFile(path, 'utf8').then(raw => {
      const value = JSON.parse(raw)
      for (const [id, token] of Object.entries(value.entries ?? {})) {
        if (typeof token === 'string') this.entries[id] = token
      }
      this.seen = Array.isArray(value.seen) ? value.seen.filter((v: unknown) => typeof v === 'string').slice(-2048) : []
    }).catch(error => { if (error.code !== 'ENOENT') throw error })
    this.pending = this.ready
    void this.ready.catch(() => {})
  }
  async read(): Promise<Record<string, string>> {
    await this.pending
    return { ...this.entries }
  }
  private mutate(action: () => { threadId: string; token: string | null } | null): Promise<void> {
    const run = this.pending.catch(() => this.ready).then(async () => {
      const previousEntries = { ...this.entries }
      const previousSeen = [...this.seen]
      const change = action()
      if (!change) return
      try {
        await mkdir(dirname(this.path), { recursive: true })
        await writeFile(`${this.path}.tmp`, JSON.stringify({ entries: this.entries, seen: this.seen }), 'utf8')
        await rename(`${this.path}.tmp`, this.path)
      } catch (error) {
        this.entries = Object.assign(Object.create(null), previousEntries)
        this.seen = previousSeen
        throw error
      }
      this.changed(change.threadId, change.token)
    })
    this.pending = run
    return run
  }
  complete(threadId: string, token: string): Promise<void> {
    return this.mutate(() => {
      if (!threadId || !token) return null
      const key = JSON.stringify([threadId, token])
      if (this.seen.includes(key)) return null
      this.seen.push(key)
      this.seen = this.seen.slice(-2048)
      this.entries[threadId] = token
      return { threadId, token }
    })
  }
  acknowledge(threadId: string, token: string): Promise<void> {
    return this.mutate(() => {
      if (!Object.hasOwn(this.entries, threadId) || this.entries[threadId] !== token) return null
      delete this.entries[threadId]
      return { threadId, token: null }
    })
  }
}
