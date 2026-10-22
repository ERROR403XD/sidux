import { ProtocolConversionError, UnsupportedFeatureError } from '../errors.js'
import type { ConversionWarning } from '../types.js'

type ChatMessageShape = {
  role?: unknown
  content?: unknown
  reasoning_content?: unknown
  tool_call_id?: unknown
  tool_calls?: Array<{ id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } }>
}

type ChatToolShape = {
  type?: unknown
  function?: { name?: unknown; description?: unknown; parameters?: unknown; strict?: unknown }
}

export type EncodedResponsesRequest = {
  request: Record<string, unknown>
  warnings: ConversionWarning[]
}

/**
 * Convert a Chat Completions request into a Responses API request
 * (reverse direction). Used when a Chat caller talks to a Responses-native
 * upstream through the bridge.
 */
export function chatRequestToResponsesRequest(payload: unknown): EncodedResponsesRequest {
  const warnings: ConversionWarning[] = []
  const body = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null
  if (!body) throw new ProtocolConversionError('Chat request body must be a JSON object')

  const model = body.model
  if (typeof model !== 'string' || model.length === 0) {
    throw new ProtocolConversionError('Chat request is missing a string "model" field')
  }
  if (!Array.isArray(body.messages)) throw new ProtocolConversionError('Chat request requires a "messages" array')

  const instructions: string[] = []
  const input: Array<Record<string, unknown>> = []

  for (const [index, rawMessage] of body.messages.entries()) {
    const message = rawMessage && typeof rawMessage === 'object' ? rawMessage as ChatMessageShape : null
    if (!message) {
      warnings.push({ field: `messages[${index}]`, reason: 'non-object message dropped' })
      continue
    }
    const role = message.role
    if (role === 'system' || role === 'developer') {
      const text = typeof message.content === 'string' ? message.content : partsText(message.content)
      if (text) instructions.push(text)
      continue
    }
    if (role === 'user' || role === 'assistant') {
      const item: Record<string, unknown> = { type: 'message', role }
      item.content = typeof message.content === 'string'
        ? message.content ? [{ type: role === 'user' ? 'input_text' : 'output_text', text: message.content }] : []
        : partsToResponseContent(message.content, role, warnings, index)
      if (role === 'assistant' && typeof message.reasoning_content === 'string' && message.reasoning_content) {
        input.push({
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: message.reasoning_content }],
        })
      }
      if (Array.isArray(message.tool_calls)) {
        for (const toolCall of message.tool_calls) {
          if (!toolCall || toolCall.type !== 'function' || typeof toolCall.function?.name !== 'string' || typeof toolCall.id !== 'string') {
            warnings.push({ field: `messages[${index}].tool_calls[]`, reason: 'malformed tool call dropped' })
            continue
          }
          input.push({
            type: 'function_call',
            call_id: toolCall.id,
            name: toolCall.function.name,
            arguments: typeof toolCall.function.arguments === 'string' ? toolCall.function.arguments : '{}',
          })
        }
      }
      // An assistant message that only carried tool calls has no text item.
      if (Array.isArray(item.content) ? item.content.length > 0 : Boolean(item.content)) {
        input.push(item)
      }
      continue
    }
    if (role === 'tool') {
      if (typeof message.tool_call_id !== 'string') {
        throw new ProtocolConversionError(`messages[${index}] tool message requires "tool_call_id"`)
      }
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? null),
      })
      continue
    }
    throw new UnsupportedFeatureError(`message role "${String(role)}" is not supported by the Responses conversion`, 'messages[].role')
  }

  const request: Record<string, unknown> = { model, input, stream: body.stream === true }
  if (instructions.length > 0) request.instructions = instructions.join('\n\n')
  if (typeof body.max_tokens === 'number') request.max_output_tokens = body.max_tokens
  else if (typeof body.max_completion_tokens === 'number') request.max_output_tokens = body.max_completion_tokens
  if (typeof body.temperature === 'number') request.temperature = body.temperature
  if (typeof body.top_p === 'number') request.top_p = body.top_p
  if (typeof body.service_tier === 'string') request.service_tier = body.service_tier
  if (typeof body.parallel_tool_calls === 'boolean') request.parallel_tool_calls = body.parallel_tool_calls
  if (typeof body.reasoning_effort === 'string') request.reasoning = { effort: body.reasoning_effort }

  if (Array.isArray(body.tools)) {
    const tools: Array<Record<string, unknown>> = []
    for (const rawTool of body.tools) {
      const tool = rawTool && typeof rawTool === 'object' ? rawTool as ChatToolShape : null
      if (!tool || tool.type !== 'function' || typeof tool.function?.name !== 'string') {
        warnings.push({ field: 'tools[]', reason: 'only function tools can be forwarded to Responses' })
        continue
      }
      tools.push({
        type: 'function',
        name: tool.function.name,
        ...(typeof tool.function.description === 'string' ? { description: tool.function.description } : {}),
        ...(tool.function.parameters !== undefined ? { parameters: tool.function.parameters } : {}),
        ...(typeof tool.function.strict === 'boolean' ? { strict: tool.function.strict } : {}),
      })
    }
    if (tools.length > 0) request.tools = tools
  }

  if (typeof body.tool_choice === 'string') {
    if (body.tool_choice === 'none' || body.tool_choice === 'auto' || body.tool_choice === 'required') {
      request.tool_choice = body.tool_choice
    }
  } else if (body.tool_choice && typeof body.tool_choice === 'object') {
    const choice = body.tool_choice as { type?: unknown; function?: { name?: unknown } }
    if (choice.type === 'function' && typeof choice.function?.name === 'string') {
      request.tool_choice = { type: 'function', name: choice.function.name }
    }
  }

  if (body.response_format && typeof body.response_format === 'object') {
    const format = body.response_format as { type?: unknown; json_schema?: { name?: unknown; schema?: unknown; strict?: unknown } }
    if (format.type === 'json_object') request.text = { format: { type: 'json_object' } }
    else if (format.type === 'json_schema' && format.json_schema) {
      request.text = {
        format: {
          type: 'json_schema',
          ...(format.json_schema.name !== undefined ? { name: format.json_schema.name } : {}),
          ...(format.json_schema.schema !== undefined ? { schema: format.json_schema.schema } : {}),
          ...(format.json_schema.strict !== undefined ? { strict: format.json_schema.strict } : {}),
        },
      }
    }
  }

  if (body.stream_options !== undefined) {
    warnings.push({ field: 'stream_options', reason: 'Responses streams always include usage; option dropped' })
  }

  return { request, warnings }
}

function partsText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
    .join('')
}

function partsToResponseContent(content: unknown, role: 'user' | 'assistant', warnings: ConversionWarning[], index: number): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = []
  const partType = role === 'user' ? 'input_text' : 'output_text'
  if (typeof content === 'string') {
    if (content) parts.push({ type: partType, text: content })
    return parts
  }
  if (!Array.isArray(content)) return parts
  for (const part of content) {
    if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
      if ((part as { text: string }).text) parts.push({ type: partType, text: (part as { text: string }).text })
    } else if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'image_url') {
      warnings.push({ field: `messages[${index}].content[]`, reason: 'image parts are not forwarded in the reverse direction' })
    }
  }
  return parts
}
