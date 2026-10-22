import { hookRunKey, readCommandOutput, readHookConfiguration } from '../processActivity.js'
import type { BackgroundTerminalReader } from './backgroundTerminalReader.js'
import { readCommandToolOutput } from './commandToolOutput.js'
import { asRecord } from './httpUtils.js'
import type { ProcessActivityStore } from './processActivityStore.js'
import { readNonEmptyString } from './runtimePaths.js'
import type { ThreadHistory } from './threadHistory.js'

type ProcessActivityDependencies = {
  observations: Pick<ProcessActivityStore, 'snapshot' | 'output' | 'command'>
  backgroundTerminals: Pick<BackgroundTerminalReader, 'list' | 'terminate'>
  history: Pick<ThreadHistory, 'page'>
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>
}

export function createProcessActivityService({ observations, backgroundTerminals, history, rpc }: ProcessActivityDependencies) {
  async function readHooks(threadId: string) {
    const snapshot = await observations.snapshot(threadId)
    return {
      ...snapshot,
      runs: snapshot.runs.map(run => ({
        ...run,
        entries: run.entries.slice(0, 1).map(entry => ({ ...entry, text: entry.text.slice(0, 160) })),
      })),
    }
  }

  async function readHookDetail(threadId: string, runKey: string | null) {
    const snapshot = await observations.snapshot(threadId)
    return snapshot.runs.find(run => hookRunKey(run) === runKey)
  }

  async function readHookConfig(cwd: string) {
    return readHookConfiguration(await rpc('hooks/list', { cwds: [cwd] }), cwd)
  }

  async function readOutput(threadId: string, itemId: string) {
    let output = observations.output(threadId, itemId)
    if (!output?.text) {
      const page = await history.page(threadId, { limit: 10 })
      const thread = asRecord(asRecord(page.result)?.thread)
      const turns = thread?.turns
      if (Array.isArray(turns)) {
        for (const turn of turns) {
          const items = asRecord(turn)?.items
          if (!Array.isArray(items)) continue
          const item = items.find(item => asRecord(item)?.id === itemId)
          const saved = item ? readCommandOutput(item, 'history') : null
          if (saved?.text || !output) output = saved || output
        }
      }
      const command = observations.command(threadId, itemId)
      const path = readNonEmptyString(thread?.path)
      if (!output?.text && command && path) {
        const text = await readCommandToolOutput(path, command)
        if (text) output = { itemId, text, status: output?.status || 'unknown', exitCode: output?.exitCode ?? null, truncated: true, source: 'toolResult' }
      }
    }
    return output || { itemId, text: '', status: 'unknown', exitCode: null, truncated: false, source: 'unavailable' }
  }

  return {
    readHooks,
    readHookDetail,
    readHookConfig,
    readOutput,
    readTerminals: (threadId: string) => backgroundTerminals.list(threadId),
    terminate: (threadId: string, processId: string, itemId: string) => backgroundTerminals.terminate(threadId, processId, itemId),
  }
}
