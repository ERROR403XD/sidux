import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeStoredQueuedMessage, normalizeThreadQueueState, type ThreadQueueState } from '../threadQueue.js'
import { queueGlobalStateMutation, writeGlobalState } from './globalStateStore.js'
import { asRecord } from './httpUtils.js'
import { getCodexHomeDir } from './runtimePaths.js'

const THREAD_QUEUE_STATE_KEY = 'thread-queue-state'

export async function readLegacyThreadQueueState(): Promise<ThreadQueueState> {
  const statePath = join(getCodexHomeDir(), '.codex-global-state.json')
  try {
    const legacy = asRecord(JSON.parse(await readFile(statePath, 'utf8')))?.[THREAD_QUEUE_STATE_KEY]
    if (legacy === undefined) return {}
    const queues = asRecord(legacy)
    if (!queues || Object.entries(queues).some(([id, rows]) => !id.trim() || !Array.isArray(rows) || rows.some(row => !normalizeStoredQueuedMessage(row)))) throw new Error('旧队列内容无效，已停止迁移')
    return normalizeThreadQueueState(queues)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

export async function clearLegacyThreadQueueState(): Promise<void> {
  const statePath = join(getCodexHomeDir(), '.codex-global-state.json')
  await queueGlobalStateMutation(statePath, async () => {
    let raw: string
    try {
      raw = await readFile(statePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const payload = asRecord(JSON.parse(raw))
    if (!payload) throw new Error('全局状态文件无效，已停止队列迁移')
    if (!(THREAD_QUEUE_STATE_KEY in payload)) return
    delete payload[THREAD_QUEUE_STATE_KEY]
    await writeGlobalState(statePath, payload)
  })
}
