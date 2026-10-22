import type { AppServerProcess } from './appServerProcess.js'
import type { DirectoryPluginCache } from './directoryPluginCache.js'
import { asRecord } from './httpUtils.js'
import { sanitizeThreadTurnsInlinePayloads } from './inlinePayloadSanitizer.js'
import { readNonEmptyString } from './runtimePaths.js'
import { mergeSessionSkillInputsIntoThreadResult } from './sessionSkillRecovery.js'
import type { ThreadCompactionGate } from './threadCompactionGate.js'
import type { ThreadHistory } from './threadHistory.js'
import { isEmptyThreadReadError, isThreadMaterializationPendingError, isUnauthenticatedRateLimitError } from './threadReadErrors.js'
import { mergeStreamTurnErrorsIntoThreadResult, THREAD_METHODS_WITH_TURNS, THREAD_METHODS_WITH_THREAD_SNAPSHOT, trimThreadTurnsInRpcResult } from './threadResponseService.js'

type RpcDependencies = {
  runtime: Pick<AppServerProcess, 'getStreamEvents' | 'getLastThreadReadSnapshot' | 'storeThreadReadSnapshot' | 'markManualTurnInterrupt'>
  history: Pick<ThreadHistory, 'initial' | 'assertRollbackAllowed' | 'invalidate'>
  plugins: Pick<DirectoryPluginCache, 'read'>
  compaction: Pick<ThreadCompactionGate, 'start'>
  recoveredRpc: (method: string, params: unknown) => Promise<unknown>
  mergeImportedThreads: (result: unknown, params: unknown) => Promise<unknown>
  hasUsableAuth: () => Promise<boolean>
  invalidateDirectory: () => void
  invalidateSearch: (threadId: string) => void
}

export function createRpcService({ runtime, history, plugins, compaction, recoveredRpc, mergeImportedThreads, hasUsableAuth, invalidateDirectory, invalidateSearch }: RpcDependencies) {
  async function execute(method: string, input: unknown): Promise<unknown> {
    if (method === 'generate-thread-title') return { title: '' }
    if (method === 'account/rateLimits/read' && !(await hasUsableAuth())) return null

    let rpcResult: unknown
    let undoManualInterrupt: (() => void) | undefined
    try {
      const params = asRecord(input) ?? {}
      if (method === 'turn/interrupt') {
        undoManualInterrupt = runtime.markManualTurnInterrupt(readNonEmptyString(params.threadId), readNonEmptyString(params.turnId))
      }
      if (['config/batchWrite', 'config/value/write', 'config/mcpServer/reload', 'plugin/install', 'plugin/uninstall'].includes(method)) invalidateDirectory()
      if (method === 'turn/start' || method === 'turn/steer') throw new Error('发送接口已更新，请刷新页面后重试')
      if (method === 'thread/rollback') await history.assertRollbackAllowed(readNonEmptyString(params.threadId))
      if (method === 'plugin/list') {
        rpcResult = await plugins.read(params)
      } else if (method === 'thread/compact/start') {
        rpcResult = await compaction.start(readNonEmptyString(params.threadId), params.repeatUnknown === true)
      } else if (method === 'thread/resume' || (method === 'thread/read' && params.includeTurns === true)) {
        rpcResult = await history.initial(method, params)
      } else {
        rpcResult = await recoveredRpc(method, input ?? null)
      }
      if (['turn/start', 'turn/steer', 'thread/rollback', 'thread/archive', 'thread/unarchive', 'thread/name/set'].includes(method)) {
        const threadId = readNonEmptyString(params.threadId)
        if (threadId) {
          history.invalidate(threadId)
          invalidateSearch(threadId)
        }
      }
    } catch (error) {
      undoManualInterrupt?.()
      if (method === 'account/rateLimits/read' && isUnauthenticatedRateLimitError(error)) return null
      if (method === 'thread/read' && isEmptyThreadReadError(error)) {
        const params = asRecord(input)
        const threadId = typeof params?.threadId === 'string' ? params.threadId.trim() : ''
        const snapshot = threadId ? runtime.getLastThreadReadSnapshot(threadId) : null
        if (snapshot) return snapshot
      }
      if (method === 'thread/read' && isThreadMaterializationPendingError(error)) {
        const params = asRecord(input)
        const threadId = typeof params?.threadId === 'string' ? params.threadId.trim() : ''
        if (threadId) return { thread: { id: threadId, turns: [], status: { type: 'inProgress' } } }
      }
      throw error
    }
    const trimmedResult = trimThreadTurnsInRpcResult(method, rpcResult)
    const errorMergedResult = THREAD_METHODS_WITH_TURNS.has(method)
      ? mergeStreamTurnErrorsIntoThreadResult(runtime, trimmedResult)
      : trimmedResult
    const listMergedResult = method === 'thread/list'
      ? await mergeImportedThreads(errorMergedResult, input)
      : errorMergedResult
    const sanitizedResult = await sanitizeThreadTurnsInlinePayloads(method, listMergedResult)
    const result = THREAD_METHODS_WITH_TURNS.has(method)
      ? await mergeSessionSkillInputsIntoThreadResult(sanitizedResult)
      : sanitizedResult

    if (THREAD_METHODS_WITH_THREAD_SNAPSHOT.has(method)) {
      const rpcRecord = asRecord(result)
      const rpcThread = asRecord(rpcRecord?.thread)
      const rpcThreadId = typeof rpcThread?.id === 'string' ? rpcThread.id : ''
      if (rpcThreadId) runtime.storeThreadReadSnapshot(rpcThreadId, result)
    }
    return result
  }
  return { execute }
}
