import { open } from 'node:fs/promises'
import type { AppServerProcess } from './appServerProcess.js'
import type { BackendQueueProcessor } from './backendQueueRuntime.js'
import type { ScheduledResumeChoice, ScheduledResumeMark } from '../threadScheduledResume.js'
import type { StoredQueuedMessage } from '../threadQueue.js'
import { asRecord } from './httpUtils.js'
import { readNonEmptyString } from './runtimePaths.js'
import { isDeliveryAcceptance } from '../delivery.js'

export async function readLastConversationChoice(path: string): Promise<Partial<ScheduledResumeChoice>> {
  if (!path) return {}
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    const limit = Math.min(size, 8 * 1024 * 1024)
    let tail = ''
    for (let scanned = 0; scanned < limit;) {
      const length = Math.min(256 * 1024, limit - scanned)
      const buffer = Buffer.alloc(length)
      const position = size - scanned - length
      const { bytesRead } = await file.read(buffer, 0, length, position)
      scanned += length
      const lines = (buffer.subarray(0, bytesRead).toString('utf8') + tail).split('\n')
      tail = position > 0 ? lines.shift() || '' : ''
      for (const line of lines.reverse()) {
        try {
          if (!line.includes('"turn_context"')) continue
          const row = JSON.parse(line)
          if (row.type !== 'turn_context') continue
          const context = asRecord(row.payload)
          return {
            model: readNonEmptyString(context?.model),
            effort: readNonEmptyString(context?.effort ?? context?.reasoning_effort),
            tier: readNonEmptyString(context?.service_tier),
          }
        } catch { /* A bounded tail may start inside a JSONL row. */ }
      }
    }
    return {}
  } finally { await file.close() }
}

export function createThreadScheduledResumeRuntime(appServer: Pick<AppServerProcess, 'notifyScheduledResumeChanged'>, queue: Pick<BackendQueueProcessor, 'history' | 'buildQueuedTurnParams' | 'submit' | 'deliveryContext' | 'deliveries' | 'store'>) {
  async function submit(threadId: string, mark: ScheduledResumeMark): Promise<'submitted' | 'started'> {
    const message: StoredQueuedMessage = {
      id: mark.attemptId, continuation: true, resumeSource: 'scheduled', text: '继续之前的工作', imageUrls: [], skills: [], fileAttachments: [], collaborationMode: 'default',
      model: mark.choice.model, effort: mark.choice.effort as StoredQueuedMessage['effort'], serviceTier: mark.choice.tier || null,
    }
    const params = await queue.buildQueuedTurnParams({ threadId, message })
    const result = await queue.submit({ protocol: 2, threadId, message, params, expectedContextId: mark.contextId })
    if (['failed', 'unknown', 'cancelled'].includes(String(result.status))) throw new Error('定时续跑提交未确认，请核对会话。')
    return result.status === 'accepted' ? 'started' : 'submitted'
  }
  return {
    prepare: async (threadId: string, chosen?: ScheduledResumeChoice) => {
      const result = asRecord(await queue.history.metadata(threadId))
      const thread = asRecord(result?.thread)
      const path = readNonEmptyString(thread?.path)
      const saved = chosen ? {} : await readLastConversationChoice(path)
      if (!chosen && path && !saved.model) throw new Error('无法读取最近回合的模型和推理强度，请先打开会话确认后重试。')
      const model = chosen?.model || saved.model || readNonEmptyString(result?.model ?? thread?.model)
      if (!model) throw new Error('无法读取会话模型，请先打开会话确认模型后重试。')
      const choice = { model, effort: chosen?.effort ?? saved.effort ?? '', tier: chosen?.tier ?? saved.tier ?? '' }
      if (choice.effort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(choice.effort)) throw new Error('会话推理强度无效')
      return { choice, contextId: await queue.deliveryContext() }
    },
    submit,
    inspect: async (threadId: string, mark: ScheduledResumeMark): Promise<{ status: 'submitted' | 'started' | 'unknown' | 'failed'; turnId?: string; error?: string }> => {
      let row = await queue.deliveries.result(mark.attemptId)
      if (!row) {
        if (mark.status === 'failed') return { status: 'failed', error: mark.error || '续跑提交结果待核对，请查看会话。' }
        if (mark.attemptedAt && Date.now() - mark.attemptedAt < 86400_000) {
          // Retry the same durable delivery ID, never a new message identity.
          await submit(threadId, mark)
          row = await queue.deliveries.result(mark.attemptId)
        }
        if (!row) return { status: 'unknown', error: '续跑提交结果待核对，请查看会话。' }
      }
      if (row.threadId !== threadId || ('message' in row ? row.message.id : row.id) !== mark.attemptId) return { status: 'unknown' }
      if ('message' in row) {
        if (row.status === 'failed') return { status: 'failed', error: row.error }
        if (row.status === 'unknown') {
          const reconciled = await queue.deliveries.reconcile(mark.attemptId)
          if (reconciled && !('message' in reconciled)) row = reconciled
          else return { status: 'unknown', error: row.error }
        } else return { status: 'submitted' }
      }
      if (row.threadId !== threadId || row.id !== mark.attemptId) return { status: 'unknown' }
      if (row.status === 'cancelled') return { status: 'failed', error: '定时续跑投递已取消，请查看会话。' }
      // Durable acceptance consumes this one-shot schedule, independent of later turn/GOAL state.
      if (row.status !== 'accepted' || !isDeliveryAcceptance(row)) return { status: 'unknown' }
      return { status: 'started', ...(row.turnId ? { turnId: row.turnId } : {}) }
    },
    cancel: async (id: string) => {
      const row = await queue.deliveries.result(id)
      if (row && 'message' in row && ['queued', 'editing', 'failed'].includes(row.status)) {
        await queue.store.remove(id, row.revision)
      }
    },
    changed: () => appServer.notifyScheduledResumeChanged(),
  }
}
