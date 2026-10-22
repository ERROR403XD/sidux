import { getErrorMessage } from './httpUtils.js'

export function isEmptyThreadReadError(error: unknown): boolean {
  const message = getErrorMessage(error, '').toLowerCase()
  return message.includes('failed to read thread') && message.includes('rollout') && message.includes('is empty')
}

export function isThreadMaterializationPendingError(error: unknown): boolean {
  const message = getErrorMessage(error, '').toLowerCase()
  return message.includes('not materialized yet') && message.includes('includeturns is unavailable before first user message')
}

export function isUnauthenticatedRateLimitError(error: unknown): boolean {
  const message = getErrorMessage(error, '').toLowerCase()
  return message.includes('authentication required') && message.includes('rate limits')
}

export function isThreadNotFoundError(error: unknown): boolean {
  const message = getErrorMessage(error, '').toLowerCase()
  return message.includes('thread not found') || message.includes('no rollout found for thread id')
}
