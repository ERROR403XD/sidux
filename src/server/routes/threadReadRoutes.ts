import type { IncomingMessage, ServerResponse } from 'node:http'
import { asRecord, getErrorMessage, setJson, type RouteRequestContext } from '../httpUtils.js'
import { readNonEmptyString } from '../runtimePaths.js'
import type { createThreadReadService } from '../threadReadService.js'
import { THREAD_RESPONSE_TURN_LIMIT } from '../threadResponseService.js'

export function createThreadReadRoutes(service: ReturnType<typeof createThreadReadService>) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL, context: RouteRequestContext): Promise<boolean> => {
    if (req.method === 'GET' && url.pathname === '/codex-api/task-excerpt') {
      const threadId = url.searchParams.get('threadId')?.trim() || ''
      if (!threadId) {
        setJson(res, 400, { error: '缺少任务 ID' })
        return true
      }
      try {
        setJson(res, 200, { data: await service.readTaskExcerpt(threadId) })
      } catch (error) {
        setJson(res, 500, { error: getErrorMessage(error, '任务摘录读取失败。') })
      }
      return true
    }

    if (req.method === 'GET' && url.pathname === '/codex-api/thread-turn-page') {
      try {
        const threadId = url.searchParams.get('threadId')?.trim() ?? ''
        const beforeTurnId = url.searchParams.get('beforeTurnId')?.trim() ?? ''
        const limitRaw = url.searchParams.get('limit')?.trim() ?? String(THREAD_RESPONSE_TURN_LIMIT)
        const limit = Math.max(1, Math.min(50, Number.parseInt(limitRaw, 10) || THREAD_RESPONSE_TURN_LIMIT))
        if (!threadId) {
          setJson(res, 400, { error: 'Missing threadId' })
          return true
        }
        setJson(res, 200, await service.readPage(threadId, {
          beforeTurnId, cursor: url.searchParams.get('cursor') || undefined,
          source: url.searchParams.get('source') || undefined, limit,
        }))
      } catch (error) {
        setJson(res, 500, { error: getErrorMessage(error, 'Failed to load earlier thread messages') })
      }
      return true
    }

    if (req.method === 'GET' && url.pathname === '/codex-api/thread-turn-items') {
      const threadId = url.searchParams.get('threadId')?.trim() ?? ''
      const turnId = url.searchParams.get('turnId')?.trim() ?? ''
      if (!threadId || !turnId) {
        setJson(res, 400, { error: 'Missing threadId or turnId' })
        return true
      }
      setJson(res, 200, { result: await service.readTurn(threadId, turnId) })
      return true
    }

    if (req.method === 'POST' && url.pathname === '/codex-api/thread-fork-at-turn') {
      const params = asRecord(await context.readJsonBody(req))
      const threadId = readNonEmptyString(params?.threadId)
      const lastTurnId = readNonEmptyString(params?.lastTurnId)
      if (!threadId || !lastTurnId) {
        setJson(res, 400, { error: 'Missing threadId or lastTurnId' })
        return true
      }
      setJson(res, 200, { result: await service.forkAtTurn(threadId, lastTurnId) })
      return true
    }

    if (req.method === 'GET' && ['/codex-api/thread-file-change-fallback', '/codex-api/thread-stream-events', '/codex-api/thread-live-state'].includes(url.pathname)) {
      const threadId = url.searchParams.get('threadId')?.trim() ?? ''
      if (!threadId) {
        setJson(res, 400, { error: 'Missing threadId' })
        return true
      }
      if (url.pathname === '/codex-api/thread-file-change-fallback') {
        setJson(res, 200, { data: await service.readFileChangeFallback(threadId) })
      } else if (url.pathname === '/codex-api/thread-stream-events') {
        const limitRaw = url.searchParams.get('limit')?.trim() ?? '80'
        const limit = Math.max(1, Math.min(400, Number.parseInt(limitRaw, 10) || 80))
        setJson(res, 200, { events: service.readStreamEvents(threadId, limit) })
      } else {
        setJson(res, 200, await service.readLiveState(threadId))
      }
      return true
    }

    return false
  }
}
