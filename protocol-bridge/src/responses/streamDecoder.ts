import type { NormalizedStreamEvent, NormalizedUsage } from '../types.js'

export type DecodedResponsesStreamResult = {
  events: NormalizedStreamEvent[]
  /** Present when the stream signalled a terminal failure. */
  failure?: { code: string; message: string }
}

/**
 * Decode Responses SSE event payloads into normalized IR events (reverse
 * direction). State kept here: which output_index maps to which chat tool
 * call index, and whether the response has started.
 */
export class ResponsesStreamDecoder {
  private started = false
  private readonly outputIndexToToolIndex = new Map<number, number>()
  private nextToolIndex = 0
  private sawToolCalls = false
  private responseId = ''
  private model = ''

  /** Feed one parsed Responses SSE payload. */
  decodeEvent(payload: Record<string, unknown>): DecodedResponsesStreamResult {
    const events: NormalizedStreamEvent[] = []
    const type = typeof payload.type === 'string' ? payload.type : ''
    switch (type) {
      case 'response.created':
      case 'response.in_progress': {
        if (this.started) return { events }
        this.started = true
        const response = payload.response && typeof payload.response === 'object' ? payload.response as Record<string, unknown> : {}
        this.responseId = typeof response.id === 'string' ? response.id : ''
        this.model = typeof response.model === 'string' ? response.model : ''
        events.push({ kind: 'start', responseId: this.responseId, model: this.model })
        return { events }
      }
      case 'response.output_item.added': {
        const item = payload.item && typeof payload.item === 'object' ? payload.item as Record<string, unknown> : null
        const outputIndex = typeof payload.output_index === 'number' ? payload.output_index : -1
        if (!item || item.type !== 'function_call' || outputIndex < 0) return { events }
        this.sawToolCalls = true
        const toolIndex = this.nextToolIndex++
        this.outputIndexToToolIndex.set(outputIndex, toolIndex)
        events.push({
          kind: 'toolCallStart',
          toolIndex,
          callId: typeof item.call_id === 'string' ? item.call_id : `call_${toolIndex}`,
          name: typeof item.name === 'string' ? item.name : '',
        })
        return { events }
      }
      case 'response.output_text.delta': {
        const delta = typeof payload.delta === 'string' ? payload.delta : ''
        if (delta) events.push({ kind: 'textDelta', text: delta })
        return { events }
      }
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        const delta = typeof payload.delta === 'string' ? payload.delta : ''
        if (delta) events.push({ kind: 'reasoningDelta', text: delta })
        return { events }
      }
      case 'response.function_call_arguments.delta': {
        const outputIndex = typeof payload.output_index === 'number' ? payload.output_index : -1
        const toolIndex = this.outputIndexToToolIndex.get(outputIndex)
        const delta = typeof payload.delta === 'string' ? payload.delta : ''
        if (toolIndex === undefined || !delta) return { events }
        events.push({ kind: 'toolCallArgumentsDelta', toolIndex, argumentsDelta: delta })
        return { events }
      }
      case 'response.completed':
      case 'response.incomplete': {
        const response = payload.response && typeof payload.response === 'object' ? payload.response as Record<string, unknown> : {}
        if (!this.started) {
          this.started = true
          this.responseId = typeof response.id === 'string' ? response.id : ''
          this.model = typeof response.model === 'string' ? response.model : ''
          events.push({ kind: 'start', responseId: this.responseId, model: this.model })
        }
        const usage = response.usage && typeof response.usage === 'object' ? decodeUsage(response.usage as Record<string, unknown>) : null
        if (usage) events.push({ kind: 'usage', usage })
        events.push({ kind: 'finish', reason: type === 'response.incomplete' ? 'length' : this.sawToolCalls ? 'tool_calls' : 'stop' })
        return { events }
      }
      case 'response.failed': {
        const response = payload.response && typeof payload.response === 'object' ? payload.response as Record<string, unknown> : {}
        const error = response.error && typeof response.error === 'object' ? response.error as Record<string, unknown> : {}
        return {
          events,
          failure: {
            code: typeof error.code === 'string' ? error.code : 'upstream_error',
            message: typeof error.message === 'string' ? error.message : 'upstream response failed',
          },
        }
      }
      case 'error': {
        const error = payload as Record<string, unknown>
        return {
          events,
          failure: {
            code: typeof error.code === 'string' ? error.code : 'upstream_error',
            message: typeof error.message === 'string' ? error.message : 'upstream stream error',
          },
        }
      }
      // Content part events, output_item.done, annotation events, and
      // unknown event types carry no data the Chat protocol can express.
      default:
        return { events }
    }
  }
}

function decodeUsage(usage: Record<string, unknown>): NormalizedUsage | null {
  const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
  const input = number(usage.input_tokens)
  const output = number(usage.output_tokens)
  const total = number(usage.total_tokens)
  if (input === null && output === null && total === null) return null
  const inputDetails = usage.input_tokens_details && typeof usage.input_tokens_details === 'object'
    ? usage.input_tokens_details as Record<string, unknown>
    : undefined
  const outputDetails = usage.output_tokens_details && typeof usage.output_tokens_details === 'object'
    ? usage.output_tokens_details as Record<string, unknown>
    : undefined
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    cachedInputTokens: number(inputDetails?.cached_tokens),
    reasoningTokens: number(outputDetails?.reasoning_tokens),
  }
}
