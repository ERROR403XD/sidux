import type { AutomationRuntime, AutomationInspection } from './automationEngine.js'
import type { AutomationRun } from './automationStore.js'

type Rpc = (method: string, params: unknown) => Promise<unknown>
const record = (value: unknown) => value && typeof value === 'object' ? value as Record<string, unknown> : {}

export function createAutomationRuntime(options: {
  rpc: Rpc
  accountBusy: () => boolean
  hasQueuedMessages: (id: string) => Promise<boolean>
  pendingRequests: () => unknown[]
  buildParams: (threadId: string, text: string, runId: string) => Promise<Record<string, unknown>>
}): AutomationRuntime {
  const rpc = options.rpc
  return {
    accountBusy: options.accountBusy,
    async canStart(threadId) {
      if (await options.hasQueuedMessages(threadId)) return false
      const result = record(await rpc('thread/read', { threadId, includeTurns: false }))
      const thread = record(result.thread)
      const status = record(thread.status).type ?? thread.status
      return !['active', 'running', 'inProgress'].includes(String(status))
        && !options.pendingRequests().some((request) => record(record(request).params).threadId === threadId)
    },
    async createThread(cwd, name) {
      const response = record(await rpc('thread/start', { cwd }))
      const thread = record(response.thread)
      if (typeof thread.id !== 'string') throw new Error('未返回 threadId')
      // Failure to set a display name must not orphan an otherwise valid thread.
      await rpc('thread/name/set', { threadId: thread.id, name }).catch(() => {})
      return { threadId: thread.id, model: typeof response.model === 'string' ? response.model : undefined }
    },
    async prepare(threadId, text, runId) {
      await rpc('thread/resume', { threadId })
      return { ...await options.buildParams(threadId, text, runId), clientUserMessageId: runId }
    },
    async start(params) {
      const response = record(await rpc('turn/start', params))
      const turnId = record(response.turn).id
      if (typeof turnId !== 'string') throw new Error('未返回 turnId')
      return { turnId }
    },
    async inspect(run: AutomationRun): Promise<AutomationInspection> {
      const response = record(await rpc('thread/read', { threadId: run.threadId, includeTurns: true }))
      const turns = record(response.thread).turns
      if (!Array.isArray(turns)) return { status: 'unknown' }
      const turn = turns.map(record).find((turn) => run.turnId ? turn.id === run.turnId : Array.isArray(turn.items) && turn.items.some((item) => {
        const value = record(item)
        if (value.type !== 'userMessage') return false
        return value.id === run.runId || (Array.isArray(value.content) && value.content.some((content) => String(record(content).text ?? '').includes(`[CodexApp automation run:${run.runId}]`)))
      }))
      if (!turn) return { status: 'unknown' }
      const turnId = String(turn.id)
      if (turn.status === 'completed' && !turn.error) return { status: 'completed', turnId }
      if (turn.status === 'failed' || turn.error) return { status: 'failed', turnId, error: String(record(turn.error).message ?? '') }
      if (turn.status === 'interrupted') return { status: 'interrupted', turnId }
      const waiting = options.pendingRequests().some((request) => record(record(request).params).threadId === run.threadId)
      return { status: waiting ? 'waiting_input' : 'running', turnId }
    },
    async interrupt(run) { if (run.threadId && run.turnId) await rpc('turn/interrupt', { threadId: run.threadId, turnId: run.turnId }) },
  }
}
