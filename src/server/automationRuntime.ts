import type { AutomationRuntime, AutomationInspection } from './automationEngine.js'
import type { AutomationRun } from './automationStore.js'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { isVirtualProjectId } from '../projectOrganization.js'
import type { AutomationPreparation } from './automationPreparation.js'

type Rpc = (method: string, params: unknown, runId?: string, scope?: AutomationPreparation) => Promise<unknown>
const record = (value: unknown) => value && typeof value === 'object' ? value as Record<string, unknown> : {}

export function createAutomationRuntime(options: {
  rpc: Rpc
  beginPreparation?: AutomationRuntime['beginPreparation']
  endPreparation?: AutomationRuntime['endPreparation']
  resolveCwd?: (cwd: string, name: string) => Promise<string>
  acquireAccount?: AutomationRuntime['acquireAccount']
  releaseAccount?: AutomationRuntime['releaseAccount']
  accountStorageId?: AutomationRuntime['accountStorageId']
  accountBusy: () => boolean
  hasQueuedMessages: (id: string) => Promise<boolean>
  pendingRequests: () => unknown[]
  readHistory: (threadId: string) => Promise<unknown>
  buildParams: (threadId: string, text: string, runId: string) => Promise<Record<string, unknown>>
}): AutomationRuntime {
  const rpc = options.rpc
  return {
    beginPreparation: options.beginPreparation,
    endPreparation: options.endPreparation,
    acquireAccount: options.acquireAccount,
    releaseAccount: options.releaseAccount,
    accountStorageId: options.accountStorageId,
    accountBusy: options.accountBusy,
    async canStart(threadId, scope) {
      if (await options.hasQueuedMessages(threadId)) return false
      scope?.assertActive()
      const result = record(await rpc('thread/read', { threadId, includeTurns: false }, undefined, scope))
      const thread = record(result.thread)
      const status = record(thread.status).type ?? thread.status
      return !['active', 'running', 'inProgress'].includes(String(status))
        && !options.pendingRequests().some((request) => record(record(request).params).threadId === threadId)
    },
    async createThread(cwd, name, settings = {}, runId) {
      if (isVirtualProjectId(cwd)) {
        if (!options.resolveCwd) throw new Error('Project not found')
        cwd = await options.resolveCwd(cwd, name)
        if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) throw new Error('cwd 不是目录')
      }
      const response = record(await rpc('thread/start', { cwd, ...(settings.model ? { model: settings.model } : {}) }, runId))
      const thread = record(response.thread)
      if (typeof thread.id !== 'string') throw new Error('未返回 threadId')
      // Failure to set a display name must not orphan an otherwise valid thread.
      await rpc('thread/name/set', { threadId: thread.id, name }, runId).catch(() => {})
      return { threadId: thread.id, model: typeof response.model === 'string' ? response.model : undefined }
    },
    async prepare(threadId, text, runId, settings = {}) {
      // The account worker owns newly created threads before a rollout exists.
      // Its turn/start path resumes only unloaded threads; resuming here would
      // reject a new empty thread before its first message can be submitted.
      const params = await options.buildParams(threadId, text, runId)
      if (settings.model) params.model = settings.model
      if (settings.reasoningEffort) params.effort = settings.reasoningEffort
      else if (settings.model) delete params.effort
      if (settings.serviceTier || settings.model) params.serviceTier = settings.serviceTier || null
      if (params.collaborationMode) {
        const mode = record(params.collaborationMode)
        params.collaborationMode = { ...mode, settings: { ...record(mode.settings), ...(settings.model ? { model: settings.model } : {}), ...(settings.reasoningEffort || settings.model ? { reasoning_effort: settings.reasoningEffort || null } : {}) } }
      }
      return { ...params, clientUserMessageId: runId }
    },
    async start(params) {
      const response = record(await rpc('turn/start', params, String(record(params).clientUserMessageId || '')))
      const turnId = record(response.turn).id
      if (typeof turnId !== 'string') throw new Error('未返回 turnId')
      return { turnId }
    },
    async inspect(run: AutomationRun): Promise<AutomationInspection> {
      if (!run.threadId) return { status: 'unknown' }
      const response = record(await options.readHistory(run.threadId))
      const turns = record(response.thread).turns
      if (!Array.isArray(turns)) return { status: 'unknown' }
      const turn = turns.map(record).find((turn) => run.turnId ? turn.id === run.turnId : Array.isArray(turn.items) && turn.items.some((item) => {
        const value = record(item)
        if (value.type !== 'userMessage') return false
        return value.clientId === run.runId || (Array.isArray(value.content) && value.content.some((content) => String(record(content).text ?? '').includes(`[CodexApp automation run:${run.runId}]`)))
      }))
      if (!turn) return { status: 'unknown' }
      const turnId = String(turn.id)
      if (turn.status === 'completed' && !turn.error) return { status: 'completed', turnId }
      if (turn.status === 'failed' || turn.error) return { status: 'failed', turnId, error: String(record(turn.error).message ?? '') }
      if (turn.status === 'interrupted') return { status: 'interrupted', turnId }
      const waiting = options.pendingRequests().some((request) => record(record(request).params).threadId === run.threadId)
      const threadStatus = record(record(response.thread).status).type ?? record(response.thread).status
      if (!waiting && threadStatus && !['active', 'running', 'inProgress'].includes(String(threadStatus))) return { status: 'interrupted', turnId }
      return { status: waiting ? 'waiting_input' : 'running', turnId }
    },
    async interrupt(run) { if (run.threadId && run.turnId) await rpc('turn/interrupt', { threadId: run.threadId, turnId: run.turnId }) },
  }
}
