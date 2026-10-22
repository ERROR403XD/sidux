import { randomUUID } from 'node:crypto'

/**
 * Per-request item id generation.
 *
 * Responses items carry ids the client may reference (Codex does not, but
 * other clients do). Ids only need uniqueness within one response, so a
 * monotonic counter plus one random root per request is sufficient and cheap.
 */
export type ItemIdFactory = () => string

export function createItemIdFactory(prefix: string): ItemIdFactory {
  const root = randomUUID().replace(/-/g, '').slice(0, 12)
  let counter = 0
  return () => `${prefix}${counter++}_${root}`
}

export function createResponseId(): string {
  return `resp_${randomUUID().replace(/-/g, '')}`
}
