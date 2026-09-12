import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CommandObservation } from './commandToolOutput.js'
import { hookRunKey, OUTPUT_LIMIT, readCommandOutput, readHookRun, type CommandOutput, type HookRun, type HookSnapshot } from '../processActivity.js'

const MAX_BYTES = 4 * 1024 * 1024
const keyOf = (threadId: string, itemId: string) => JSON.stringify([threadId, itemId])

/** Observation history, not a hook runner. Terminal deltas never write to disk. */
export class ProcessActivityStore {
  private runs = new Map<string, HookRun>()
  private sizes = new Map<string, number>()
  private bytes = 0
  private outputs = new Map<string, CommandOutput>()
  private commands = new Map<string, CommandObservation>()
  private observedSince = Date.now()
  private limited = false
  private error = ''
  private writable = true
  private revision = 0
  private written = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> | null = null
  private ready: Promise<void>

  constructor(private path: string) {
    this.ready = this.restore()
  }

  private async restore() {
    try {
      if ((await stat(this.path)).size > MAX_BYTES + 100000) throw new Error('观察记录文件超出大小限制')
      const data = JSON.parse(await readFile(this.path, 'utf8'))
      if (data.version !== 1 || !Array.isArray(data.runs) || data.runs.length > 1000) throw new Error('观察记录格式无效')
      this.observedSince = Number.isFinite(data.observedSince) ? data.observedSince : this.observedSince
      this.limited ||= data.limited === true
      const live = [...this.runs.values()]
      this.runs.clear()
      this.sizes.clear()
      this.bytes = 0
      for (const value of data.runs) {
        const run = readHookRun(value, value.threadId, value.turnId)
        if (run) this.put({ ...run, currentRuntime: false })
      }
      for (const run of live) this.put(run)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.writable = false
        this.error = '历史观察记录无法读取；本次记录仅在内存中保留。'
      }
    }
  }

  private remove(key: string) {
    this.bytes -= this.sizes.get(key) || 0
    this.sizes.delete(key)
    this.runs.delete(key)
    this.limited = true
  }

  private put(run: HookRun) {
    const key = hookRunKey(run)
    const previous = this.runs.get(key)
    if (previous && previous.status !== 'running' && run.status === 'running') return
    this.bytes -= this.sizes.get(key) || 0
    this.runs.delete(key)
    this.runs.set(key, run)
    const size = Buffer.byteLength(JSON.stringify(run)) + 1
    this.sizes.set(key, size)
    this.bytes += size
    const sameThread = [...this.runs.entries()].filter(([, row]) => row.threadId === run.threadId)
    for (const [key] of sameThread.slice(0, Math.max(0, sameThread.length - 200))) this.remove(key)
    while (this.runs.size > 1000 || this.bytes > MAX_BYTES) this.remove(this.runs.keys().next().value!)
  }

  observe(notification: { method: string; params: unknown }) {
    const params = notification.params as Record<string, any> | null
    if (notification.method === 'codexapp/runtime/stopped') {
      this.runtimeStopped()
      return
    }
    if (typeof params?.threadId !== 'string' || !params.threadId) return
    const threadId = params.threadId
    if (['hook/started', 'hook/completed'].includes(notification.method)) {
      const run = readHookRun(params.run, threadId, params.turnId)
      if (run) {
        this.put(run)
        this.schedule()
      }
    }
    if (['item/started', 'item/completed'].includes(notification.method)) {
      const output = readCommandOutput(params.item, 'observed')
      if (output) {
        const key = keyOf(threadId, output.itemId)
        if (notification.method === 'item/started' && typeof params.item.processId === 'string' && typeof params.turnId === 'string' && typeof params.startedAtMs === 'number') {
          this.commands.delete(key)
          this.commands.set(key, { processId: params.item.processId, turnId: params.turnId, startedAtMs: params.startedAtMs })
          while (this.commands.size > 200) this.commands.delete(this.commands.keys().next().value!)
        }
        const previous = this.outputs.get(key)
        if (previous && previous.status !== 'inProgress' && output.status === 'inProgress') return
        this.outputs.delete(key)
        this.outputs.set(key, output)
      }
    }
    if (notification.method === 'item/commandExecution/outputDelta' && typeof params.itemId === 'string' && typeof params.delta === 'string') {
      const key = keyOf(threadId, params.itemId)
      const previous = this.outputs.get(key)
      if (previous && previous.status !== 'inProgress') return
      const text = (previous?.text || '') + params.delta
      this.outputs.delete(key)
      this.outputs.set(key, { itemId: params.itemId, text: text.slice(-OUTPUT_LIMIT), status: 'inProgress', exitCode: null,
        truncated: previous?.truncated || !previous || text.length > OUTPUT_LIMIT, source: 'observed' })
    }
    while (this.outputs.size > 200) this.outputs.delete(this.outputs.keys().next().value!)
  }

  runtimeStopped() {
    this.outputs.clear()
    this.commands.clear()
    for (const run of this.runs.values()) run.currentRuntime = false
    this.schedule()
  }

  output(threadId: string, itemId: string): CommandOutput | null {
    return this.outputs.get(keyOf(threadId, itemId)) || null
  }

  command(threadId: string, itemId: string): CommandObservation | null {
    return this.commands.get(keyOf(threadId, itemId)) || null
  }

  async snapshot(threadId: string): Promise<HookSnapshot> {
    await this.ready
    return { runs: [...this.runs.values()].filter(row => row.threadId === threadId).reverse(), observedSince: this.observedSince, limited: this.limited, error: this.error }
  }

  private schedule() {
    this.revision++
    if (this.timer || !this.writable) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, 200)
    this.timer.unref()
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.ready
    if (this.writing) return this.writing
    if (!this.writable || this.written === this.revision) return
    this.writing = (async () => {
      try {
        await mkdir(dirname(this.path), { recursive: true })
        while (this.written !== this.revision) {
          const revision = this.revision
          const text = JSON.stringify({ version: 1, observedSince: this.observedSince, limited: this.limited, runs: [...this.runs.values()] })
          await writeFile(this.path + '.tmp', text, 'utf8')
          await rename(this.path + '.tmp', this.path)
          this.written = revision
        }
        this.error = ''
      } catch {
        this.error = '观察记录保存失败，重启后可能丢失。'
      }
    })().finally(() => { this.writing = null })
    return this.writing
  }
}
