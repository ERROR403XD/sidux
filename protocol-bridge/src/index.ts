/**
 * protocol-bridge — independent OpenAI Responses ↔ Chat Completions
 * protocol conversion component.
 *
 * Public API contract (see docs/INTEGRATION.md):
 * - pure protocol conversion only; transports, retries, auth, and logging
 *   live in the embedding application
 * - every stream object is request-local; instances must not be shared
 * - all functions are synchronous and never perform I/O
 */

// Errors
export {
  UnsupportedFeatureError,
  ProtocolParseError,
  ProtocolConversionError,
  StreamInterruptedError,
  InvalidStateError,
  isBridgeError,
} from './errors.js'
export type { BridgeError, BridgeErrorCode } from './errors.js'

// SSE framing
export { SseParser } from './sse/parser.js'
export type { SseMessage, SseParserOptions } from './sse/parser.js'
export { encodeSseFrame, SSE_DONE_FRAME } from './sse/writer.js'

// IR and options
export type {
  ChatContentPart,
  ChatMessage,
  ChatRequest,
  ChatTool,
  ChatToolChoice,
  CommonSamplingParams,
  ConversionWarning,
  NormalizedFinishReason,
  NormalizedStreamEvent,
  NormalizedUsage,
  ProviderCompatOptions,
  ResolvedCompatOptions,
} from './types.js'
export { DEFAULT_COMPAT_OPTIONS } from './types.js'

// Primary direction: Responses request/stream in, Chat upstream out.
export { responsesRequestToChatRequest } from './chat/requestDecoder.js'
export type { DecodedResponsesRequest } from './chat/requestDecoder.js'
export { chatResponseToResponses, mapUsage } from './chat/responseEncoder.js'
export type { EncodedResponsesResponse } from './chat/responseEncoder.js'
export { ChatStreamDecoder } from './chat/streamDecoder.js'
export { ResponsesStreamEncoder } from './responses/streamEncoder.js'
export type { ResponsesStreamEvent } from './responses/streamEncoder.js'
export { ChatToResponsesStreamTranslator } from './chat/streamTranslator.js'
export type { ChatToResponsesStreamTranslatorOptions } from './chat/streamTranslator.js'

// Reverse direction: Chat request/stream in, Responses upstream out.
export { chatRequestToResponsesRequest } from './responses/requestEncoder.js'
export type { EncodedResponsesRequest } from './responses/requestEncoder.js'
export { responsesResponseToChatResponse } from './responses/responseDecoder.js'
export type { DecodedChatResponse } from './responses/responseDecoder.js'
export { ResponsesStreamDecoder } from './responses/streamDecoder.js'
export { ChatStreamEncoder } from './chat/streamEncoder.js'
export type { ChatStreamChunk } from './chat/streamEncoder.js'
export { ResponsesToChatStreamTranslator } from './responses/streamTranslator.js'
export type { ResponsesToChatStreamTranslatorOptions } from './responses/streamTranslator.js'

// Ids
export { createItemIdFactory, createResponseId } from './id.js'
export type { ItemIdFactory } from './id.js'

// Compatibility helpers
export { extractReasoningText, extractDeltaText, resolveCompatOptions } from './compatibility/reasoning.js'
