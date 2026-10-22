import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { changesThreadSearch } from '../threadSearchEvents.js'
import { asRecord } from './httpUtils.js'
import { mergeImportedThreadsIntoThreadListResult } from './importedSessionService.js'
import { readMergedThreadTitleCache } from './preferencesService.js'
import { readNonEmptyString } from './runtimePaths.js'
import { SidebarThreadStatusReader } from './sidebarThreadStatusReader.js'
import { callRpcWithArchiveRecovery } from './threadArchiveRecoveryService.js'
import { ThreadHistory } from './threadHistory.js'
import { mergeStreamTurnErrorsIntoThreadResult, type StreamEventReader } from './threadResponseService.js'
import { ThreadSearch, SEARCH_BODY_TURN_LIMIT, extractThreadSearchText } from './threadSearch.js'

type Notification = { method: string; params: unknown }
type ThreadQueryRuntime = StreamEventReader & {
  rpc: (method: string, params: unknown) => Promise<unknown>
  onNotification: (listener: (notification: Notification) => void) => () => void
  ignoredErrors: { has: (threadId: string, turnId: string) => Promise<boolean> }
  interruptions: { record: (threadId: string, turn: { id?: string; status?: string; error?: unknown }) => Promise<void> }
}

export function createThreadQueryService(
  appServer: ThreadQueryRuntime,
  features: () => Promise<{ historyPaging: boolean; resumeInitialPage: boolean; exactFork: boolean }>,
) {
  const history = new ThreadHistory(
    (method, params) => callRpcWithArchiveRecovery(appServer, method, params),
    features,
  )
  const ignoredQuotaErrors = appServer.ignoredErrors
  const sidebarThreadStatus = new SidebarThreadStatusReader(async (method, params) => {
    const result = asRecord(await appServer.rpc(method, params))
    const turns = Array.isArray(result?.data) ? result.data : null
    if (!turns) throw new Error('Invalid final turn metadata')
    const turn = asRecord(turns[0])
    // Only enrich an already terminal failure. A recovered/completed turn must
    // never become a quota interruption because of an earlier retry error.
    if (turn && ['failed', 'interrupted'].includes(String(turn.status)) && !turn.error) {
      const merged = asRecord(mergeStreamTurnErrorsIntoThreadResult(appServer, { thread: { id: params.threadId, turns } }))
      const enriched = asRecord(merged?.thread)?.turns as { id?: string; status?: string; error?: unknown }[]
      if (enriched?.[0]) await appServer.interruptions.record(String(params.threadId), enriched[0])
      return { data: enriched }
    }
    if (turn) await appServer.interruptions.record(String(params.threadId), turn)
    return result
  }, Date.now, 8000, (threadId, turnId) => ignoredQuotaErrors.has(threadId, turnId))
  const unsubscribeHistory = appServer.onNotification(({ method, params }) => {
    const value = asRecord(params)
    const threadId = readNonEmptyString(value?.threadId) || readNonEmptyString(value?.thread_id) || readNonEmptyString(asRecord(value?.thread)?.id)
    if (threadId) {
      if (method === 'thread/quotaErrorIgnored/changed') {
        sidebarThreadStatus.invalidate(threadId)
        return
      }
      history.invalidate(threadId)
      if (['turn/started', 'turn/completed', 'turn/cancelled', 'thread/status/changed'].includes(method)) sidebarThreadStatus.invalidate(threadId)
    }
  })
  const search = new ThreadSearch({
    list: async cursor => {
      const raw = await callRpcWithArchiveRecovery(appServer, 'thread/list', { archived: false, limit: 100, sortKey: 'updated_at', modelProviders: [], cursor })
      const result = asRecord(await mergeImportedThreadsIntoThreadListResult(raw, { cursor }))
      return { data: Array.isArray(result?.data) ? result.data : [], nextCursor: readNonEmptyString(result?.nextCursor) || null }
    },
    body: async thread => {
      const page = await history.page(thread.id, { metadata: { thread }, limit: SEARCH_BODY_TURN_LIMIT })
      return { text: extractThreadSearchText(page.result), truncated: page.hasMoreOlder }
    },
    titles: async () => (await readMergedThreadTitleCache()).titles,
    version: async thread => {
      const path = readNonEmptyString(thread.path)
      if (!path || !isAbsolute(path)) return ''
      const info = await stat(path, { bigint: true }).catch(() => null)
      return info ? `${info.ino}:${info.size}:${info.mtimeNs}` : ''
    },
  })
  const unsubscribeSearch = appServer.onNotification(({ method, params }) => {
    if (!changesThreadSearch(method)) return
    const value = asRecord(params)
    const threadId = readNonEmptyString(value?.threadId) || readNonEmptyString(value?.thread_id) || readNonEmptyString(asRecord(value?.thread)?.id)
    search.invalidate(threadId || undefined)
  })
  let disposed = false
  return {
    history,
    search,
    sidebarThreadStatus,
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribeSearch()
      search.invalidate()
      unsubscribeHistory()
      history.clear()
    },
  }
}
