import type { IncomingMessage, ServerResponse } from 'node:http'
import { asRecord, setJson, type RouteRequestContext } from '../httpUtils.js'
import type { createPreferencesService } from '../preferencesService.js'
export { readMergedThreadTitleCache, writeImportedThreadTitle, type ThreadTitleCache } from '../preferencesService.js'

export function createPreferencesRoutes(
  service: ReturnType<typeof createPreferencesService>,
): (req: IncomingMessage, res: ServerResponse, url: URL, context: RouteRequestContext) => Promise<boolean> {
  return async (req, res, url, context) => {
    if (req.method === 'GET' && url.pathname === '/codex-api/preferences/conversations') {
      setJson(res, 200, { data: await service.readConversationPreferences(url.searchParams.get('threadId') || '') })
      return true
    }

    if (req.method === 'PUT' && url.pathname === '/codex-api/preferences/conversations') {
      const payload = asRecord(await context.readJsonBody(req))
      if (!payload || (!('threads' in payload) && !('defaults' in payload) && !('remember' in payload) && !('migrate' in payload))) {
        setJson(res, 400, { error: 'Missing conversation preferences' })
        return true
      }
      await service.saveConversationPreferences(payload)
      setJson(res, 200, { ok: true })
      return true
    }

    if (req.method === 'GET' && url.pathname === '/codex-api/thread-titles') {
      setJson(res, 200, { data: await service.readTitles() })
      return true
    }

    if (req.method === 'GET' && url.pathname === '/codex-api/thread-pins') {
      const threadIds = await service.readPins()
      setJson(res, 200, { data: { threadIds } })
      return true
    }

    if (req.method === 'GET' && url.pathname === '/codex-api/preferences/first-launch-plugins-card') {
      const dismissed = await service.readFirstLaunchDismissed()
      setJson(res, 200, { data: { dismissed } })
      return true
    }

    if (req.method === 'PUT' && url.pathname === '/codex-api/thread-titles') {
      const payload = asRecord(await context.readJsonBody(req))
      const id = typeof payload?.id === 'string' ? payload.id : ''
      const title = typeof payload?.title === 'string' ? payload.title : ''
      if (!id) {
        setJson(res, 400, { error: 'Missing id' })
        return true
      }
      await service.saveTitle(id, title)
      setJson(res, 200, { ok: true })
      return true
    }

    if (req.method === 'PUT' && url.pathname === '/codex-api/thread-pins') {
      const payload = asRecord(await context.readJsonBody(req))
      await service.savePins(payload?.threadIds)
      setJson(res, 200, { ok: true })
      return true
    }

    if (req.method === 'PUT' && url.pathname === '/codex-api/preferences/first-launch-plugins-card') {
      const payload = asRecord(await context.readJsonBody(req))
      const dismissed = payload?.dismissed === true
      await service.saveFirstLaunchDismissed(dismissed)
      setJson(res, 200, { ok: true })
      return true
    }

    return false
  }
}
