import { ProtocolParseError } from '../errors.js'

/**
 * One parsed Server-Sent Events frame. `data` contains all `data:` lines of
 * the event joined with '\n' (per the SSE spec). `event` is the event type
 * when the sender provided one.
 */
export type SseMessage = {
  data: string
  event?: string
  id?: string
}

export type SseParserOptions = {
  /**
   * Safety valve: maximum bytes buffered for a single unterminated event.
   * Prevents unbounded memory growth from broken upstreams. Default 8 MiB.
   */
  maxBufferBytes?: number
}

const LINE_FEED = 0x0a
const CARRIAGE_RETURN = 0x0d

/**
 * Incremental, byte-level SSE parser.
 *
 * Correctness rules it implements (see docs/STREAMING.md):
 * - one network chunk may contain zero, one, or many SSE frames
 * - one SSE frame may be split across any number of chunks at any byte
 *   boundary; UTF-8 multi-byte sequences survive chunk splits because bytes
 *   are buffered and only complete lines are decoded (a 0x0A terminator can
 *   never occur inside a UTF-8 multi-byte sequence)
 * - line endings: '\n' and '\r\n' ('\r'-only termination is not produced by
 *   any known provider and is not supported)
 * - multi-line `data:` fields joined with '\n', `event:`/`id:` fields, and
 *   ':' comment lines
 */
export class SseParser {
  private pending: Buffer = Buffer.alloc(0)
  private dataLines: string[] = []
  private eventName: string | undefined
  private lastEventId: string | undefined
  private readonly maxBufferBytes: number

  constructor(options: SseParserOptions) {
    this.maxBufferBytes = options.maxBufferBytes ?? 8 * 1024 * 1024
  }

  /** Feed raw upstream bytes. Returns every frame completed by this chunk. */
  push(chunk: Uint8Array | string): SseMessage[] {
    const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
    const buffered = this.pending.length === 0
      ? Buffer.from(incoming) // copy: incoming buffers may be reused by the transport
      : Buffer.concat([this.pending, incoming])
    this.pending = buffered

    const emitted: SseMessage[] = []
    let start = 0
    for (let index = buffered.indexOf(LINE_FEED); index !== -1; index = buffered.indexOf(LINE_FEED, start)) {
      let end = index
      if (end > start && buffered[end - 1] === CARRIAGE_RETURN) end--
      const message = this.consumeLine(buffered.toString('utf8', start, end))
      if (message) emitted.push(message)
      start = index + 1
    }
    this.pending = buffered.subarray(start)
    this.enforceBufferLimit()
    return emitted
  }

  /**
   * Flush a trailing line that was not terminated by a newline. Upstreams
   * normally end with '\n\n'; this only matters for truncated final frames.
   */
  flush(): SseMessage[] {
    if (this.pending.length === 0) return []
    const line = this.pending.toString('utf8')
    this.pending = Buffer.alloc(0)
    const trailing = this.consumeLine(line)
    // An unterminated trailing line never hit an empty-line dispatch.
    const dispatched = this.dispatch()
    return [trailing, dispatched].filter((message): message is SseMessage => message !== null)
  }

  private consumeLine(line: string): SseMessage | null {
    if (line === '') return this.dispatch()
    if (line.startsWith(':')) return null
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    if (field === 'data') {
      this.dataLines.push(value)
      return null
    }
    if (field === 'event') {
      this.eventName = value
      return null
    }
    if (field === 'id') {
      this.lastEventId = value
      return null
    }
    // 'retry' and unknown fields carry nothing we map; ignore them.
    return null
  }

  private dispatch(): SseMessage | null {
    if (this.dataLines.length === 0) {
      this.eventName = undefined
      return null
    }
    const message: SseMessage = {
      data: this.dataLines.join('\n'),
      ...(this.eventName ? { event: this.eventName } : {}),
      ...(this.lastEventId !== undefined ? { id: this.lastEventId } : {}),
    }
    this.dataLines = []
    this.eventName = undefined
    return message
  }

  private enforceBufferLimit(): void {
    if (this.pending.length <= this.maxBufferBytes) return
    this.pending = Buffer.alloc(0)
    this.dataLines = []
    throw new ProtocolParseError(`SSE frame exceeded ${this.maxBufferBytes} bytes before termination`)
  }
}
