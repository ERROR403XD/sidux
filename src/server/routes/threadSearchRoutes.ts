import type { IncomingMessage, ServerResponse } from 'node:http'
import { asRecord, setJson, type RouteRequestContext } from '../httpUtils.js'
import type { ThreadSearch } from '../threadSearch.js'

export function createThreadSearchRoutes(search: Pick<ThreadSearch, 'search'>) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL, context: RouteRequestContext): Promise<boolean> => {
    if (req.method !== 'POST' || url.pathname !== '/codex-api/thread-search') return false
    const payload = asRecord(await context.readJsonBody(req))
    const query = typeof payload?.query === 'string' ? payload.query.trim() : ''
    const limitRaw = typeof payload?.limit === 'number' ? payload.limit : 200
    const limit = Math.max(1, Math.min(1000, Math.floor(limitRaw)))
    if (!query) {
      setJson(res, 200, { data: { threadIds: [], indexedThreadCount: 0 } })
      return true
    }

    const controller = new AbortController()
    const cancel = () => {
      if (!res.writableEnded) controller.abort()
    }
    res.on('close', cancel)
    try {
      const data = await search.search(query, limit, controller.signal, payload?.mode === 'body' ? 'body' : 'title')
      if (!controller.signal.aborted) setJson(res, 200, { data })
    } catch (cause) {
      if (!controller.signal.aborted) throw cause
    } finally {
      res.off('close', cancel)
    }
    return true
  }
}
