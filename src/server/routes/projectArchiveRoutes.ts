import type { IncomingMessage, ServerResponse } from 'node:http'
import { getErrorMessage, readRawBody, setJson, type RouteRequestContext } from '../httpUtils.js'
import { setProjectZipHeaders } from '../projectArchiveCodec.js'
import type { createProjectArchiveService } from '../projectArchiveService.js'

export function createProjectArchiveRoutes(
  service: ReturnType<typeof createProjectArchiveService>,
  io = { readRawBody, setProjectZipHeaders },
) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL, _context: RouteRequestContext): Promise<boolean> => {
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/codex-api/project-zip') {
      const plan = await service.prepareExport((url.searchParams.get('cwd') ?? '').trim(), req.method === 'HEAD')
      if ('error' in plan) {
        setJson(res, plan.status, { error: plan.error })
        return true
      }
      if (plan.kind === 'virtual') {
        io.setProjectZipHeaders(res, service.readExportFileName(plan))
        if (req.method !== 'HEAD') await service.writeExport(plan, res)
        res.end()
        return true
      }
      try {
        io.setProjectZipHeaders(res, service.readExportFileName(plan))
        if (req.method === 'HEAD') {
          res.end()
          return true
        }
        await service.writeExport(plan, res)
        res.end()
      } catch (error) {
        if (!res.headersSent) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to export project') })
        } else {
          res.destroy(error instanceof Error ? error : new Error('Failed to export project'))
        }
      }
      return true
    }
    if (req.method === 'POST' && url.pathname === '/codex-api/project-import') {
      const destination = await service.prepareImport((url.searchParams.get('parent') ?? '').trim())
      if ('error' in destination) {
        setJson(res, destination.status, { error: destination.error })
        return true
      }
      try {
        const buffer = await io.readRawBody(req)
        if (buffer.length === 0) {
          setJson(res, 400, { error: 'Missing project ZIP' })
          return true
        }
        const result = await service.importProject(buffer, destination.parent)
        setJson(res, 200, { data: { path: result.projectPath, importedSessions: result.importedSessions } })
      } catch (error) {
        setJson(res, 400, { error: getErrorMessage(error, 'Failed to import project') })
      }
      return true
    }
    return false
  }
}
