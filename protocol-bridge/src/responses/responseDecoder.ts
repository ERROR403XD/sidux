import { ProtocolConversionError } from '../errors.js'
import type { ConversionWarning } from '../types.js'

type ResponsesOutputItem = {
  type?: unknown
  role?: unknown
  content?: unknown
  summary?: unknown
  call_id?: unknown
  name?: unknown
  arguments?: unknown
  status?: unknown
}

type ResponsesResponseShape = {
  id?: unknown
  created_at?: unknown
  model?: unknown
  status?: unknown
  output?: ResponsesOutputItem[]
  usage?: Record<string, unknown> | null
  incomplete_details?: { reason?: unknown } | null
}

export type DecodedChatResponse = {
  response: Record<string, unknown>
  warnings: ConversionWarning[]
}

/**
 * Convert a non-streaming Responses API response object into a Chat
 * Completions response body (reverse direction).
 */
export function responsesResponseToChatResponse(payload: unknown): DecodedChatResponse {
  const warnings: ConversionWarning[] = []
  const body = payload && typeof payload === 'object' ? payload as ResponsesResponseShape : null
  if (!body) throw new ProtocolConversionError('Responses response body must be a JSON object')

  let text = ''
  let reasoning = ''
  const toolCalls: Array<Record<string, unknown>> = []
  if (Array.isArray(body.output)) {
    for (const [index, item] of body.output.entries()) {
      if (!item || typeof item !== 'object') continue
      if (item.type === 'message') {
        text += messageItemText(item)
      } else if (item.type === 'reasoning') {
        reasoning += reasoningItemText(item)
      } else if (item.type === 'function_call') {
        if (typeof item.call_id !== 'string' || typeof item.name !== 'string') {
          warnings.push({ field: `output[${index}]`, reason: 'function_call without call_id/name dropped' })
          continue
        }
        toolCalls.push({
          id: item.call_id,
          type: 'function',
          function: {
            name: item.name,
            arguments: typeof item.arguments === 'string' ? item.arguments : '{}',
          },
        })
      } else {
        warnings.push({ field: `output[${index}].type`, reason: `item type '${String(item.type)}' has no Chat equivalent and was dropped` })
      }
    }
  }

  const message: Record<string, unknown> = { role: 'assistant', content: text || null }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length > 0) message.tool_calls = toolCalls

  const status = body.status
  const finishReason = status === 'incomplete' ? 'length' : toolCalls.length > 0 ? 'tool_calls' : 'stop'
  const response: Record<string, unknown> = {
    id: typeof body.id === 'string' ? body.id : '',
    object: 'chat.completion',
    created: typeof body.created_at === 'number' ? body.created_at : Math.floor(Date.now() / 1000),
    model: typeof body.model === 'string' ? body.model : '',
    choices: [{ index: 0, message, finish_reason: finishReason }],
  }
  if (body.usage && typeof body.usage === 'object') {
    response.usage = mapUsageReverse(body.usage, warnings)
  }
  return { response, warnings }
}

function messageItemText(item: ResponsesOutputItem): string {
  if (typeof item.content === 'string') return item.content
  if (!Array.isArray(item.content)) return ''
  return item.content
    .map(part => {
      if (!part || typeof part !== 'object') return ''
      const row = part as { type?: unknown; text?: unknown }
      if (row.type === 'output_text' || row.type === 'input_text') return typeof row.text === 'string' ? row.text : ''
      return ''
    })
    .join('')
}

function reasoningItemText(item: ResponsesOutputItem): string {
  const collect = (value: unknown): string => {
    if (!Array.isArray(value)) return ''
    return value
      .map(part => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
      .join('')
  }
  return collect(item.content) || collect(item.summary)
}

function mapUsageReverse(usage: Record<string, unknown>, warnings: ConversionWarning[]): Record<string, unknown> {
  const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
  const input = number(usage.input_tokens)
  const output = number(usage.output_tokens)
  if (input === null && output === null) {
    warnings.push({ field: 'usage', reason: 'response usage carries no recognizable token counts' })
  }
  const inputDetails = usage.input_tokens_details && typeof usage.input_tokens_details === 'object'
    ? usage.input_tokens_details as Record<string, unknown>
    : undefined
  const outputDetails = usage.output_tokens_details && typeof usage.output_tokens_details === 'object'
    ? usage.output_tokens_details as Record<string, unknown>
    : undefined
  return {
    prompt_tokens: input ?? 0,
    completion_tokens: output ?? 0,
    total_tokens: number(usage.total_tokens) ?? (input ?? 0) + (output ?? 0),
    ...(inputDetails || outputDetails
      ? {
        prompt_tokens_details: { cached_tokens: number(inputDetails?.cached_tokens) ?? 0 },
        completion_tokens_details: { reasoning_tokens: number(outputDetails?.reasoning_tokens) ?? 0 },
      }
      : {}),
  }
}
