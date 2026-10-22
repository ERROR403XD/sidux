import type { IncomingMessage, ServerResponse } from 'node:http'
import { asRecord, setJson, type RouteRequestContext } from '../httpUtils.js'
import type { createProcessActivityService } from '../processActivityService.js'
import { readNonEmptyString } from '../runtimePaths.js'

export function createProcessActivityRoutes(service: ReturnType<typeof createProcessActivityService>) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL, context: RouteRequestContext): Promise<boolean> => {
    if (!url.pathname.startsWith('/codex-api/process-activity/')) return false

    const body = req.method === 'POST' ? asRecord(await context.readJsonBody(req)) : null
    const threadId = readNonEmptyString(body?.threadId) || url.searchParams.get('threadId')?.trim() || ''
    if (!threadId || threadId.length > 200) {
      setJson(res, 400, { error: '缺少有效会话 ID' })
      return true
    }

    if (req.method === 'GET' && url.pathname.endsWith('/hooks')) {
      setJson(res, 200, { data: await service.readHooks(threadId) })
      return true
    }
    if (req.method === 'GET' && url.pathname.endsWith('/hook-detail')) {
      const run = await service.readHookDetail(threadId, url.searchParams.get('runKey'))
      setJson(res, run ? 200 : 404, run ? { data: run } : { error: 'Hook 记录已不在保留范围内' })
      return true
    }
    if (req.method === 'GET' && url.pathname.endsWith('/hook-config')) {
      const cwd = url.searchParams.get('cwd')?.trim() || ''
      if (!cwd) throw new Error('缺少会话目录')
      setJson(res, 200, { data: await service.readHookConfig(cwd) })
      return true
    }
    if (req.method === 'GET' && url.pathname.endsWith('/terminals')) {
      setJson(res, 200, { data: await service.readTerminals(threadId) })
      return true
    }
    if (req.method === 'POST' && url.pathname.endsWith('/terminate')) {
      const processId = readNonEmptyString(body?.processId)
      const itemId = readNonEmptyString(body?.itemId)
      if (!processId || !itemId) throw new Error('缺少进程或命令项 ID')
      setJson(res, 200, { data: await service.terminate(threadId, processId, itemId) })
      return true
    }
    if (req.method === 'GET' && url.pathname.endsWith('/output')) {
      const itemId = url.searchParams.get('itemId')?.trim() || ''
      if (!itemId) throw new Error('缺少命令项 ID')
      setJson(res, 200, { data: await service.readOutput(threadId, itemId) })
      return true
    }

    setJson(res, 404, { error: '未知进程操作' })
    return true
  }
}
