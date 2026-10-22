import { ChatStreamDecoder } from './streamDecoder.js'
import { ResponsesStreamEncoder, type ResponsesStreamEvent } from '../responses/streamEncoder.js'
import { SseParser } from '../sse/parser.js'
import { StreamInterruptedError } from '../errors.js'
import { createItemIdFactory } from '../id.js'
import type { NormalizedUsage, ProviderCompatOptions } from '../types.js'

export type ChatToResponsesStreamTranslatorOptions = {
  /** Model name to use until the upstream announces its own. */
  model: string
  /** Wire-event sink; called synchronously, in order, per upstream chunk. */
  onEvent: (event: ResponsesStreamEvent) => void
  /** Provider compatibility switches (see docs/COMPATIBILITY.md). */
  compatOptions?: ProviderCompatOptions
  /** Cap for a single buffered SSE frame. Default 8 MiB. */
  maxBufferBytes?: number
}

/**
 * Facade for the Chat Completions → Responses streaming conversion of one
 * request. Wires the byte-level SSE parser to the chat decoder and the
 * Responses encoder, and owns the stream lifecycle:
 *
 *   translateChunk(bytes)* ──▶ finish()   (graceful end)
 *                       └────▶ fail(e)   (upstream broke / client cancel)
 *
 * All state is request-local; instances are cheap and never shared.
 */
export class ChatToResponsesStreamTranslator {
  private readonly parser: SseParser
  private readonly decoder: ChatStreamDecoder
  private readonly encoder: ResponsesStreamEncoder
  private readonly compatOptions: ProviderCompatOptions | undefined
  private doneSeen = false
  private streamEnded = false

  constructor(private readonly options: ChatToResponsesStreamTranslatorOptions) {
    this.compatOptions = options.compatOptions
    this.parser = new SseParser({ maxBufferBytes: options.maxBufferBytes })
    this.decoder = new ChatStreamDecoder({
      model: options.model,
      responseId: createItemIdFactory('resp_')(),
      newCallId: createItemIdFactory('call_'),
      compatOptions: options.compatOptions,
    })
    this.encoder = new ResponsesStreamEncoder(options.onEvent)
  }

  /**
   * Feed raw upstream bytes (any chunk boundaries). Events are emitted to
   * the onEvent sink synchronously before this method returns.
   */
  translateChunk(chunk: Uint8Array | string): void {
    if (this.streamEnded) return
    for (const message of this.parser.push(chunk)) {
      this.consumeSseMessage(message)
    }
  }

  /**
   * The upstream stream ended. Emits the final terminal event according to
   * what was seen: finish_reason wins, then [DONE], then a graceful or
   * failed close per the silentClose compat option.
   */
  finish(): void {
    if (this.streamEnded) return
    this.streamEnded = true
    if (this.encoder.isTerminal) return
    for (const message of this.parser.flush()) this.consumeSseMessage(message)
    if (this.decoder.sawFinishReason || this.doneSeen) {
      // When a finish reason was seen the encoder already closed its items;
      // this call is the (guarded) finalizer for the [DONE]-only case.
      this.encoder.finish('stop')
    } else if (this.silentCloseCompletes()) {
      this.encoder.finish('stop')
    } else {
      this.encoder.fail({
        code: 'stream_interrupted',
        message: 'upstream stream ended mid-response without a finish signal',
      })
    }
    this.encoder.completeStream()
  }

  /**
   * Terminate the stream as failed (upstream error mid-flight, client
   * disconnect, idle timeout). Emits `response.failed` unless the stream
   * already completed.
   */
  fail(error: unknown): void {
    if (this.streamEnded) return
    this.streamEnded = true
    const message = error instanceof Error ? error.message : 'upstream stream failed'
    const code = error instanceof StreamInterruptedError ? 'stream_interrupted' : 'upstream_error'
    this.encoder.fail({ code, message })
    this.encoder.completeStream()
  }

  /** Whether any wire event was already emitted (SSE headers committed). */
  get hasEmittedEvents(): boolean {
    return this.encoder.isStarted
  }

  /** Last usage numbers reported by the upstream, if any. */
  getUsage(): NormalizedUsage | null {
    return this.decoder.getUsage()
  }

  getWarnings() {
    return this.decoder.warnings
  }

  private silentCloseCompletes(): boolean {
    const silentClose = this.compatOptions?.silentClose ?? 'complete'
    if (silentClose === 'fail') return false
    return !this.decoder.hasOpenToolCalls
  }

  private consumeSseMessage(message: { data: string; event?: string }): void {
    const data = message.data
    if (data === '[DONE]') {
      this.doneSeen = true
      return
    }
    if (data === '') return
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      // Tolerate non-JSON frames: providers send keep-alive comments and
      // occasional blanks. A frame that claims to be an event but fails to
      // parse is dropped; the idle timeout and [DONE] guard the stream.
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    for (const event of this.decoder.decodeChunk(parsed)) {
      this.encoder.consume(event)
    }
  }
}
