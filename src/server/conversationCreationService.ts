import { stat } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'
import { createDeliveryId } from '../delivery.js'
import { capabilityValue } from '../modelCapabilities.js'
import { isVirtualProjectId } from '../projectOrganization.js'
import { ProxyError } from './apiProxy/store.js'
import { asRecord } from './httpUtils.js'
import { createProjectConversationDirectory } from './projectDirectoryService.js'
import { persistWorkspaceRoot } from './workspaceStateService.js'

export type ConversationCreationRequest = {
  project: string
  command: string
  model?: string
  reasoningEffort?: string
}

export type ConversationCreationResult = {
  object: 'conversation'
  threadId: string
  messageId: string
  project: string
  cwd: string
  model: string | null
  reasoningEffort: string | null
  status: string
  turnId?: string
  url: string
}

export class ConversationCreationError extends ProxyError {
  constructor(readonly threadId: string, readonly messageId: string) {
    super('conversation_submission_failed', '会话已创建，但首条指令的提交结果未确认，请在会话中核对后再操作。', 502)
  }
}

function parseRequest(input: unknown): ConversationCreationRequest {
  const value = asRecord(input)
  const project = typeof value?.project === 'string' ? value.project.trim() : ''
  const command = typeof value?.command === 'string' ? value.command : ''
  if (!project || project.includes('\0') || (!isAbsolute(project) && !isVirtualProjectId(project))) {
    throw new ProxyError('invalid_project', 'project 须为项目的绝对目录或 virtual: 项目 ID。')
  }
  if (!command.trim()) throw new ProxyError('invalid_command', 'command 须为非空的会话指令。')
  const model = value?.model == null ? undefined : capabilityValue(value.model)
  const reasoningEffort = value?.reasoningEffort == null ? undefined : capabilityValue(value.reasoningEffort)
  if (model === '') throw new ProxyError('invalid_model', 'model 须为有效的模型标识。')
  if (reasoningEffort === '') throw new ProxyError('invalid_reasoning_effort', 'reasoningEffort 须为有效的推理强度。')
  return { project, command, model, reasoningEffort }
}

async function resolveProject(project: string, command: string): Promise<string> {
  if (isVirtualProjectId(project)) {
    try {
      return (await createProjectConversationDirectory(command, project)).cwd
    } catch {
      throw new ProxyError('project_unavailable', '项目不存在或无法创建会话工作目录。', 404)
    }
  }
  const cwd = normalize(project)
  try {
    if (!(await stat(cwd)).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new ProxyError('project_unavailable', '项目目录不存在或不可访问。', 404)
  }
  await persistWorkspaceRoot(cwd)
  return cwd
}

export function createConversationCreationService(dependencies: {
  rpc: (method: string, params: unknown) => Promise<unknown>
  deliveryContext: () => Promise<string>
  submit: (input: unknown) => Promise<Record<string, unknown>>
  isIdentityChanging: () => boolean
  resolveProject?: (project: string, command: string) => Promise<string>
}) {
  return async (input: unknown, assertActive: () => void): Promise<ConversationCreationResult> => {
    const request = parseRequest(input)
    assertActive()
    if (dependencies.isIdentityChanging()) throw new ProxyError('account_busy', '账号或供应方正在切换，请稍后重试。', 409)
    const cwd = await (dependencies.resolveProject || resolveProject)(request.project, request.command)
    assertActive()
    const expectedContextId = await dependencies.deliveryContext()
    assertActive()
    const started = asRecord(await dependencies.rpc('thread/start', {
      cwd,
      ...(request.model ? { model: request.model } : {}),
      ...(request.reasoningEffort ? { config: { model_reasoning_effort: request.reasoningEffort } } : {}),
    }))
    const thread = asRecord(started?.thread)
    const threadId = typeof thread?.id === 'string' ? thread.id : ''
    if (!threadId) throw new ProxyError('conversation_creation_failed', '未收到新会话 ID。', 502)
    const messageId = createDeliveryId()
    const model = request.model || capabilityValue(started?.model) || null
    const reasoningEffort = request.reasoningEffort || capabilityValue(started?.reasoningEffort) || null
    try {
      assertActive()
      const name = request.command.trim().split(/\r?\n/, 1)[0]!.slice(0, 120)
      await dependencies.rpc('thread/name/set', { threadId, name }).catch(() => undefined)
      assertActive()
      const delivery = await dependencies.submit({
        protocol: 2,
        threadId,
        expectedContextId,
        message: { id: messageId, text: request.command, ...(model ? { model } : {}), ...(reasoningEffort ? { effort: reasoningEffort } : {}) },
        params: {
          threadId,
          input: [{ type: 'text', text: request.command }],
          ...(model ? { model } : {}),
          ...(reasoningEffort ? { effort: reasoningEffort } : {}),
        },
      })
      return {
        object: 'conversation', threadId, messageId, project: request.project, cwd, model, reasoningEffort,
        status: String(delivery.status),
        ...(typeof delivery.turnId === 'string' ? { turnId: delivery.turnId } : {}),
        url: `/#/thread/${encodeURIComponent(threadId)}`,
      }
    } catch {
      throw new ConversationCreationError(threadId, messageId)
    }
  }
}
