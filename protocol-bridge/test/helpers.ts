import type { ProviderCompatOptions } from '../src/types.js'
import { ChatToResponsesStreamTranslator, encodeSseFrame } from '../src/index.js'

/** Collects wire events in arrival order. */
export function createEventSink(): { events: Array<Record<string, unknown>>; onEvent: (event: Record<string, unknown>) => void } {
  const events: Array<Record<string, unknown>> = []
  return { events, onEvent: event => { events.push(event) } }
}

/** Split a string into fixed-size chunks (used to simulate TCP fragmentation). */
export function splitIntoChunks(text: string, size: number): string[] {
  if (size <= 0) return [text]
  const chunks: string[] = []
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size))
  }
  return chunks
}

/** Build one Chat Completions SSE frame. */
export function chatFrame(delta: Record<string, unknown>, extras: Record<string, unknown> = {}): string {
  return encodeSseFrame({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1726000000,
    model: 'bridge-model',
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extras,
  })
}

export function chatFinishFrame(reason: string, extras: Record<string, unknown> = {}): string {
  return encodeSseFrame({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1726000000,
    model: 'bridge-model',
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
    ...extras,
  })
}

export function chatUsageFrame(usage: Record<string, unknown>): string {
  return encodeSseFrame({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1726000000,
    model: 'bridge-model',
    choices: [],
    usage,
  })
}

export const CHAT_DONE_FRAME = 'data: [DONE]\n\n'

/** Create a translator bound to a sink. */
export function createTranslator(options: {
  model?: string
  compatOptions?: ProviderCompatOptions
} = {}): { translator: ChatToResponsesStreamTranslator; events: Array<Record<string, unknown>> } {
  const sink = createEventSink()
  const translator = new ChatToResponsesStreamTranslator({
    model: options.model ?? 'bridge-model',
    compatOptions: options.compatOptions,
    onEvent: sink.onEvent,
  })
  return { translator, events: sink.events }
}

/** Feed a full SSE transcript, optionally fragmented. */
export function feed(translator: ChatToResponsesStreamTranslator, transcript: string, chunkSize?: number): void {
  if (chunkSize === undefined) {
    translator.translateChunk(transcript)
    return
  }
  for (const chunk of splitIntoChunks(transcript, chunkSize)) {
    translator.translateChunk(chunk)
  }
}

/**
 * Feed a transcript at arbitrary BYTE boundaries (true TCP fragmentation:
 * UTF-8 multi-byte sequences may be split mid-character, which is exactly
 * what the parser must survive).
 */
export function feedBytes(translator: ChatToResponsesStreamTranslator, transcript: string, chunkSize: number): void {
  const bytes = Buffer.from(transcript, 'utf8')
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    translator.translateChunk(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)))
  }
}

/** A canonical text-only transcript with trailing usage, like OpenAI emits. */
export function textTranscript(): string {
  return [
    chatFrame({ role: 'assistant', content: '' }),
    chatFrame({ content: '你好' }),
    chatFrame({ content: '，' }),
    chatFrame({ content: '🌍 world' }),
    chatUsageFrame({ prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 }),
    chatFinishFrame('stop'),
    CHAT_DONE_FRAME,
  ].join('')
}

export function typeOfEvents(events: Array<Record<string, unknown>>): string[] {
  return events.map(event => String(event.type))
}

/**
 * Replace randomly generated item ids with a stable placeholder so event
 * streams from different translator instances can be compared.
 */
export function normalizeEvents(events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return JSON.parse(JSON.stringify(events).replace(/(?:msg|rs|fc)_\d+_[0-9a-f]{12}/g, 'item_X')) as Array<Record<string, unknown>>
}
