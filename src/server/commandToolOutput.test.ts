import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { readCommandToolOutput } from './commandToolOutput'

const meta = (turnId = 'turn-a', at = 100) => ({ turn_id: turnId, create_time: at })
const start = { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call-a', internal_chat_message_metadata_passthrough: meta() } }
const result = (text: string, processId: number, turnId = 'turn-a', at = 101, callId = 'call-a') => ({ type: 'response_item', payload: {
  type: 'custom_tool_call_output', call_id: callId, internal_chat_message_metadata_passthrough: meta(turnId, at),
  output: [{ type: 'input_text', text: JSON.stringify({ status: 'fulfilled', value: { chunk_id: 'chunk', session_id: processId, wall_time_seconds: 1, output: text } }) }],
} })

describe('bounded code-mode command output fallback', () => {
  it('matches only observed process, turn, time and exec call; rejects reused or unstructured identities', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codexapp-command-result-'))
    const path = join(directory, 'rollout.jsonl')
    try {
      await writeFile(path, [start, result('OLD', 17, 'turn-a', 99), result('OTHER_TURN', 17, 'turn-b'), result('OTHER_PROCESS', 18), result('UNKNOWN_CALL', 17, 'turn-a', 101, 'call-b'), result('MATCHED_OUTPUT', 17)].map(value => JSON.stringify(value)).join('\n') + '\n')
      expect(await readCommandToolOutput(path, { processId: '17', turnId: 'turn-a', startedAtMs: 100000 })).toBe('MATCHED_OUTPUT')
      expect(await readCommandToolOutput(path, { processId: '17', turnId: 'turn-a', startedAtMs: 102000 })).toBeNull()
      const ambiguous = result('A', 17)
      ambiguous.payload.output.push(...result('B', 17).payload.output)
      await writeFile(path, [start, ambiguous].map(value => JSON.stringify(value)).join('\n'))
      expect(await readCommandToolOutput(path, { processId: '17', turnId: 'turn-a', startedAtMs: 100000 })).toBeNull()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('reads only the last MB and limits output to 32k without accepting partial JSONL records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codexapp-command-result-'))
    const path = join(directory, 'rollout.jsonl')
    try {
      await writeFile(path, JSON.stringify(start) + '\n' + JSON.stringify(result('TOO_OLD', 17)) + '\n' + 'x'.repeat(1024 * 1024 + 100) + '\n' + [start, result('z'.repeat(40000), 17)].map(value => JSON.stringify(value)).join('\n') + '\n{"partial"')
      expect(await readCommandToolOutput(path, { processId: '17', turnId: 'turn-a', startedAtMs: 100000 })).toBe('z'.repeat(32768))
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
