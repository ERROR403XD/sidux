/**
 * Error hierarchy for the protocol bridge.
 *
 * All errors carry a stable `code` so transport glue can map them onto the
 * target protocol's error surface without string matching. Errors never
 * contain request payload content; callers add context in their own logs.
 */

export type BridgeErrorCode =
  | 'unsupported_feature'
  | 'protocol_parse'
  | 'protocol_conversion'
  | 'stream_interrupted'
  | 'invalid_state'

/** A capability exists in one protocol but cannot be mapped losslessly. */
export class UnsupportedFeatureError extends Error {
  readonly code = 'unsupported_feature' as const
  constructor(message: string, readonly feature: string) {
    super(message)
    this.name = 'UnsupportedFeatureError'
  }
}

/** Upstream bytes could not be parsed as the expected wire protocol. */
export class ProtocolParseError extends Error {
  readonly code = 'protocol_parse' as const
  constructor(message: string) {
    super(message)
    this.name = 'ProtocolParseError'
  }
}

/** Parsed data violates the expected protocol shape during conversion. */
export class ProtocolConversionError extends Error {
  readonly code = 'protocol_conversion' as const
  constructor(message: string) {
    super(message)
    this.name = 'ProtocolConversionError'
  }
}

/** The upstream stream ended before the protocol reached a terminal state. */
export class StreamInterruptedError extends Error {
  readonly code = 'stream_interrupted' as const
  constructor(message: string) {
    super(message)
    this.name = 'StreamInterruptedError'
  }
}

/** A translator method was called in the wrong lifecycle phase. */
export class InvalidStateError extends Error {
  readonly code = 'invalid_state' as const
  constructor(message: string) {
    super(message)
    this.name = 'InvalidStateError'
  }
}

export type BridgeError =
  | UnsupportedFeatureError
  | ProtocolParseError
  | ProtocolConversionError
  | StreamInterruptedError
  | InvalidStateError

export function isBridgeError(error: unknown): error is BridgeError {
  return error instanceof UnsupportedFeatureError
    || error instanceof ProtocolParseError
    || error instanceof ProtocolConversionError
    || error instanceof StreamInterruptedError
    || error instanceof InvalidStateError
}
