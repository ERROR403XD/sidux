import { createDeliveryId } from '../delivery'
import type { ThreadForkResponse, ThreadReadResponse, ThreadStartResponse } from './appServerDtos'
import type {
  CollaborationModeKind,
  ReasoningEffort,
  SpeedMode,
  UiMessage,
} from '../types/codex'
import type { ConfigReadResponse } from './appServerDtos'
import { normalizeCodexApiError } from './codexErrors'
import { assertDeliveryPreparationCurrent, prepareWebDelivery, submitRememberedDelivery, type DeliveryPreparationGuard } from './deliveryOutbox'
import { loadModelCatalog, type ModelCatalogOptions } from './modelCatalog'
import {
  normalizeThreadModelFromPayload,
  normalizeThreadModelProviderFromPayload,
} from './threadModel'
import { normalizeThreadMessagesWithCompaction, readThreadTurnStartIndex } from './threadPayload'
import { capabilityValue } from '../modelCapabilities.js'
import { callRpc } from './rpcGateway'

type CurrentModelConfig = {
  model: string
  providerId: string
  reasoningEffort: ReasoningEffort | ''
  speedMode: SpeedMode
}

type ResolvedCollaborationModeSettings = {
  model: string
  reasoningEffort: ReasoningEffort | null
}

export type FileAttachmentParam = { label: string; path: string; fsPath: string }

function normalizePlanModeReasoningEffort(value: ReasoningEffort | '' | null | undefined): ReasoningEffort | null {
  return value && value.length > 0 ? value : null
}

function normalizeCollaborationModeReasoningEffort(value: ReasoningEffort | '' | null | undefined): ReasoningEffort | null {
  return value && value.length > 0 ? value : null
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | '' {
  return capabilityValue(value)
}

function normalizeSpeedMode(value: unknown): SpeedMode {
  return capabilityValue(value)
}

export function getAvailableModels(options: ModelCatalogOptions = {}) {
  return loadModelCatalog(callRpc, options)
}

export async function getAvailableModelIds(options: ModelCatalogOptions = {}): Promise<string[]> {
  return (await getAvailableModels(options)).map(model => model.id)
}

export async function getCurrentModelConfig(): Promise<CurrentModelConfig> {
  const payload = await callRpc<ConfigReadResponse>('config/read', {})
  const model = payload.config.model ?? ''
  const providerId = typeof payload.config.model_provider === 'string' ? payload.config.model_provider : ''
  const reasoningEffort = normalizeReasoningEffort(payload.config.model_reasoning_effort)
  const speedMode = normalizeSpeedMode(payload.config.service_tier)
  return { model, providerId, reasoningEffort, speedMode }
}

function extractLocalImagePathFromUrl(value: string): string | null {
  if (!value) return null
  try {
    const parsed = new URL(value, 'http://localhost')
    if (parsed.pathname !== '/codex-local-image') return null
    const path = parsed.searchParams.get('path')?.trim() ?? ''
    return path.length > 0 ? path : null
  } catch {
    return null
  }
}

function buildTextWithAttachments(
  prompt: string,
  files: FileAttachmentParam[],
): string {
  if (files.length === 0) return prompt
  let prefix = '# Files mentioned by the user:\n'
  for (const file of files) {
    prefix += `\n## ${file.label}: ${file.path}\n`
  }
  return `${prefix}\n## My request for Codex:\n\n${prompt}\n`
}

function fileNameFromPath(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, '/')
  const segments = normalized.split('/').filter(Boolean)
  return segments.at(-1) ?? normalized
}

async function resolveCollaborationModeSettings(
  mode: CollaborationModeKind,
  model?: string,
  effort?: ReasoningEffort,
  canPrepare?: DeliveryPreparationGuard,
): Promise<ResolvedCollaborationModeSettings> {
  assertDeliveryPreparationCurrent(canPrepare)
  const explicitModel = model?.trim() ?? ''
  if (explicitModel) {
    return {
      model: explicitModel,
      reasoningEffort: mode === 'plan'
        ? normalizePlanModeReasoningEffort(effort)
        : normalizeCollaborationModeReasoningEffort(effort),
    }
  }

  let currentConfig: CurrentModelConfig | null = null
  try {
    currentConfig = await getCurrentModelConfig()
  } catch {
    currentConfig = null
  }
  assertDeliveryPreparationCurrent(canPrepare)

  const configuredModel = currentConfig?.model.trim() ?? ''
  if (configuredModel) {
    return {
      model: configuredModel,
      reasoningEffort: mode === 'plan'
        ? normalizePlanModeReasoningEffort(effort ?? currentConfig?.reasoningEffort)
        : normalizeCollaborationModeReasoningEffort(effort ?? currentConfig?.reasoningEffort),
    }
  }

  let availableModelIds: string[] = []
  try {
    availableModelIds = await getAvailableModelIds()
  } catch {
    availableModelIds = []
  }
  assertDeliveryPreparationCurrent(canPrepare)

  const fallbackModel = availableModelIds.find((candidate) => candidate.trim().length > 0)?.trim() ?? ''
  if (fallbackModel) {
    return {
      model: fallbackModel,
      reasoningEffort: mode === 'plan'
        ? normalizePlanModeReasoningEffort(effort ?? currentConfig?.reasoningEffort)
        : normalizeCollaborationModeReasoningEffort(effort ?? currentConfig?.reasoningEffort),
    }
  }

  throw new Error(`${mode === 'plan' ? 'Plan' : 'Default'} mode requires an available model. Wait for models to load and try again.`)
}

export async function startThreadTurn(
  threadId: string,
  text: string,
  imageUrls: string[] = [],
  model?: string,
  effort?: ReasoningEffort,
  skills?: Array<{ name: string; path: string }>,
  fileAttachments: FileAttachmentParam[] = [],
  collaborationMode?: CollaborationModeKind,
  serviceTier?: string | null,
  deliveryMode: 'immediate' | 'steer' = 'immediate',
  deliveryOptions?: { id: string; requireConfirmed?: boolean; canPrepare?: DeliveryPreparationGuard; onPrepared?: (id: string) => void; onResult?: (result: { id: string; status: string; turnId?: string }) => void },
): Promise<string> {
  try {
    assertDeliveryPreparationCurrent(deliveryOptions?.canPrepare)
    const normalizedModel = model?.trim() ?? ''
    const localImageAttachments: FileAttachmentParam[] = []
    for (const imageUrl of imageUrls) {
      const localImagePath = extractLocalImagePathFromUrl(imageUrl.trim())
      if (!localImagePath) continue
      localImageAttachments.push({
        label: fileNameFromPath(localImagePath),
        path: localImagePath,
        fsPath: localImagePath,
      })
    }
    const allFileAttachments = [...fileAttachments, ...localImageAttachments]
    const dedupedFileAttachments = allFileAttachments.filter((entry, index) =>
      allFileAttachments.findIndex((candidate) => candidate.fsPath === entry.fsPath) === index)
    const trimmedUserText = text.trim()
    const effectivePrompt = trimmedUserText.length > 0
      ? text
      : imageUrls.length > 0 ? '[Image]' : dedupedFileAttachments.length > 0 ? '[Attachment]' : ''
    const finalText = buildTextWithAttachments(effectivePrompt, dedupedFileAttachments)
    const input: Array<Record<string, unknown>> = [{ type: 'text', text: finalText }]
    for (const imageUrl of imageUrls) {
      const normalizedUrl = imageUrl.trim()
      if (!normalizedUrl) continue
      const localImagePath = extractLocalImagePathFromUrl(normalizedUrl)
      if (localImagePath) {
        input.push({
          type: 'localImage',
          path: localImagePath,
        })
        continue
      }
      input.push({
        type: 'image',
        url: normalizedUrl,
        image_url: normalizedUrl,
      })
    }
    if (skills) {
      for (const skill of skills) {
        input.push({ type: 'skill', name: skill.name, path: skill.path })
      }
    }
    const attachments = dedupedFileAttachments.map((file) => ({ label: file.label, path: file.path, fsPath: file.fsPath }))
    const params: Record<string, unknown> = {
      threadId,
      input,
    }
    if (serviceTier !== undefined) params.serviceTier = serviceTier
    if (attachments.length > 0) params.attachments = attachments
    if (normalizedModel) {
      params.model = normalizedModel
    }
    if (typeof effort === 'string' && effort.length > 0) {
      params.effort = effort
    }
    if (collaborationMode) {
      const collaborationModeSettings = await resolveCollaborationModeSettings(collaborationMode, normalizedModel, effort, deliveryOptions?.canPrepare)
      params.collaborationMode = {
        mode: collaborationMode,
        settings: {
          model: collaborationModeSettings.model,
          reasoning_effort: collaborationModeSettings.reasoningEffort,
          developer_instructions: null,
        },
      }
    }
    const pending = await prepareWebDelivery('delivery', {
      protocol: 2, threadId, params, mode: deliveryMode,
      message: {
        id: deliveryOptions?.id || createDeliveryId(), text, imageUrls, skills: skills ?? [], fileAttachments,
        collaborationMode: collaborationMode ?? 'default',
        ...(normalizedModel ? { model: normalizedModel } : {}),
        ...(effort !== undefined ? { effort } : {}),
        ...(serviceTier !== undefined ? { serviceTier } : {}),
      },
    }, deliveryOptions?.canPrepare)
    // Once remembered, the original intent and account snapshot complete even
    // if the display lifecycle changes before its acknowledgement arrives.
    try { deliveryOptions?.onPrepared?.(pending.id) } catch { /* Display observers cannot block a durable submission. */ }
    const payload = await submitRememberedDelivery(pending)
    try { deliveryOptions?.onResult?.({ id: pending.id, status: payload.data.status || 'unknown', turnId: payload.data.turnId }) } catch { /* An observer failure cannot undo acceptance. */ }
    if (payload.data.status === 'cancelled') throw new Error('此提交已停止跟踪，请核对会话后再发送新消息')
    if (deliveryOptions?.requireConfirmed && !payload.data.turnId) throw new Error('回答尚未确认送达，请稍后核对')
    return typeof payload.data.turnId === 'string' ? payload.data.turnId : ''
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to start turn for thread ${threadId}`, 'turn/start')
  }
}

export async function interruptThreadTurn(threadId: string, turnId?: string): Promise<void> {
  const normalizedThreadId = threadId.trim()
  const normalizedTurnId = turnId?.trim() || ''
  if (!normalizedThreadId) return

  try {
    if (!normalizedTurnId) {
      throw new Error('turn/interrupt requires turnId')
    }
    await callRpc('turn/interrupt', { threadId: normalizedThreadId, turnId: normalizedTurnId })
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to interrupt turn for thread ${normalizedThreadId}`, 'turn/interrupt')
  }
}

function normalizeThreadIdFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const record = payload as Record<string, unknown>

  const thread = record.thread
  if (thread && typeof thread === 'object') {
    const threadId = (thread as Record<string, unknown>).id
    if (typeof threadId === 'string' && threadId.length > 0) {
      return threadId
    }
  }
  return ''
}

function normalizeThreadCwdFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const record = payload as Record<string, unknown>

  const thread = record.thread
  if (thread && typeof thread === 'object') {
    const cwd = (thread as Record<string, unknown>).cwd
    if (typeof cwd === 'string' && cwd.length > 0) {
      return cwd
    }
  }
  return ''
}

export async function archiveThread(threadId: string): Promise<void> {
  await callRpc('thread/archive', { threadId })
}

export async function renameThread(threadId: string, threadName: string): Promise<void> {
  await callRpc('thread/name/set', { threadId, name: threadName })
}

export async function updateThreadFileChanges(
  threadId: string,
  turnId: string,
  cwd: string,
  action: 'undo' | 'redo',
  patchIds?: string[],
  scope?: 'single_turn' | 'turn_and_later',
): Promise<{ changed: number; errors: string[]; message?: string; revertedPatchIds?: string[]; appliedPatchIds?: string[] }> {
  try {
    const response = await fetch('/codex-api/thread/rollback-files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId, turnId, cwd, action, patchIds, scope }),
    })
    const payload = (await response.json().catch(() => ({}))) as {
      changed?: number
      reverted?: number
      applied?: number
      errors?: string[]
      message?: string
      error?: string
      revertedPatchIds?: string[]
      appliedPatchIds?: string[]
    }
    if (!response.ok) {
      const message = typeof payload.message === 'string' && payload.message.trim()
        ? payload.message.trim()
        : typeof payload.error === 'string' && payload.error.trim()
          ? payload.error.trim()
          : 'Server error'
      return {
        changed: 0,
        errors: Array.isArray(payload.errors) && payload.errors.length > 0 ? payload.errors : [message],
        message: payload.message,
      }
    }
    return {
      changed: payload.changed ?? payload.reverted ?? payload.applied ?? 0,
      errors: Array.isArray(payload.errors) ? payload.errors : [],
      message: payload.message,
      revertedPatchIds: Array.isArray(payload.revertedPatchIds) ? payload.revertedPatchIds : [],
      appliedPatchIds: Array.isArray(payload.appliedPatchIds) ? payload.appliedPatchIds : [],
    }
  } catch (error) {
    return { changed: 0, errors: [error instanceof Error ? error.message : 'Network error'] }
  }
}

export async function revertThreadFileChanges(threadId: string, turnId: string, cwd: string): Promise<{ reverted: number; errors: string[] }> {
  const result = await updateThreadFileChanges(threadId, turnId, cwd, 'undo')
  return { reverted: result.changed, errors: result.errors }
}

export async function startThread(cwd?: string, model?: string): Promise<StartedThread> {
  try {
    const params: Record<string, unknown> = {}
    if (typeof cwd === 'string' && cwd.trim().length > 0) {
      params.cwd = cwd.trim()
    }
    if (typeof model === 'string' && model.trim().length > 0) {
      params.model = model.trim()
    }
    const payload = await callRpc<ThreadStartResponse>('thread/start', params)
    const threadId = normalizeThreadIdFromPayload(payload)
    if (!threadId) {
      throw new Error('thread/start did not return a thread id')
    }
    return {
      threadId,
      model: normalizeThreadModelFromPayload(payload),
      modelProvider: normalizeThreadModelProviderFromPayload(payload),
    }
  } catch (error) {
    throw normalizeCodexApiError(error, 'Failed to start a new thread', 'thread/start')
  }
}

export async function forkThreadAtTurn(threadId: string, lastTurnId: string): Promise<StartedThread> {
  const response = await fetch('/codex-api/thread-fork-at-turn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId, lastTurnId }),
  })
  const payload = await response.json() as { result?: ThreadForkResponse; error?: string }
  if (!response.ok || !payload.result) throw new Error(payload.error || '无法从该回合创建分支。')
  const forkedId = normalizeThreadIdFromPayload(payload.result)
  if (!forkedId) throw new Error('分支没有返回会话 ID。')
  return { threadId: forkedId, model: normalizeThreadModelFromPayload(payload.result), modelProvider: normalizeThreadModelProviderFromPayload(payload.result) }
}

export async function forkThread(threadId: string): Promise<ForkedThread>
export async function forkThread(threadId: string, cwd: string | undefined, model: string | undefined): Promise<StartedThread>
export async function forkThread(
  threadId: string,
  cwd?: string,
  model?: string,
): Promise<StartedThread | ForkedThread> {
  try {
    if (arguments.length <= 1) {
      const payload = await callRpc<ThreadForkResponse & ThreadReadResponse>(
        'thread/fork',
        {
          threadId,
          persistExtendedHistory: true,
        },
      )
      const forkedThreadId = normalizeThreadIdFromPayload(payload)
      if (!forkedThreadId) {
        throw new Error('thread/fork did not return a thread id')
      }
      return {
        threadId: forkedThreadId,
        cwd: normalizeThreadCwdFromPayload(payload),
        model: normalizeThreadModelFromPayload(payload),
        messages: normalizeThreadMessagesWithCompaction(payload, readThreadTurnStartIndex(payload)),
      }
    }
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) {
      throw new Error('thread/fork requires threadId')
    }
    const params: Record<string, unknown> = {
      threadId: normalizedThreadId,
    }
    if (typeof cwd === 'string' && cwd.trim().length > 0) {
      params.cwd = cwd.trim()
    }
    if (typeof model === 'string' && model.trim().length > 0) {
      params.model = model.trim()
    }
    const payload = await callRpc<ThreadForkResponse>('thread/fork', params)
    const nextThreadId = normalizeThreadIdFromPayload(payload)
    if (!nextThreadId) {
      throw new Error('thread/fork did not return a thread id')
    }
    return {
      threadId: nextThreadId,
      model: normalizeThreadModelFromPayload(payload),
      modelProvider: normalizeThreadModelProviderFromPayload(payload),
    }
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to fork thread ${threadId}`, 'thread/fork')
  }
}

export type StartedThread = {
  threadId: string
  model: string
  modelProvider: string
}

export type ForkedThread = {
  threadId: string
  cwd: string
  model: string
  messages: UiMessage[]
}
