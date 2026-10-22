import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { extractTaskExcerpt } from '../taskExcerpt.js'
import type { AppServerProcess } from './appServerProcess.js'
import { asRecord, getErrorMessage } from './httpUtils.js'
import { sanitizeThreadTurnsInlinePayloads } from './inlinePayloadSanitizer.js'
import { readNonEmptyString } from './runtimePaths.js'
import { buildSessionFileChangeFallback, mergeSessionCommandsIntoTurns } from './sessionItemRecovery.js'
import { mergeSessionSkillInputsIntoThreadResult } from './sessionSkillRecovery.js'
import type { ThreadHistory } from './threadHistory.js'
import { isThreadMaterializationPendingError } from './threadReadErrors.js'
import { mergeStreamTurnErrorsIntoThreadResult } from './threadResponseService.js'

type ThreadReadRuntime = Pick<AppServerProcess,
  'rpc' | 'getStreamEvents' | 'storeThreadReadSnapshot' | 'getCachedLiveState' |
  'mergeItemsIntoTurns' | 'cacheLiveState' | 'getLastThreadReadSnapshot'>

type ThreadReadDependencies = {
  runtime: ThreadReadRuntime
  history: Pick<ThreadHistory, 'page' | 'turn' | 'fork'>
  invalidateSearch: () => void
}

export function createThreadReadService({ runtime, history, invalidateSearch }: ThreadReadDependencies) {
  async function readTaskExcerpt(threadId: string) {
    const page = await history.page(threadId, { limit: 10 })
    return extractTaskExcerpt(asRecord(page.result)?.thread, page.hasMoreOlder)
  }

  async function readPage(threadId: string, options: { beforeTurnId: string; cursor?: string; source?: string; limit: number }) {
    const page = await history.page(threadId, options)
    const withErrors = mergeStreamTurnErrorsIntoThreadResult(runtime, page.result)
    const sanitized = await sanitizeThreadTurnsInlinePayloads('thread/read', withErrors)
    const result = await mergeSessionSkillInputsIntoThreadResult(sanitized)
    return { ...page, result, startTurnIndex: 0 }
  }

  async function readTurn(threadId: string, turnId: string) {
    const result = await history.turn(threadId, turnId)
    const sanitized = await sanitizeThreadTurnsInlinePayloads('thread/read', result)
    return mergeSessionSkillInputsIntoThreadResult(sanitized)
  }

  async function forkAtTurn(threadId: string, lastTurnId: string) {
    const result = await history.fork(threadId, lastTurnId)
    invalidateSearch()
    return result
  }

  async function readFileChangeFallback(threadId: string) {
    const threadReadResult = await runtime.rpc('thread/read', { threadId, includeTurns: true })
    const threadReadRecord = asRecord(threadReadResult)
    const threadRecord = asRecord(threadReadRecord?.thread)
    const sessionPath = readNonEmptyString(threadRecord?.path)
    if (!sessionPath || !isAbsolute(sessionPath)) return []
    try {
      const sessionLogRaw = await readFile(sessionPath, 'utf8')
      return buildSessionFileChangeFallback(threadReadResult, sessionLogRaw)
    } catch {
      return []
    }
  }

  async function readLiveState(threadId: string) {
    try {
      const threadReadResult = mergeStreamTurnErrorsIntoThreadResult(runtime, await runtime.rpc('thread/read', {
        threadId,
        includeTurns: true,
      }))
      const sanitized = await sanitizeThreadTurnsInlinePayloads('thread/read', threadReadResult)
      runtime.storeThreadReadSnapshot(threadId, sanitized)

      const record = asRecord(sanitized)
      const thread = asRecord(record?.thread)
      const rawTurns = Array.isArray(thread?.turns) ? thread.turns : []

      const sessionPath = readNonEmptyString(thread?.path)
      let sessionSize = 0
      if (sessionPath && isAbsolute(sessionPath)) {
        try {
          const info = await stat(sessionPath)
          sessionSize = info.size
        } catch { /* missing */ }
      }

      const cached = runtime.getCachedLiveState(threadId, rawTurns.length, sessionSize)
      if (cached) return cached

      let turns = runtime.mergeItemsIntoTurns(threadId, rawTurns)
      if (sessionPath && isAbsolute(sessionPath) && sessionSize > 0) {
        try {
          const sessionLogRaw = await readFile(sessionPath, 'utf8')
          turns = mergeSessionCommandsIntoTurns(turns, sessionLogRaw)
        } catch {
          // Session log not available; continue without command recovery.
        }
      }

      const lastTurn = turns.length > 0 ? asRecord(turns[turns.length - 1]) : null
      const isInProgress = lastTurn?.status === 'inProgress'
      const responseData = {
        threadId,
        conversationState: { turns },
        ownerClientId: null,
        liveStateError: null,
        isInProgress,
      }
      if (!isInProgress) runtime.cacheLiveState(threadId, responseData, rawTurns.length, sessionSize)
      return responseData
    } catch (error) {
      if (isThreadMaterializationPendingError(error)) {
        return {
          threadId,
          conversationState: { turns: [] },
          ownerClientId: null,
          liveStateError: null,
          isInProgress: true,
        }
      }
      const snapshot = runtime.getLastThreadReadSnapshot(threadId)
      if (snapshot) {
        const record = asRecord(snapshot)
        const thread = asRecord(record?.thread)
        const rawTurns = Array.isArray(thread?.turns) ? thread.turns : []
        const turns = runtime.mergeItemsIntoTurns(threadId, rawTurns)
        return {
          threadId,
          conversationState: { turns },
          ownerClientId: null,
          liveStateError: { kind: 'readFailed', message: getErrorMessage(error, 'thread/read failed') },
          isInProgress: false,
        }
      }
      return {
        threadId,
        conversationState: null,
        ownerClientId: null,
        liveStateError: { kind: 'readFailed', message: getErrorMessage(error, 'thread/read failed') },
        isInProgress: false,
      }
    }
  }

  return {
    readTaskExcerpt, readPage, readTurn, forkAtTurn, readFileChangeFallback, readLiveState,
    readStreamEvents: (threadId: string, limit: number) => runtime.getStreamEvents(threadId, limit),
  }
}
