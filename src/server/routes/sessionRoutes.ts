import type { IncomingMessage, ServerResponse } from 'node:http'
import { asRecord, setJson, type RouteRequestContext } from '../httpUtils.js'

type SessionRouteDependencies<TCompletionReader, TQueueReader> = {
  readNonEmptyString: (value: unknown) => string | null
  completions: TCompletionReader
  queueStateReader: TQueueReader
  acknowledgeProject?: (projectName: string) => Promise<void>
}

type CompletionRoutes = {
  snapshot?: () => Promise<{ data: unknown; kinds: unknown }>
  read: () => Promise<unknown>
  readKinds?: () => Promise<unknown>
  acknowledge: (threadId: string, token: string) => Promise<void>
}

type QueueStateReader = () => Promise<unknown>

export function createSessionRoutes(
  dependencies: SessionRouteDependencies<CompletionRoutes, QueueStateReader>,
): (req: IncomingMessage, res: ServerResponse, url: URL, context: RouteRequestContext) => Promise<boolean> {
  const { completions, queueStateReader, readNonEmptyString, acknowledgeProject } = dependencies

  return async (req, res, url, context) => {
    if (req.method === 'POST' && url.pathname === '/codex-api/thread-completions/project' && acknowledgeProject) {
      const payload = asRecord(await context.readJsonBody(req))
      const projectName = readNonEmptyString(payload?.projectName)
      if (!projectName) {
        setJson(res, 400, { error: '缺少项目名称' })
        return true
      }
      await acknowledgeProject(projectName)
      setJson(res, 200, { ok: true })
      return true
    }
    if (url.pathname === '/codex-api/thread-completions') {
      if (req.method === 'GET') {
        const snapshot = completions.snapshot ? await completions.snapshot()
          : { data: await completions.read(), kinds: await completions.readKinds?.() ?? {} }
        setJson(res, 200, snapshot)
        return true
      }
      if (req.method === 'POST') {
        const payload = asRecord(await context.readJsonBody(req))
        const threadId = readNonEmptyString(payload?.threadId)
        const token = readNonEmptyString(payload?.token)
        if (!threadId || !token) {
          setJson(res, 400, { error: 'Missing threadId or token' })
          return true
        }
        await completions.acknowledge(threadId, token)
        setJson(res, 200, { ok: true })
        return true
      }
    }

    if (req.method === 'GET' && url.pathname === '/codex-api/thread-queue-state') {
      setJson(res, 200, { data: await queueStateReader() })
      return true
    }

    return false
  }
}
