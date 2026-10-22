import { computed, ref, shallowRef } from 'vue'
import type { RpcNotification } from '../api/codexRpcClient'
import { getPendingServerRequests, replyToServerRequest } from '../api/runtimeGateway'
import type { AuthRecoveryState } from '../authRecovery'
import type { UiPendingRequestState, UiServerRequest, UiServerRequestReply } from '../types/codex'
import { isAsyncUserInputRequest } from '../userQuestions'
import { asRecord, omitKey, readString } from './threadNotificationValues'

export const GLOBAL_SERVER_REQUEST_SCOPE = '__global__'

type ThreadPendingRequestControllerOptions = {
  getAccountRevision: () => number
  onChanged: () => void
  setPageError: (message: string) => void
}

export function createThreadPendingRequestController({ getAccountRevision, onChanged, setPageError }: ThreadPendingRequestControllerOptions) {
  const pendingServerRequestsByThreadId = ref<Record<string, UiServerRequest[]>>({})
  const authRecoveryByThreadId = ref<Record<string, AuthRecoveryState>>({})
  const replyOperations = shallowRef(new Map<number, object>())
  const replyErrors = shallowRef(new Map<number, string>())

  function clearReplyError(id: number): void {
    if (!replyErrors.value.has(id)) return
    const next = new Map(replyErrors.value)
    next.delete(id)
    replyErrors.value = next
  }

  function pruneReplyErrors(requests: Record<string, UiServerRequest[]>): void {
    const ids = new Set(Object.values(requests).flatMap(rows => rows.map(request => request.id)))
    replyErrors.value = new Map([...replyErrors.value].filter(([id]) => ids.has(id)))
  }
  let pendingSnapshot: {
    requests: Map<number, UiServerRequest | null>
    auth: Map<string, AuthRecoveryState | null>
  } | null = null
  let pendingSnapshotRead: {
    identityRevision: number
    lifecycleRevision: number
    promise: Promise<void> | null
  } | null = null
  let pendingLifecycleRevision = 0
  let active = true


  function normalizeServerRequest(params: unknown): UiServerRequest | null {
    const row = asRecord(params)
    if (!row) return null

    const id = row.id
    const rawMethod = readString(row.method)
    const requestParams = row.params
    if (typeof id !== 'number' || !Number.isInteger(id) || !rawMethod) {
      return null
    }

    const requestParamRecord = asRecord(requestParams)
    const method = normalizePendingServerRequestMethod(rawMethod, requestParamRecord)
    const threadId = (
      readString(requestParamRecord?.threadId) ||
      readString(requestParamRecord?.thread_id) ||
      readString(requestParamRecord?.conversationId) ||
      readString(requestParamRecord?.conversation_id) ||
      GLOBAL_SERVER_REQUEST_SCOPE
    )
    const turnId = readString(requestParamRecord?.turnId) || readString(requestParamRecord?.turn_id)
    const itemId = (
      readString(requestParamRecord?.itemId) ||
      readString(requestParamRecord?.item_id) ||
      readString(requestParamRecord?.callId) ||
      readString(requestParamRecord?.call_id)
    )
    const receivedAtIso = readString(row.receivedAtIso) || new Date().toISOString()

    return {
      id,
      method,
      threadId,
      turnId,
      itemId,
      receivedAtIso,
      params: requestParams ?? null,
    }
  }

  function normalizePendingServerRequestMethod(
    method: string,
    params: Record<string, unknown> | null,
  ): string {
    const normalized = method.trim()
    if (!normalized) return normalized

    if (
      normalized === 'item/commandExecution/requestApproval' ||
      normalized === 'execCommandApproval' ||
      normalized === 'exec_approval_request' ||
      looksLikeExecApprovalRequest(params)
    ) {
      return 'item/commandExecution/requestApproval'
    }

    if (
      normalized === 'item/fileChange/requestApproval' ||
      normalized === 'applyPatchApproval' ||
      normalized === 'apply_patch_approval_request' ||
      looksLikePatchApprovalRequest(params)
    ) {
      return 'item/fileChange/requestApproval'
    }

    if (
      normalized === 'item/tool/requestUserInput' ||
      normalized === 'request_user_input' ||
      looksLikeToolUserInputRequest(params)
    ) {
      return 'item/tool/requestUserInput'
    }

    if (
      normalized === 'mcpServer/elicitation/request' ||
      normalized === 'elicitation_request' ||
      looksLikeMcpServerElicitationRequest(params)
    ) {
      return 'mcpServer/elicitation/request'
    }

    if (normalized === 'item/permissions/requestApproval' || looksLikePermissionsApprovalRequest(params)) {
      return 'item/permissions/requestApproval'
    }

    if (
      normalized === 'item/tool/call' ||
      normalized === 'dynamic_tool_call_request' ||
      looksLikeToolCallRequest(params)
    ) {
      return 'item/tool/call'
    }

    return normalized
  }

  function looksLikeExecApprovalRequest(params: Record<string, unknown> | null): boolean {
    if (!params) return false
    const command = params.command
    if (Array.isArray(command) && command.some((part) => typeof part === 'string' && part.trim().length > 0)) {
      return true
    }
    if (typeof command === 'string' && command.trim().length > 0) {
      return true
    }
    return Array.isArray(params.commandActions)
  }

  function looksLikePatchApprovalRequest(params: Record<string, unknown> | null): boolean {
    if (!params) return false
    if (typeof params.grantRoot === 'string' && params.grantRoot.trim().length > 0) return true
    if (typeof params.grant_root === 'string' && params.grant_root.trim().length > 0) return true
    if (asRecord(params.fileChanges)) return true
    return asRecord(params.changes) !== null
  }

  function looksLikeToolUserInputRequest(params: Record<string, unknown> | null): boolean {
    return Boolean(params && Array.isArray(params.questions))
  }

  function looksLikeToolCallRequest(params: Record<string, unknown> | null): boolean {
    if (!params) return false
    return (
      typeof params.toolName === 'string' ||
      typeof params.tool_name === 'string' ||
      typeof params.name === 'string' ||
      Array.isArray(params.arguments)
    )
  }

  function looksLikeMcpServerElicitationRequest(params: Record<string, unknown> | null): boolean {
    if (!params) return false
    const mode = readString(params.mode)
    return (
      typeof params.serverName === 'string' &&
      typeof params.threadId === 'string' &&
      typeof params.message === 'string' &&
      (mode === 'form' || mode === 'url')
    )
  }

  function looksLikePermissionsApprovalRequest(params: Record<string, unknown> | null): boolean {
    if (!params) return false
    return (
      typeof params.threadId === 'string' &&
      typeof params.turnId === 'string' &&
      typeof params.itemId === 'string' &&
      asRecord(params.permissions) !== null
    )
  }

  function upsertPendingServerRequest(request: UiServerRequest): void {
    pendingSnapshot?.requests.set(request.id, request)
    const threadId = request.threadId || GLOBAL_SERVER_REQUEST_SCOPE
    const current = pendingServerRequestsByThreadId.value[threadId] ?? []
    const index = current.findIndex((row) => row.id === request.id)
    const nextRows = [...current]
    if (index >= 0) {
      nextRows.splice(index, 1, request)
    } else {
      nextRows.push(request)
    }

    pendingServerRequestsByThreadId.value = {
      ...pendingServerRequestsByThreadId.value,
      [threadId]: nextRows.sort((first, second) => first.receivedAtIso.localeCompare(second.receivedAtIso)),
    }
    onChanged()
  }

  function removePendingServerRequestById(requestId: number): void {
    clearReplyError(requestId)
    pendingSnapshot?.requests.set(requestId, null)
    const next: Record<string, UiServerRequest[]> = {}
    for (const [threadId, requests] of Object.entries(pendingServerRequestsByThreadId.value)) {
      const filtered = requests.filter((request) => request.id !== requestId)
      if (filtered.length > 0) {
        next[threadId] = filtered
      }
    }
    pendingServerRequestsByThreadId.value = next
    onChanged()
  }

  function replacePendingServerRequests(requests: UiServerRequest[]): void {
    const next: Record<string, UiServerRequest[]> = {}
    for (const request of requests) {
      const threadId = request.threadId || GLOBAL_SERVER_REQUEST_SCOPE
      const current = next[threadId] ?? []
      current.push(request)
      next[threadId] = current
    }

    for (const rows of Object.values(next)) {
      rows.sort((first, second) => first.receivedAtIso.localeCompare(second.receivedAtIso))
    }

    pendingServerRequestsByThreadId.value = next
    pruneReplyErrors(next)
  }

  function handleServerRequestNotification(notification: RpcNotification): boolean {
    if (notification.method === 'server/request') {
      const request = normalizeServerRequest(notification.params)
      if (!request) return true
      upsertPendingServerRequest(request)
      return true
    }

    if (notification.method === 'server/request/resolved') {
      const row = asRecord(notification.params)
      const id = row?.id
      if (typeof id === 'number' && Number.isInteger(id)) {
        removePendingServerRequestById(id)
      }
      return true
    }

    return false
  }

  function setAuthRecoveryForThread(threadId: string, recovery: AuthRecoveryState | null): void {
    pendingSnapshot?.auth.set(threadId, recovery)
    if (!recovery) {
      authRecoveryByThreadId.value = omitKey(authRecoveryByThreadId.value, threadId)
      return
    }
    const states = { ...authRecoveryByThreadId.value, [threadId]: recovery }
    const ids = Object.keys(states)
    if (ids.length > 100) delete states[ids[0]]
    authRecoveryByThreadId.value = states
  }

  function loadPendingServerRequestsFromBridge(): Promise<void> {
    const identityRevision = getAccountRevision()
    const lifecycleRevision = pendingLifecycleRevision
    if (pendingSnapshotRead?.identityRevision === identityRevision
      && pendingSnapshotRead.lifecycleRevision === lifecycleRevision
      && pendingSnapshotRead.promise) return pendingSnapshotRead.promise

    const request = { identityRevision, lifecycleRevision, promise: null as Promise<void> | null }
    pendingSnapshotRead = request
    request.promise = readSnapshot()
    return request.promise

    async function readSnapshot(): Promise<void> {
      const changes = {
        requests: new Map<number, UiServerRequest | null>(),
        auth: new Map<string, AuthRecoveryState | null>(),
      }
      pendingSnapshot = changes
      let recoverySnapshot: AuthRecoveryState[] | undefined
      try {
        const rows = await getPendingServerRequests(states => { recoverySnapshot = states })
        if (pendingSnapshot !== changes || identityRevision !== getAccountRevision() || lifecycleRevision !== pendingLifecycleRevision) return
        const requests = new Map(rows
          .map(row => normalizeServerRequest(row))
          .filter((request): request is UiServerRequest => request !== null)
          .map(request => [request.id, request]))
        // Live events that arrive during the read are newer than its snapshot.
        // Apply both additions and resolutions without another network request.
        for (const [id, request] of changes.requests) {
          if (request) requests.set(id, request)
          else requests.delete(id)
        }
        replacePendingServerRequests([...requests.values()])
        if (recoverySnapshot) {
          const recovery = new Map(recoverySnapshot.map(state => [state.threadId, state]))
          for (const [id, state] of changes.auth) {
            if (state) recovery.set(id, state)
            else recovery.delete(id)
          }
          authRecoveryByThreadId.value = Object.fromEntries(recovery)
        }
        onChanged()
      } catch {
        // Keep current requests and drafts available for a later reconnect.
      } finally {
        if (pendingSnapshot === changes) pendingSnapshot = null
        if (pendingSnapshotRead === request) pendingSnapshotRead = null
      }
    }
  }

  function capturePendingReplyContext(): () => boolean {
    const identityRevision = getAccountRevision()
    const lifecycleRevision = pendingLifecycleRevision
    return () => active && identityRevision === getAccountRevision() && lifecycleRevision === pendingLifecycleRevision
  }

  async function respondToPendingServerRequest(reply: UiServerRequestReply): Promise<boolean> {
    const isCurrent = capturePendingReplyContext()
    if (!isCurrent() || replyOperations.value.has(reply.id)) return false
    const operation = {}
    clearReplyError(reply.id)
    replyOperations.value = new Map(replyOperations.value).set(reply.id, operation)
    try {
      await replyToServerRequest(reply.id, {
        result: reply.result,
        error: reply.error,
      })
      if (!isCurrent()) return false
      removePendingServerRequestById(reply.id)
      return true
    } catch (unknownError) {
      if (!isCurrent()) return false
      const message = unknownError instanceof Error ? unknownError.message : 'Failed to reply to server request'
      if (Object.values(pendingServerRequestsByThreadId.value).some(rows => rows.some(request => request.id === reply.id))) {
        replyErrors.value = new Map(replyErrors.value).set(reply.id, message)
      }
      setPageError(message)
      return false
    } finally {
      if (replyOperations.value.get(reply.id) === operation) {
        const next = new Map(replyOperations.value)
        next.delete(reply.id)
        replyOperations.value = next
      }
    }
  }

  function getThreadPendingRequests(threadId: string): readonly Readonly<UiServerRequest>[] {
    if (!threadId) return []
    return Array.isArray(pendingServerRequestsByThreadId.value[threadId])
      ? pendingServerRequestsByThreadId.value[threadId]
      : []
  }

  function isApprovalRequestMethod(method: string): boolean {
    return (
      method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval' ||
      method === 'item/permissions/requestApproval' ||
      method === 'execCommandApproval' ||
      method === 'applyPatchApproval'
    )
  }

  function readPendingRequestState(requests: readonly UiServerRequest[]): UiPendingRequestState | null {
    if (requests.some((request) => isApprovalRequestMethod(request.method))) {
      return 'approval'
    }
    return requests.some(request => !isAsyncUserInputRequest(request)) ? 'response' : null
  }

  function invalidatePendingReads(): void {
    replyOperations.value = new Map()
    replyErrors.value = new Map()
    pendingLifecycleRevision++
    pendingSnapshot = null
    pendingSnapshotRead = null
  }

  function prune(activeThreadIds: Set<string>): void {
    const nextPending: Record<string, UiServerRequest[]> = {}
    for (const [threadId, requests] of Object.entries(pendingServerRequestsByThreadId.value)) {
      if (threadId === GLOBAL_SERVER_REQUEST_SCOPE || activeThreadIds.has(threadId)) {
        nextPending[threadId] = requests
      }
    }
    pendingServerRequestsByThreadId.value = nextPending
    pruneReplyErrors(nextPending)
  }

  return {
    replyIds: computed<ReadonlySet<number>>(() => new Set(replyOperations.value.keys())),
    replyErrors: computed<ReadonlyMap<number, string>>(() => replyErrors.value),
    captureContext: capturePendingReplyContext,
    requestsByThreadId: computed<Readonly<Record<string, readonly Readonly<UiServerRequest>[]>>>(() => pendingServerRequestsByThreadId.value),
    getRequests: getThreadPendingRequests,
    getRequestState: (threadId: string) => readPendingRequestState(getThreadPendingRequests(threadId)),
    getAuthRecovery: (threadId: string): Readonly<AuthRecoveryState> | null => authRecoveryByThreadId.value[threadId] ?? null,
    setAuthRecovery: setAuthRecoveryForThread,
    load: loadPendingServerRequestsFromBridge,
    respond: respondToPendingServerRequest,
    handleNotification: (notification: RpcNotification): boolean => {
      if (active) return handleServerRequestNotification(notification)
      return notification.method === 'server/request' || notification.method === 'server/request/resolved'
    },
    prune,
    start: () => { active = true },
    invalidateForAccountChange: () => {
      invalidatePendingReads()
      pendingServerRequestsByThreadId.value = {}
      authRecoveryByThreadId.value = {}
      onChanged()
      if (active) void loadPendingServerRequestsFromBridge()
    },
    stop: () => {
      active = false
      invalidatePendingReads()
      authRecoveryByThreadId.value = {}
    },
  }
}
