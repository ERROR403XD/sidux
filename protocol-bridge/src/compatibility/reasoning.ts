import type { ProviderCompatOptions, ResolvedCompatOptions } from '../types.js'
import { DEFAULT_COMPAT_OPTIONS } from '../types.js'

export function resolveCompatOptions(options: ProviderCompatOptions | undefined): ResolvedCompatOptions {
  return {
    reasoningFields: options?.reasoningFields ?? DEFAULT_COMPAT_OPTIONS.reasoningFields,
    maxTokensField: options?.maxTokensField ?? DEFAULT_COMPAT_OPTIONS.maxTokensField,
    includeUsageInStream: options?.includeUsageInStream ?? DEFAULT_COMPAT_OPTIONS.includeUsageInStream,
    unsupportedTools: options?.unsupportedTools ?? DEFAULT_COMPAT_OPTIONS.unsupportedTools,
    silentClose: options?.silentClose ?? DEFAULT_COMPAT_OPTIONS.silentClose,
  }
}

/**
 * Read the first reasoning-ish text field present on a chat delta or message
 * object. Providers disagree on the field name; the compat option lists the
 * candidates in priority order (see docs/COMPATIBILITY.md).
 */
export function extractReasoningText(source: Record<string, unknown>, fields: string[]): string {
  for (const field of fields) {
    const value = source[field]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

/** Chat deltas may deliver content as a plain string or as content parts. */
export function extractDeltaText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  let text = ''
  for (const part of value) {
    if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
      text += (part as { text: string }).text
    }
  }
  return text
}
