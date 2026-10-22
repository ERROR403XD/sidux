import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsoluteLikePath } from '../../pathUtils.js'
import { isVirtualProjectId } from '../../projectOrganization.js'
import type { createAutomationDefinitionService } from '../automationDefinitionService.js'
import { asRecord, setJson, type RouteRequestContext } from '../httpUtils.js'

export function createAutomationDefinitionRoutes(service: ReturnType<typeof createAutomationDefinitionService>) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL, context: RouteRequestContext): Promise<boolean> => {
    if (req.method === 'GET' && url.pathname === '/codex-api/thread-automations') {
      setJson(res, 200, { data: await service.listThread() })
      return true
    }

    if (req.method === 'GET' && url.pathname === '/codex-api/project-automations') {
      setJson(res, 200, { data: await service.listProject() })
      return true
    }

    if (req.method === 'GET' && url.pathname === '/codex-api/thread-automation') {
      const threadId = url.searchParams.get('threadId')?.trim() ?? ''
      const automationId = url.searchParams.get('automationId')?.trim() ?? ''
      if (!threadId) {
        setJson(res, 400, { error: 'Missing threadId' })
        return true
      }
      setJson(res, 200, { data: await service.readThread(threadId, automationId) })
      return true
    }

    if (req.method === 'GET' && url.pathname === '/codex-api/project-automation') {
      const projectName = url.searchParams.get('projectName')?.trim() ?? ''
      const automationId = url.searchParams.get('automationId')?.trim() ?? ''
      if (!projectName) {
        setJson(res, 400, { error: 'Missing projectName' })
        return true
      }
      setJson(res, 200, { data: await service.readProject(projectName, automationId) })
      return true
    }

    if (req.method === 'PUT' && url.pathname === '/codex-api/thread-automation') {
      const payload = asRecord(await context.readJsonBody(req))
      const threadId = typeof payload?.threadId === 'string' ? payload.threadId.trim() : ''
      const id = typeof payload?.id === 'string' ? payload.id.trim() : ''
      const name = typeof payload?.name === 'string' ? payload.name.trim() : ''
      const prompt = typeof payload?.prompt === 'string' ? payload.prompt.trim() : ''
      const rrule = typeof payload?.rrule === 'string' ? payload.rrule.trim() : ''
      const status = payload?.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE'
      if (!threadId || !name || !prompt || !rrule) {
        setJson(res, 400, { error: 'threadId, name, prompt, and rrule are required' })
        return true
      }
      const automation = await service.saveThread({ threadId, id, name, prompt, rrule, status, model: payload?.model, reasoningEffort: payload?.reasoningEffort, serviceTier: payload?.serviceTier, accountStorageId: payload?.accountStorageId, protected: payload?.protected, timezone: typeof payload?.timezone === 'string' ? payload.timezone : undefined })
      setJson(res, 200, { data: automation })
      return true
    }

    if (req.method === 'PUT' && url.pathname === '/codex-api/project-automation') {
      const payload = asRecord(await context.readJsonBody(req))
      const projectName = typeof payload?.projectName === 'string' ? payload.projectName.trim() : ''
      const id = typeof payload?.id === 'string' ? payload.id.trim() : ''
      const name = typeof payload?.name === 'string' ? payload.name.trim() : ''
      const prompt = typeof payload?.prompt === 'string' ? payload.prompt.trim() : ''
      const rrule = typeof payload?.rrule === 'string' ? payload.rrule.trim() : ''
      const status = payload?.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE'
      if (!projectName || !name || !prompt || !rrule) {
        setJson(res, 400, { error: 'projectName, name, prompt, and rrule are required' })
        return true
      }
      if (!isAbsoluteLikePath(projectName) && !isVirtualProjectId(projectName)) {
        setJson(res, 400, { error: 'Project automation cwd must be an absolute path' })
        return true
      }
      const automation = await service.saveProject({ projectName, id, name, prompt, rrule, status, model: payload?.model, reasoningEffort: payload?.reasoningEffort, serviceTier: payload?.serviceTier, accountStorageId: payload?.accountStorageId, protected: payload?.protected, timezone: typeof payload?.timezone === 'string' ? payload.timezone : undefined })
      setJson(res, 200, { data: automation })
      return true
    }

    if (req.method === 'DELETE' && url.pathname === '/codex-api/thread-automation') {
      const threadId = url.searchParams.get('threadId')?.trim() ?? ''
      const automationId = url.searchParams.get('automationId')?.trim() ?? ''
      if (!threadId) {
        setJson(res, 400, { error: 'Missing threadId' })
        return true
      }
      setJson(res, 200, { data: await service.deleteThread(threadId, automationId) })
      return true
    }

    if (req.method === 'DELETE' && url.pathname === '/codex-api/project-automation') {
      const projectName = url.searchParams.get('projectName')?.trim() ?? ''
      const automationId = url.searchParams.get('automationId')?.trim() ?? ''
      if (!projectName) {
        setJson(res, 400, { error: 'Missing projectName' })
        return true
      }
      setJson(res, 200, { data: await service.deleteProject(projectName, automationId) })
      return true
    }

    return false
  }
}
