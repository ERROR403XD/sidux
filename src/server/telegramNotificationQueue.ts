import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inQuietHours, type QuietHoursSettings } from '../accountNotifications.js'
import { privateJson } from './apiProxy/store.js'

type Pending = { botId: string; chatId: number; text: string; createdAt: number }
export class TelegramNotificationQueue {
  private pending: Pending[] = []
  private serial: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private ready: Promise<void>
  constructor(private options: {
    directory?: string
    settings: () => QuietHoursSettings
    enabled: () => boolean
    botId: () => string
    send: (chatId: number, text: string) => Promise<void>
    now?: () => number
  }) {
    this.ready = (async () => {
      if (!options.directory) return
      await mkdir(options.directory, { recursive: true, mode: 0o700 })
      try {
        const value = JSON.parse(await readFile(join(options.directory, 'pending.json'), 'utf8'))
        if (Array.isArray(value)) this.pending = value.slice(-256)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    })()
    void this.ready.catch(() => {})
  }
  private now(): number { return this.options.now?.() ?? Date.now() }
  private async persist(): Promise<void> {
    if (this.options.directory) await privateJson(join(this.options.directory, 'pending.json'), this.pending)
  }
  private mutate(work: () => Promise<void>): Promise<void> {
    const next = this.serial.then(async () => { await this.ready; await work() })
    this.serial = next.catch(() => {})
    return next
  }
  private schedule(): void {
    if (this.timer || this.stopped || !this.pending.length) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush().catch(() => {})
    }, 5000)
    this.timer.unref?.()
  }
  async enqueue(chatIds: number[], text: string): Promise<void> {
    await this.mutate(async () => {
      if (this.stopped || !this.options.enabled()) return
      const botId = this.options.botId()
      this.pending.push(...chatIds.map(chatId => ({ botId, chatId, text, createdAt: this.now() })))
      this.pending = this.pending.slice(-256)
      await this.persist()
    })
    await this.flush()
  }
  clear(): Promise<void> {
    return this.mutate(async () => {
      this.pending = []
      if (this.timer) clearTimeout(this.timer)
      this.timer = undefined
      await this.persist()
    })
  }
  flush(): Promise<void> {
    return this.mutate(async () => {
      try {
        while (!this.stopped && this.options.enabled() && this.pending.length && !inQuietHours(this.options.settings(), this.now())) {
          const next = this.pending.shift()!
          // Persist removal before transport: uncertain sends must not replay after restart.
          await this.persist()
          if (next.botId !== this.options.botId() || this.now() - next.createdAt > 7 * 86400000) continue
          if (!this.options.enabled()) return
          await this.options.send(next.chatId, next.text).catch(() => {})
        }
      } finally { this.schedule() }
    })
  }
  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }
  async settled(): Promise<void> { await this.serial }
  start(): void {
    this.stopped = false
    void this.flush().catch(() => {})
  }
}
