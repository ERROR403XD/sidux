import { ResponsesStreamDecoder } from './streamDecoder.js'
import { ChatStreamEncoder, type ChatStreamChunk } from '../chat/streamEncoder.js'
import { SseParser } from '../sse/parser.js'
import type { NormalizedUsage } from '../types.js'

export type ResponsesToChatStreamTranslatorOptions = {
  /** Wire-chunk sink; called synchronously, in order, per upstream event. */
  onChunk: (chunk: ChatStreamChunk) => void
  /**
   * Called when the upstream signalled a failure (response.failed / error
   * event). After it returns, the translator emits one error chunk shaped
   * like a Chat error payload.
   */
  onFailure?: (failure: { code: string; message: string }) => void
  /** Cap for a single buffered SSE frame. Default 8 MiB. */
  maxBufferBytes?: number
}

/**
 * Facade for the Responses → Chat Completions streaming conversion of one
 * request (reverse direction). Wires the SSE parser to the Responses
 * decoder and the Chat encoder, and owns the stream lifecycle. The caller
 * serializes chunks and appends the final `data: [DONE]` sentinel after
 * finish() returns.
 */
export class ResponsesToChatStreamTranslator {
  private readonly parser: SseParser
  private readonly decoder = new ResponsesStreamDecoder()
  private readonly encoder: ChatStreamEncoder
  private streamEnded = false
  private failure: { code: string; message: string } | null = null
  private usage: NormalizedUsage | null = null

  constructor(private readonly options: ResponsesToChatStreamTranslatorOptions) {
    this.parser = new SseParser({ maxBufferBytes: options.maxBufferBytes })
    this.encoder = new ChatStreamEncoder(options.onChunk)
  }

  /** Feed raw upstream bytes (any chunk boundaries). */
  translateChunk(chunk: Uint8Array | string): void {
    if (this.streamEnded) return
    for (const message of this.parser.push(chunk)) {
      this.consumeSseData(message.data)
    }
  }

  /**
   * The upstream stream ended. Ensures a finish_reason chunk, a trailing
   * usage chunk (when known), and marks the translator done; the caller
   * then writes `data: [DONE]`.
   */
  finish(): void {
    if (this.streamEnded) return
    this.streamEnded = true
    for (const message of this.parser.flush()) this.consumeSseData(message.data)
    if (!this.failure && !this.encoder.isFinished) {
      this.encoder.consume({ kind: 'finish', reason: 'stop' })
    }
    if (this.usage) {
      this.encoder.consume({ kind: 'usage', usage: this.usage })
    }
  }

  /** Terminate the stream as failed (upstream error mid-flight). */
  fail(error: unknown): void {
    if (this.streamEnded) return
    this.streamEnded = true
    const failure = this.failure ?? {
      code: 'upstream_error',
      message: error instanceof Error ? error.message : 'upstream stream failed',
    }
    this.options.onFailure?.(failure)
    this.options.onChunk({
      error: { message: failure.message, code: failure.code, type: 'bridge_error' },
    })
  }

  getUsage(): NormalizedUsage | null {
    return this.usage
  }

  private consumeSseData(data: string): void {
    if (data === '' || data === '[DONE]') return
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      // Responses streams carry one JSON object per frame; ignore blanks.
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const result = this.decoder.decodeEvent(parsed as Record<string, unknown>)
    for (const event of result.events) {
      if (event.kind === 'usage') this.usage = event.usage
      if (!this.failure) this.encoder.consume(event)
    }
    if (result.failure && !this.failure) {
      this.failure = result.failure
      this.options.onFailure?.(result.failure)
      // Emit the protocol-visible error immediately: the stream may still
      // end normally afterwards, which would make fail() a no-op.
      this.options.onChunk({
        error: { message: result.failure.message, code: result.failure.code, type: 'bridge_error' },
      })
    }
  }
}
