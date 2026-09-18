import { ProtocolConversionError, UnsupportedFeatureError } from '../errors.js'
import { resolveCompatOptions } from '../compatibility/reasoning.js'
import type {
  ChatContentPart,
  ChatMessage,
  ChatRequest,
  ChatTool,
  ConversionWarning,
  ProviderCompatOptions,
  ResolvedCompatOptions,
} from '../types.js'

/**
 * Responses `input` item shapes the decoder understands. Extra fields are
 * tolerated; anything with an unrecognized `type` fails the request.
 */
type ResponsesInputItem = {
  type?: string
  role?: string
  content?: unknown
  text?: string
  name?: string
  arguments?: string
  call_id?: string
  output?: unknown
  summary?: unknown
  id?: string
}

type ResponsesToolDefinition = {
  type?: string
  name?: string
  description?: string
  parameters?: unknown
  strict?: unknown
}

type ResponsesToolChoice = {
  type?: string
  name?: unknown
  mode?: unknown
}

type ResponsesToolChoiceFunction = { type: 'function'; function: { name: string } }

export type DecodedResponsesRequest = {
  request: ChatRequest
  warnings: ConversionWarning[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function contentPartsToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const part of content) {
    const row = asRecord(part)
    if (!row) continue
    if ((row.type === 'input_text' || row.type === 'output_text') && typeof row.text === 'string') {
      text += row.text
    } else if (row.type === 'refusal' && typeof row.refusal === 'string') {
      text += row.refusal
    }
  }
  return text
}

function messageContentParts(content: unknown, warnings: ConversionWarning[], itemIndex: number): string | ChatContentPart[] {
  // Chat messages accept a plain string or an array of text/image parts.
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: ChatContentPart[] = []
  for (const part of content) {
    const row = asRecord(part)
    if (!row) continue
    if ((row.type === 'input_text' || row.type === 'output_text') && typeof row.text === 'string') {
      if (row.text) parts.push({ type: 'text', text: row.text })
    } else if (row.type === 'input_image') {
      const imageUrl = typeof row.image_url === 'string' ? row.image_url : ''
      if (imageUrl) parts.push({ type: 'image_url', image_url: { url: imageUrl } })
      else warnings.push({ field: `input[${itemIndex}].content[].image_url`, reason: 'input_image without an inline URL cannot be converted' })
    } else if (row.type === 'refusal' && typeof row.refusal === 'string') {
      if (row.refusal) parts.push({ type: 'text', text: row.refusal })
    } else {
      warnings.push({ field: `input[${itemIndex}].content[].type`, reason: `content part '${String(row.type)}' was dropped` })
    }
  }
  return parts.length === 1 && parts[0]!.type === 'text' ? parts[0]!.text : parts
}

/**
 * Convert a Responses API request payload into a Chat Completions request.
 *
 * This is a pure function: it never performs I/O and never mutates its
 * input. Fields the Chat protocol cannot represent are either rejected with
 * UnsupportedFeatureError (semantics would break) or dropped and reported in
 * `warnings` (semantics degrade gracefully).
 */
export function responsesRequestToChatRequest(
  payload: unknown,
  compatOptions?: ProviderCompatOptions,
): DecodedResponsesRequest {
  const compat = resolveCompatOptions(compatOptions)
  const warnings: ConversionWarning[] = []
  const body = asRecord(payload)
  if (!body) throw new ProtocolConversionError('Responses request body must be a JSON object')

  const model = body.model
  if (typeof model !== 'string' || model.length === 0) {
    throw new ProtocolConversionError('Responses request is missing a string "model" field')
  }

  const messages: ChatMessage[] = []
  let pendingReasoning = ''

  if (typeof body.instructions === 'string' && body.instructions.length > 0) {
    messages.push({ role: 'system', content: body.instructions })
  }

  const input = body.input
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input })
  } else if (Array.isArray(input)) {
    decodeInputItems(input, messages, compat, warnings, () => pendingReasoning, value => { pendingReasoning = value })
  } else if (input !== undefined) {
    throw new ProtocolConversionError('Responses "input" must be a string or an array of items')
  }

  const request: ChatRequest = { model, messages }

  const stream = body.stream === true
  if (body.stream !== undefined) request.stream = stream
  if (stream && compat.includeUsageInStream) request.stream_options = { include_usage: true }

  if (typeof body.max_output_tokens === 'number') {
    if (compat.maxTokensField === 'max_completion_tokens') request.max_completion_tokens = body.max_output_tokens
    else request.max_tokens = body.max_output_tokens
  }
  if (typeof body.temperature === 'number') request.temperature = body.temperature
  if (typeof body.top_p === 'number') request.top_p = body.top_p
  if (typeof body.service_tier === 'string') request.service_tier = body.service_tier
  if (typeof body.parallel_tool_calls === 'boolean') request.parallel_tool_calls = body.parallel_tool_calls

  const reasoning = asRecord(body.reasoning)
  if (reasoning && typeof reasoning.effort === 'string') request.reasoning_effort = reasoning.effort
  if (reasoning && reasoning.summary !== undefined) {
    warnings.push({ field: 'reasoning.summary', reason: 'chat providers choose their own reasoning exposure; summary hint dropped' })
  }

  const tools = decodeTools(body.tools, compat, warnings)
  if (tools) request.tools = tools
  const toolChoice = decodeToolChoice(body.tool_choice)
  if (toolChoice) request.tool_choice = toolChoice

  const responseFormat = decodeTextFormat(body.text, warnings)
  if (responseFormat) request.response_format = responseFormat

  warnDroppedTopLevelFields(body, warnings)

  return { request, warnings }
}

function decodeInputItems(
  items: unknown[],
  messages: ChatMessage[],
  compat: ResolvedCompatOptions,
  warnings: ConversionWarning[],
  getPendingReasoning: () => string,
  setPendingReasoning: (value: string) => void,
): void {
  items.forEach((rawItem, itemIndex) => {
    const item = asRecord(rawItem) as ResponsesInputItem | null
    if (!item) {
      warnings.push({ field: `input[${itemIndex}]`, reason: 'non-object input item dropped' })
      return
    }
    switch (item.type) {
      case 'message': decodeMessageItem(item, itemIndex, messages, warnings, getPendingReasoning, setPendingReasoning); return
      case 'function_call': decodeFunctionCallItem(item, messages, getPendingReasoning, setPendingReasoning); return
      case 'function_call_output': decodeFunctionCallOutputItem(item, messages); return
      case 'reasoning': decodeReasoningItem(item, getPendingReasoning, setPendingReasoning, warnings, itemIndex); return
      case 'item_reference':
        throw new UnsupportedFeatureError(
          'input item type "item_reference" requires server-side response storage, which the protocol bridge does not provide',
          'input[].item_reference')
      case 'computer_call':
      case 'computer_call_output':
        throw new UnsupportedFeatureError(`input item type "${item.type}" (computer use) has no Chat Completions equivalent`, `input[].${item.type}`)
      case 'local_shell_call':
      case 'local_shell_call_output':
        throw new UnsupportedFeatureError(`input item type "${item.type}" (local shell) has no Chat Completions equivalent`, `input[].${item.type}`)
      case 'custom_tool_call':
      case 'custom_tool_call_output':
        throw new UnsupportedFeatureError(`input item type "${item.type}" (custom tools) has no Chat Completions equivalent`, `input[].${item.type}`)
      case 'web_search_call':
        throw new UnsupportedFeatureError('input item type "web_search_call" (built-in web search) has no Chat Completions equivalent', 'input[].web_search_call')
      case 'image_generation_call':
        throw new UnsupportedFeatureError('input item type "image_generation_call" has no Chat Completions equivalent', 'input[].image_generation_call')
      case 'code_interpreter_call':
        throw new UnsupportedFeatureError('input item type "code_interpreter_call" has no Chat Completions equivalent', 'input[].code_interpreter_call')
      case 'mcp_call':
      case 'mcp_list_tools':
      case 'mcp_approval_request':
      case 'mcp_approval_response':
        throw new UnsupportedFeatureError(`input item type "${item.type}" (built-in MCP) has no Chat Completions equivalent`, `input[].${item.type}`)
      default:
        throw new UnsupportedFeatureError(`input item type "${String(item.type)}" is not supported by the Chat Completions conversion`, 'input[]')
    }
  })
}

function decodeMessageItem(
  item: ResponsesInputItem,
  itemIndex: number,
  messages: ChatMessage[],
  warnings: ConversionWarning[],
  getPendingReasoning: () => string,
  setPendingReasoning: (value: string) => void,
): void {
  const role = item.role
  if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'developer') {
    throw new ProtocolConversionError(`input[${itemIndex}] message has unsupported role "${String(role)}"`)
  }
  const content = messageContentParts(item.content, warnings, itemIndex)
  if (role === 'assistant') {
    // Keep replayed reasoning attached to the assistant turn that produced
    // it; reasoning-capable chat providers use reasoning_content on replay.
    const reasoning = getPendingReasoning()
    messages.push({ role: 'assistant', content, ...(reasoning ? { reasoning_content: reasoning } : {}) })
    setPendingReasoning('')
    return
  }
  messages.push({ role: role === 'developer' ? 'system' : role, content })
}

function decodeFunctionCallItem(
  item: ResponsesInputItem,
  messages: ChatMessage[],
  getPendingReasoning: () => string,
  setPendingReasoning: (value: string) => void,
): void {
  if (typeof item.call_id !== 'string' || typeof item.name !== 'string') {
    throw new ProtocolConversionError('function_call input item requires "call_id" and "name" strings')
  }
  const toolCall = {
    id: item.call_id,
    type: 'function' as const,
    function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : '{}' },
  }
  const reasoning = getPendingReasoning()
  const last = messages[messages.length - 1]
  if (last && last.role === 'assistant' && !last.tool_call_id) {
    last.tool_calls = [...(last.tool_calls ?? []), toolCall]
    if (reasoning) last.reasoning_content = last.reasoning_content ? `${last.reasoning_content}\n${reasoning}` : reasoning
  } else {
    messages.push({ role: 'assistant', content: '', tool_calls: [toolCall], ...(reasoning ? { reasoning_content: reasoning } : {}) })
  }
  setPendingReasoning('')
}

function decodeFunctionCallOutputItem(item: ResponsesInputItem, messages: ChatMessage[]): void {
  if (typeof item.call_id !== 'string') {
    throw new ProtocolConversionError('function_call_output input item requires a "call_id" string')
  }
  messages.push({ role: 'tool', tool_call_id: item.call_id, content: stringifyToolOutput(item.output) })
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === 'string') return output
  if (output === undefined || output === null) return ''
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}

function reasoningTextFromItem(item: ResponsesInputItem): string {
  let text = contentPartsToText(item.content)
  if (!text) text = summaryToText(item.summary)
  return text
}

function summaryToText(summary: unknown): string {
  if (!Array.isArray(summary)) return ''
  let text = ''
  for (const part of summary) {
    const row = asRecord(part)
    if (row && typeof row.text === 'string') text += row.text
  }
  return text
}

function decodeReasoningItem(
  item: ResponsesInputItem,
  getPendingReasoning: () => string,
  setPendingReasoning: (value: string) => void,
  warnings: ConversionWarning[],
  itemIndex: number,
): void {
  const text = reasoningTextFromItem(item)
  if (!text) {
    // Reasoning items without replayable text (e.g. encrypted-only) are skipped.
    if (asRecord(item) && 'encrypted_content' in item) {
      warnings.push({ field: `input[${itemIndex}].encrypted_content`, reason: 'encrypted reasoning cannot be replayed to chat providers' })
    }
    return
  }
  const pending = getPendingReasoning()
  setPendingReasoning(pending ? `${pending}\n${text}` : text)
}

function decodeTools(tools: unknown, compat: ResolvedCompatOptions, warnings: ConversionWarning[]): ChatTool[] | undefined {
  if (tools === undefined) return undefined
  if (!Array.isArray(tools)) throw new ProtocolConversionError('Responses "tools" must be an array')
  const mapped: ChatTool[] = []
  for (const rawTool of tools) {
    const tool = asRecord(rawTool) as ResponsesToolDefinition | null
    if (!tool || typeof tool.type !== 'string') {
      warnings.push({ field: 'tools[]', reason: 'non-object tool definition dropped' })
      continue
    }
    if (tool.type !== 'function') {
      if (compat.unsupportedTools === 'omit') {
        warnings.push({ field: `tools[].type`, reason: `tool type '${tool.type}' has no Chat equivalent and was omitted` })
        continue
      }
      throw new UnsupportedFeatureError(
        `tool type "${tool.type}" is not supported by the Chat Completions conversion; only function tools can be forwarded`,
        `tools[].${tool.type}`)
    }
    if (typeof tool.name !== 'string' || tool.name.length === 0) {
      throw new ProtocolConversionError('function tool definition requires a "name" string')
    }
    mapped.push({
      type: 'function',
      function: {
        name: tool.name,
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
        ...(typeof tool.strict === 'boolean' ? { strict: tool.strict } : {}),
      },
    })
  }
  return mapped.length > 0 ? mapped : undefined
}

function decodeToolChoice(toolChoice: unknown): ResponsesToolChoiceFunction | 'none' | 'auto' | 'required' | undefined {
  if (toolChoice === undefined) return undefined
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'none' || toolChoice === 'auto' || toolChoice === 'required') return toolChoice
    throw new UnsupportedFeatureError(`tool_choice "${toolChoice}" is not supported by the Chat Completions conversion`, 'tool_choice')
  }
  const choice = asRecord(toolChoice) as ResponsesToolChoice | null
  if (!choice) throw new ProtocolConversionError('Responses "tool_choice" must be a string or an object')
  if (choice.type === 'function' && typeof choice.name === 'string') {
    return { type: 'function', function: { name: choice.name } }
  }
  throw new UnsupportedFeatureError('only function tool_choice can be forwarded to Chat Completions', 'tool_choice')
}

function decodeTextFormat(text: unknown, warnings: ConversionWarning[]): unknown {
  const textConfig = asRecord(text)
  if (!textConfig) return undefined
  const format = asRecord(textConfig.format)
  if (!format) return undefined
  if (format.type === 'json_object') return { type: 'json_object' }
  if (format.type === 'json_schema') {
    return {
      type: 'json_schema',
      json_schema: {
        ...(typeof format.name === 'string' ? { name: format.name } : {}),
        ...(format.schema !== undefined ? { schema: format.schema } : {}),
        ...(typeof format.strict === 'boolean' ? { strict: format.strict } : {}),
      },
    }
  }
  warnings.push({ field: 'text.format.type', reason: `format '${String(format.type)}' was dropped` })
  return undefined
}

const SILENTLY_DROPPED_FIELDS = new Set([
  // Always false for bridge traffic: conversion is stateless by construction.
  'store',
  // Not represented in Chat Completions; dropping never changes semantics.
  'metadata',
  'user',
  'safety_identifier',
  'stream',
  'model',
  'input',
  'instructions',
  'max_output_tokens',
  'temperature',
  'top_p',
  'service_tier',
  'parallel_tool_calls',
  'reasoning',
  'tools',
  'tool_choice',
  'text',
  'stream_options',
])

function warnDroppedTopLevelFields(body: Record<string, unknown>, warnings: ConversionWarning[]): void {
  for (const field of Object.keys(body)) {
    if (SILENTLY_DROPPED_FIELDS.has(field)) continue
    if (field === 'previous_response_id') {
      const value = body[field]
      if (typeof value === 'string' && value.length > 0) {
        throw new UnsupportedFeatureError(
          'previous_response_id requires server-side response storage, which the protocol bridge does not provide; the client must send full conversation input',
          'previous_response_id')
      }
      continue
    }
    if (field === 'background') {
      if (body[field] === true) {
        throw new UnsupportedFeatureError('background responses are not supported by the protocol bridge', 'background')
      }
      continue
    }
    if (field === 'conversation') {
      if (body[field] !== null && body[field] !== undefined) {
        throw new UnsupportedFeatureError('managed conversations are not supported by the protocol bridge', 'conversation')
      }
      continue
    }
    if (field === 'include') {
      warnings.push({ field: 'include', reason: 'include directives are ignored; bridge output contains plain text reasoning only' })
      continue
    }
    warnings.push({ field, reason: 'unknown field was dropped' })
  }
}
