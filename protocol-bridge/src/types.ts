/**
 * Normalized Intermediate Representation (IR) for streaming conversion.
 *
 * Both wire protocols are decoded INTO these events and encoded FROM them:
 *
 *   Chat Completions chunk  ──ChatStreamDecoder──▶  NormalizedStreamEvent[]  ──ResponsesStreamEncoder──▶  Responses SSE event
 *   Responses SSE event     ──ResponsesStreamDecoder──▶  NormalizedStreamEvent[]  ──ChatStreamEncoder──▶  Chat Completions chunk
 *
 * The IR is intentionally small. It carries only what both protocols can
 * express; provider quirks are normalized by compatibility adapters before
 * events reach this layer.
 */

/** Sampling/model parameters that can pass through unchanged. */
export type CommonSamplingParams = {
  temperature?: number
  top_p?: number
  service_tier?: string
  parallel_tool_calls?: boolean
  stop?: string | string[]
}

/** Tool definition accepted by the Chat Completions wire format. */
export type ChatTool = {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: unknown
    strict?: boolean
  }
}

export type ChatToolChoice = 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } }

/** A fully converted Chat Completions request (decoder output / encoder input). */
export type ChatRequest = {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  stream_options?: { include_usage: boolean }
  tools?: ChatTool[]
  tool_choice?: ChatToolChoice
  tool_calls?: never
  max_tokens?: number
  max_completion_tokens?: number
  reasoning_effort?: string
  response_format?: unknown
} & CommonSamplingParams

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | Array<ChatContentPart>
  reasoning_content?: string
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** Chat usage numbers, already normalized (no provider-specific nesting). */
export type NormalizedUsage = {
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  cachedInputTokens: number | null
  reasoningTokens: number | null
}

/** Terminal reason of an upstream generation, protocol-independent. */
export type NormalizedFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter'

/**
 * The normalized streaming IR. Exactly one stream of these events flows from
 * a decoder to an encoder per request.
 */
export type NormalizedStreamEvent =
  | { kind: 'start'; responseId: string; model: string }
  | { kind: 'textDelta'; text: string }
  | { kind: 'reasoningDelta'; text: string }
  | { kind: 'toolCallStart'; toolIndex: number; callId: string; name: string }
  | { kind: 'toolCallNameDelta'; toolIndex: number; nameDelta: string }
  | { kind: 'toolCallArgumentsDelta'; toolIndex: number; argumentsDelta: string }
  | { kind: 'finish'; reason: NormalizedFinishReason }
  | { kind: 'usage'; usage: NormalizedUsage }

/**
 * Diagnostic for input fields that were dropped because the target protocol
 * cannot represent them. Conversion never fails silently: unknown/dropped
 * fields are reported here so callers can log them.
 */
export type ConversionWarning = {
  field: string
  reason: string
}

export type ProviderCompatOptions = {
  /**
   * Upstream delta/message fields that may carry reasoning text, checked in
   * order. Defaults to ['reasoning_content', 'reasoning'] which covers
   * DeepSeek-style and OpenRouter-style providers.
   */
  reasoningFields?: string[]
  /** Which chat field carries the output token cap. Defaults to 'max_tokens'. */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  /**
   * Ask the upstream to include usage in streamed responses via
   * stream_options.include_usage. Defaults to true.
   */
  includeUsageInStream?: boolean
  /** Non-function tool definitions: fail the request ('error') or drop them ('omit'). Defaults to 'error'. */
  unsupportedTools?: 'error' | 'omit'
  /**
   * Upstream stream closed without [DONE] and without finish_reason:
   * 'complete' ends the response gracefully (default), 'fail' emits a
   * protocol failure.
   */
  silentClose?: 'complete' | 'fail'
}

export const DEFAULT_COMPAT_OPTIONS: Required<Omit<ProviderCompatOptions, 'reasoningFields'>> & { reasoningFields: string[] } = {
  reasoningFields: ['reasoning_content', 'reasoning'],
  maxTokensField: 'max_tokens',
  includeUsageInStream: true,
  unsupportedTools: 'error',
  silentClose: 'complete',
}

/** Resolved options after merging caller input with defaults. */
export type ResolvedCompatOptions = Required<ProviderCompatOptions>
