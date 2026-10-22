import type { IncomingMessage, ServerResponse } from 'node:http'
import { asRecord, setJson, type RouteRequestContext } from '../httpUtils.js'
import { readNonEmptyString } from '../runtimePaths.js'
import type { createThreadStatusService } from '../threadStatusService.js'
import { ThreadResumeConflictError } from '../threadResumeControlService.js'

export function createThreadStatusRoutes(service: ReturnType<typeof createThreadStatusService>) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL, context: RouteRequestContext): Promise<boolean> => {
    if (url.pathname === '/codex-api/thread-quota-resume' && ['GET', 'POST'].includes(req.method || '')) {
      if (req.method === 'POST') {
        const input = asRecord(await context.readJsonBody(req))
        if (typeof input?.threadId !== 'string' || typeof input.enabled !== 'boolean') {
          setJson(res, 400, { error: '续跑标记参数无效' })
          return true
        }
        try {
          setJson(res, 200, { data: await service.setQuotaResume(input.threadId, input.enabled) })
        } catch (cause) {
          if (!(cause instanceof ThreadResumeConflictError)) throw cause
          setJson(res, 409, { error: cause.message })
        }
      } else {
        setJson(res, 200, { data: await service.readQuotaResume() })
      }
      return true
    }

    if (req.method === 'GET' && url.pathname === '/codex-api/thread-interruptions') {
      setJson(res, 200, { data: await service.readInterruptions() })
      return true
    }

    if (url.pathname === '/codex-api/ignored-quota-errors' && ['GET', 'POST'].includes(req.method || '')) {
      const input = req.method === 'POST' ? asRecord(await context.readJsonBody(req)) : null
      const threadId = readNonEmptyString(input?.threadId) || url.searchParams.get('threadId') || ''
      if (!/^[a-zA-Z0-9-]{1,200}$/.test(threadId) || (req.method === 'POST' && (typeof input?.ignored !== 'boolean' || !/^[a-zA-Z0-9-]{1,200}$/.test(readNonEmptyString(input?.turnId))))) {
        setJson(res, 400, { error: '忽略标记参数无效' })
        return true
      }
      const data = req.method === 'POST'
        ? await service.setErrorIgnored(threadId, readNonEmptyString(input?.turnId), input!.ignored as boolean)
        : await service.readIgnoredErrors(threadId)
      setJson(res, 200, { data })
      return true
    }

    if (req.method === 'POST' && url.pathname === '/codex-api/sidebar-thread-status') {
      const payload = asRecord(await context.readJsonBody(req))
      if (!Array.isArray(payload?.threadIds) || payload.threadIds.length > 100 || payload.threadIds.some(id => typeof id !== 'string' || !id || id.length > 200)) {
        setJson(res, 400, { error: '每次最多读取 100 个会话状态' })
        return true
      }
      const rawVersions = asRecord(payload.versions)
      const versions = Object.fromEntries((payload.threadIds as string[]).map(id => [id, readNonEmptyString(rawVersions?.[id]).slice(0, 80)]))
      setJson(res, 200, { data: await service.readSidebarStatus(payload.threadIds as string[], versions) })
      return true
    }

    if (req.method === 'POST' && url.pathname === '/codex-api/thread-goals') {
      const payload = asRecord(await context.readJsonBody(req))
      if (!Array.isArray(payload?.threadIds) || payload.threadIds.length > 100 || payload.threadIds.some(id => typeof id !== 'string' || !id || id.length > 100)) {
        setJson(res, 400, { error: '每次最多读取 100 个会话目标' })
        return true
      }
      const refreshId = typeof payload.refreshId === 'string' && payload.threadIds.includes(payload.refreshId) ? payload.refreshId : ''
      setJson(res, 200, { data: await service.readGoals(payload.threadIds as string[], refreshId) })
      return true
    }

    return false
  }
}
