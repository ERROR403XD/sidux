import { extractDeltaText, extractReasoningText, resolveCompatOptions } from '../compatibility/reasoning.js'
import type { ItemIdFactory } from '../id.js'
import type {
  ConversionWarning,
  NormalizedFinishReason,
  NormalizedStreamEvent,
  NormalizedUsage,
  ProviderCompatOptions,
  ResolvedCompatOptions,
} from '../types.js'

/**
 * Upstream Chat Completions chunk, tolerantly typed: providers deviate on
 * optional fields, so unknown shapes degrade instead of throwing.
 */
type ChatChunkShape = {
  id?: unknown
  model?: unknown
  choices?: Array<{
    delta?: Record<string, unknown>
    finish_reason?: unknown
  }>
  usage?: unknown
}

type ChatToolCallDelta = {
  index?: unknown
  id?: unknown
  type?: unknown
  function?: { name?: unknown; arguments?: unknown }
}

type DecodedUsage = { usage: NormalizedUsage }

/**
 * Decode Chat Completions stream chunks into normalized IR events.
 *
 * State held here is chat-specific: tool-call index bookkeeping (chat
 * multiplexes parallel tool calls by `delta.tool_calls[].index`, sending
 * `id`/`name` once on the first delta) and first-chunk `start` emission.
 * No response-shaping happens here; encoders own that.
 */
export class ChatStreamDecoder {
  private readonly compat: ResolvedCompatOptions
  private readonly collectedWarnings: ConversionWarning[] = []
  private readonly toolCalls = new Map<number, { callId: string; name: string; started: boolean }>()
  private started = false
  private finished = false
  private finishReason: NormalizedFinishReason | null = null
  private usage: NormalizedUsage | null = null
  private readonly newCallId: ItemIdFactory
  private readonly warnedFields = new Set<string>()

  constructor(options: { model: string; responseId: string; newCallId: ItemIdFactory; compatOptions?: ProviderCompatOptions }) {
    this.compat = resolveCompatOptions(options.compatOptions)
    this.model = options.model
    this.responseId = options.responseId
    this.newCallId = options.newCallId
  }

  private readonly model: string
  private readonly responseId: string

  get warnings(): readonly ConversionWarning[] {
    return this.collectedWarnings
  }

  get sawFinishReason(): boolean {
    return this.finishReason !== null
  }

  get sawUsage(): boolean {
    return this.usage !== null
  }

  /** True when some tool call was announced but its stream never closed. */
  get hasOpenToolCalls(): boolean {
    for (const record of this.toolCalls.values()) {
      if (!record.started) continue
      // 'Started' records stay open until a finish event closes them.
      return true
    }
    return false
  }

  getUsage(): NormalizedUsage | null {
    return this.usage
  }

  /** Feed one parsed chat chunk; returns IR events in arrival order. */
  decodeChunk(chunk: ChatChunkShape): NormalizedStreamEvent[] {
    const events: NormalizedStreamEvent[] = []

    // With stream_options.include_usage the usage chunk arrives AFTER the
    // finish_reason chunk as a trailing choices-less frame; it must survive.
    if (chunk.usage && typeof chunk.usage === 'object') {
      const usage = decodeUsage(chunk.usage as Record<string, unknown>)
      if (usage) {
        this.usage = usage
        events.push({ kind: 'usage', usage })
      }
    }

    if (this.finished) return events

    if (!this.started) {
      this.started = true
      events.push({
        kind: 'start',
        responseId: typeof chunk.id === 'string' && chunk.id ? chunk.id : this.responseId,
        model: typeof chunk.model === 'string' && chunk.model ? chunk.model : this.model,
      })
    }

    const choices = Array.isArray(chunk.choices) ? chunk.choices : []
    if (choices.length > 1) {
      this.warnOnce('choices', `upstream streamed ${choices.length} choices; only the first is forwarded`)
    }
    const choice = choices[0]
    const delta = choice && typeof choice === 'object' ? choice.delta : undefined

    if (delta) {
      const reasoning = extractReasoningText(delta, this.compat.reasoningFields)
      if (reasoning) events.push({ kind: 'reasoningDelta', text: reasoning })

      const text = extractDeltaText(delta.content)
      if (text) events.push({ kind: 'textDelta', text })

      const toolCallDeltas = Array.isArray(delta.tool_calls) ? delta.tool_calls as ChatToolCallDelta[] : []
      for (const toolCallDelta of toolCallDeltas) {
        this.decodeToolCallDelta(toolCallDelta, events)
      }
    }

    const finishReason = choice?.finish_reason
    if (typeof finishReason === 'string' && finishReason.length > 0) {
      this.finishReason = normalizeFinishReason(finishReason)
      this.finished = true
      events.push({ kind: 'finish', reason: this.finishReason })
    }

    return events
  }

  /** Mark the upstream sentinel received ('data: [DONE]'). */
  markDone(): void {
    this.finished = true
  }

  private decodeToolCallDelta(delta: ChatToolCallDelta, events: NormalizedStreamEvent[]): void {
    const toolIndex = typeof delta.index === 'number' && Number.isInteger(delta.index) && delta.index >= 0
      ? delta.index
      : this.toolCalls.size
    let record = this.toolCalls.get(toolIndex)
    if (!record) {
      record = { callId: typeof delta.id === 'string' && delta.id ? delta.id : this.newCallId(), name: '', started: false }
      this.toolCalls.set(toolIndex, record)
    } else if (typeof delta.id === 'string' && delta.id && record.callId !== delta.id) {
      // A provider re-announcing the id must not fork the record.
      record.callId = delta.id
    }
    if (typeof delta.function?.name === 'string') {
      const nameDelta = delta.function.name
      if (!record.started) {
        record.name += nameDelta
      } else {
        record.name += nameDelta
        events.push({ kind: 'toolCallNameDelta', toolIndex, nameDelta })
      }
    }
    if (!record.started) {
      record.started = true
      events.push({ kind: 'toolCallStart', toolIndex, callId: record.callId, name: record.name })
    }
    const argumentsDelta = typeof delta.function?.arguments === 'string' ? delta.function.arguments : ''
    if (argumentsDelta) {
      events.push({ kind: 'toolCallArgumentsDelta', toolIndex, argumentsDelta })
    }
  }

  private warnOnce(field: string, reason: string): void {
    if (this.warnedFields.has(field)) return
    this.warnedFields.add(field)
    this.collectedWarnings.push({ field, reason })
  }
}

function normalizeFinishReason(reason: string): NormalizedFinishReason {
  if (reason === 'length' || reason === 'tool_calls' || reason === 'content_filter') return reason
  return 'stop'
}

function decodeUsage(raw: Record<string, unknown>): DecodedUsage['usage'] | null {
  const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
  const input = number(raw.prompt_tokens)
  const output = number(raw.completion_tokens)
  const total = number(raw.total_tokens)
  if (input === null && output === null && total === null) return null
  const promptDetails = raw.prompt_tokens_details && typeof raw.prompt_tokens_details === 'object'
    ? raw.prompt_tokens_details as Record<string, unknown>
    : undefined
  const completionDetails = raw.completion_tokens_details && typeof raw.completion_tokens_details === 'object'
    ? raw.completion_tokens_details as Record<string, unknown>
    : undefined
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    cachedInputTokens: number(promptDetails?.cached_tokens),
    reasoningTokens: number(completionDetails?.reasoning_tokens),
  }
}
