import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { OUTPUT_LIMIT } from '../processActivity.js'

export type CommandObservation = { processId: string; turnId: string; startedAtMs: number }
const TAIL_BYTES = 1024 * 1024

/** Code-mode can return stdout in structured exec results without outputDelta.
 * Only match a native command's observed process/turn identity and time window.
 * Do not evaluate scripts, scan all history, or guess stdout from message text. */
export async function readCommandToolOutput(path: string, command: CommandObservation): Promise<string | null> {
  if (!isAbsolute(path) || !command.processId || !command.turnId || !command.startedAtMs) return null
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile()) return null
    const offset = Math.max(0, info.size - TAIL_BYTES)
    const buffer = Buffer.alloc(Math.min(info.size, TAIL_BYTES))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const lines = (offset ? text.slice(text.indexOf('\n') + 1) : text).split('\n').slice(-2000)
    const execCalls = new Set<string>()
    let output = ''
    for (const line of lines) {
      try {
        const row = JSON.parse(line)
        const payload = row?.payload
        const meta = payload?.internal_chat_message_metadata_passthrough
        if (row.type === 'response_item' && payload?.type === 'custom_tool_call' && payload.name === 'exec'
          && typeof payload.call_id === 'string' && meta?.turn_id === command.turnId) execCalls.add(payload.call_id)
        if (row.type !== 'response_item' || payload?.type !== 'custom_tool_call_output'
          || !execCalls.has(payload.call_id)
          || meta?.turn_id !== command.turnId || typeof meta.create_time !== 'number' || meta.create_time * 1000 < command.startedAtMs
          || !Array.isArray(payload.output)) continue
        const matches: string[] = []
        for (const block of payload.output.slice(0, 200)) {
          if (block?.type !== 'input_text' || typeof block.text !== 'string') continue
          let result: any
          try { result = JSON.parse(block.text) } catch { continue }
          if (result?.status === 'fulfilled') result = result.value
          if (String(result?.session_id) !== command.processId || typeof result?.chunk_id !== 'string'
            || typeof result?.wall_time_seconds !== 'number' || typeof result?.output !== 'string') continue
          matches.push(result.output)
        }
        // Multiple returned commands with the same ID in a single script are ambiguous.
        if (matches.length === 1) output = (output + matches[0]).slice(-OUTPUT_LIMIT)
      } catch {
        // A clipped first/last JSONL record or an unrelated legacy line is not evidence.
      }
    }
    return output || null
  } finally {
    await handle.close()
  }
}
