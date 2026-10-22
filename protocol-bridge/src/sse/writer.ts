/**
 * Serialize one wire payload as an SSE frame. Both directions of the bridge
 * speak the same framing: one JSON object per frame, '\n\n' terminated.
 */
export function encodeSseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** The terminal sentinel of a Chat Completions style stream. */
export const SSE_DONE_FRAME = 'data: [DONE]\n\n'
