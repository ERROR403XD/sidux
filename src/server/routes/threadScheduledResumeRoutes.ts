import type { IncomingMessage, ServerResponse } from 'node:http'
import { asRecord, setJson, type RouteRequestContext } from '../httpUtils.js'
import type { ThreadScheduledResume } from '../threadScheduledResume.js'
import type { ScheduledResumeChoice } from '../../threadScheduledResume.js'
import { ThreadResumeConflictError } from '../threadResumeControlService.js'

export function createThreadScheduledResumeRoutes(service: Pick<ThreadScheduledResume, 'set' | 'snapshot'>) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL, context: RouteRequestContext): Promise<boolean> => {
    if (url.pathname !== '/codex-api/thread-scheduled-resume' || !['GET', 'POST'].includes(req.method || '')) return false
    try {
      if (req.method === 'POST') {
        const input = asRecord(await context.readJsonBody(req))
        const choice = asRecord(input?.choice)
        if (typeof input?.threadId !== 'string' || (input.at !== null && typeof input.at !== 'number')
          || (choice && ['model', 'effort', 'tier'].some(key => typeof choice[key] !== 'string' || (choice[key] as string).length > 256))) {
          setJson(res, 400, { error: '定时续跑参数无效' })
          return true
        }
        await service.set(input.threadId, input.at as number | null, choice as ScheduledResumeChoice | undefined)
      }
      setJson(res, 200, { data: await service.snapshot() })
    } catch (cause) {
      setJson(res, cause instanceof ThreadResumeConflictError ? 409 : 400, { error: cause instanceof Error ? cause.message : '定时续跑状态读取或保存失败' })
    }
    return true
  }
}
