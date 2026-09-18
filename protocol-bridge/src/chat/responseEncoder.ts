import { ProtocolConversionError } from '../errors.js'
import { extractReasoningText, resolveCompatOptions } from '../compatibility/reasoning.js'
import { createItemIdFactory } from '../id.js'
import type { ConversionWarning, ProviderCompatOptions } from '../types.js'

type ChatToolCall = {
  id?: unknown
  type?: unknown
  function?: { name?: unknown; arguments?: unknown }
}

type ChatResponseShape = {
  id?: unknown
  created?: unknown
  model?: unknown
  choices?: Array<{
    message?: {
      content?: unknown
      tool_calls?: ChatToolCall[]
    }
    finish_reason?: unknown
  }>
  usage?: Record<string, unknown> | null
}

export type EncodedResponsesResponse = {
  response: Record<string, unknown>
  warnings: ConversionWarning[]
}

/**
 * Convert a non-streaming Chat Completions response body into a Responses
 * API response object.
 *
 * Output item order mirrors the OpenAI Responses convention: reasoning
 * first, then the assistant message, then function calls.
 */
export function chatResponseToResponses(
  chatResponse: unknown,
  requestModel: string,
  compatOptions?: ProviderCompatOptions,
): EncodedResponsesResponse {
  const compat = resolveCompatOptions(compatOptions)
  const warnings: ConversionWarning[] = []
  const body = (chatResponse && typeof chatResponse === 'object' ? chatResponse : {}) as ChatResponseShape

  const choices = Array.isArray(body.choices) ? body.choices : []
  if (choices.length > 1) {
    warnings.push({ field: 'choices', reason: `upstream returned ${choices.length} choices; only the first is forwarded` })
  }
  const choice = choices[0]
  const message = (choice && typeof choice === 'object' ? choice.message : undefined) ?? {}

  const output: Array<Record<string, unknown>> = []
  const messageId = createItemIdFactory('msg_')
  const reasoningId = createItemIdFactory('rs_')
  const callItemId = createItemIdFactory('fc_')

  const reasoningText = message && typeof message === 'object'
    ? extractReasoningText(message as Record<string, unknown>, compat.reasoningFields)
    : ''
  if (reasoningText) {
    output.push({ type: 'reasoning', id: reasoningId(), summary: [{ type: 'summary_text', text: reasoningText }] })
  }

  const contentText = typeof message?.content === 'string'
    ? message.content
    : Array.isArray(message?.content)
      ? message.content.map(part => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).join('')
      : ''
  if (contentText.length > 0) {
    output.push({
      type: 'message',
      id: messageId(),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: contentText, annotations: [] }],
    })
  }

  if (Array.isArray(message?.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      if (!toolCall || toolCall.type !== 'function') {
        warnings.push({ field: 'choices[0].message.tool_calls[]', reason: 'non-function tool call dropped' })
        continue
      }
      const callId = typeof toolCall.id === 'string' && toolCall.id ? toolCall.id : createItemIdFactory('call_')()
      const name = typeof toolCall.function?.name === 'string' ? toolCall.function.name : ''
      if (!name) {
        warnings.push({ field: 'choices[0].message.tool_calls[].function.name', reason: 'tool call without a name dropped' })
        continue
      }
      output.push({
        type: 'function_call',
        id: callItemId(),
        status: 'completed',
        call_id: callId,
        name,
        arguments: typeof toolCall.function?.arguments === 'string' ? toolCall.function.arguments : '{}',
      })
    }
  }

  const finishReason = choice?.finish_reason
  const status = finishReason === 'length' || finishReason === 'content_filter'
    ? 'incomplete'
    : 'completed'

  const response: Record<string, unknown> = {
    id: typeof body.id === 'string' && body.id ? body.id : createItemIdFactory('resp_')(),
    object: 'response',
    created_at: typeof body.created === 'number' ? body.created : Math.floor(Date.now() / 1000),
    status,
    model: typeof body.model === 'string' && body.model ? body.model : requestModel,
    output,
    ...(finishReason === 'length' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    ...(finishReason === 'content_filter' ? { incomplete_details: { reason: 'content_filter' } } : {}),
    ...(body.usage ? { usage: mapUsage(body.usage, warnings) } : {}),
  }

  return { response, warnings }
}

/**
 * Map Chat usage numbers to Responses usage, including token detail nests
 * when the provider supplies them.
 */
export function mapUsage(chatUsage: Record<string, unknown>, warnings: ConversionWarning[]): Record<string, unknown> {
  const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
  const input = number(chatUsage.prompt_tokens)
  const output = number(chatUsage.completion_tokens)
  const total = number(chatUsage.total_tokens)
  if (input === null && output === null && total === null) {
    warnings.push({ field: 'usage', reason: 'upstream usage carries no recognizable token counts' })
  }
  const promptDetails = chatUsage.prompt_tokens_details && typeof chatUsage.prompt_tokens_details === 'object'
    ? chatUsage.prompt_tokens_details as Record<string, unknown>
    : undefined
  const completionDetails = chatUsage.completion_tokens_details && typeof chatUsage.completion_tokens_details === 'object'
    ? chatUsage.completion_tokens_details as Record<string, unknown>
    : undefined
  const cached = number(promptDetails?.cached_tokens)
  const reasoning = number(completionDetails?.reasoning_tokens)
  return {
    input_tokens: input ?? 0,
    output_tokens: output ?? 0,
    total_tokens: total ?? (input ?? 0) + (output ?? 0),
    ...(promptDetails || completionDetails
      ? {
        input_tokens_details: { cached_tokens: cached ?? 0 },
        output_tokens_details: { reasoning_tokens: reasoning ?? 0 },
      }
      : {}),
  }
}

/** Guard used by transport glue before conversion is attempted. */
export function assertChatResponseObject(payload: unknown): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ProtocolConversionError('upstream response body is not a JSON object')
  }
}
