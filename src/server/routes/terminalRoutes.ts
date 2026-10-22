import type { IncomingMessage, ServerResponse } from 'node:http'
import { asRecord, getErrorMessage, setJson, type RouteRequestContext } from '../httpUtils.js'
import type { ThreadTerminalManager } from '../terminalManager.js'

type TerminalRouteDependencies = {
  listQuickCommands: (cwd: string) => Promise<Array<{ label: string; value: string; source: 'package' | 'script' | 'make' }>>
  terminalManager: Pick<ThreadTerminalManager, 'getAvailability' | 'attach' | 'write' | 'resize' | 'close' | 'getSnapshotForThread'>
}

function readNonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : ''
}

function unavailableResponse(res: ServerResponse, reason: string | null): boolean {
  setJson(res, 503, { error: reason || 'Integrated terminal is unavailable on this host' })
  return true
}

export function createTerminalRoutes(
  dependencies: TerminalRouteDependencies,
): (req: IncomingMessage, res: ServerResponse, url: URL, context: RouteRequestContext) => Promise<boolean> {
  const { listQuickCommands, terminalManager } = dependencies

  return async (req, res, url, context) => {
    if (req.method === 'GET' && url.pathname === '/codex-api/thread-terminal/status') {
      setJson(res, 200, terminalManager.getAvailability())
      return true
    }

    if (req.method === 'GET' && url.pathname === '/codex-api/thread-terminal/quick-commands') {
      const cwd = url.searchParams.get('cwd')?.trim() ?? ''
      if (!cwd) {
        setJson(res, 400, { error: 'Missing cwd' })
        return true
      }
      try {
        setJson(res, 200, { commands: await listQuickCommands(cwd) })
      } catch (error) {
        setJson(res, 500, { error: getErrorMessage(error, 'Failed to load terminal quick commands') })
      }
      return true
    }

    if (req.method === 'POST' && url.pathname === '/codex-api/thread-terminal/attach') {
      if (!terminalManager.getAvailability().available) return unavailableResponse(res, terminalManager.getAvailability().reason)
      const body = asRecord(await context.readJsonBody(req))
      const threadId = readNonEmptyString(body?.threadId)
      const cwd = readNonEmptyString(body?.cwd)
      if (!threadId || !cwd) {
        setJson(res, 400, { error: 'Missing threadId or cwd' })
        return true
      }
      setJson(res, 200, {
        session: terminalManager.attach({
          threadId,
          cwd,
          sessionId: readNonEmptyString(body?.sessionId) || undefined,
          cols: typeof body?.cols === 'number' ? body.cols : undefined,
          rows: typeof body?.rows === 'number' ? body.rows : undefined,
          newSession: body?.newSession === true,
        }),
      })
      return true
    }

    if (req.method === 'POST' && ['/codex-api/thread-terminal/input', '/codex-api/thread-terminal/resize', '/codex-api/thread-terminal/close'].includes(url.pathname)) {
      if (!terminalManager.getAvailability().available) return unavailableResponse(res, terminalManager.getAvailability().reason)
      const body = asRecord(await context.readJsonBody(req))
      const sessionId = readNonEmptyString(body?.sessionId)
      if (!sessionId) {
        setJson(res, 400, { error: 'Missing sessionId' })
        return true
      }
      if (url.pathname === '/codex-api/thread-terminal/input') {
        terminalManager.write(sessionId, typeof body?.data === 'string' ? body.data : '')
      } else if (url.pathname === '/codex-api/thread-terminal/resize') {
        terminalManager.resize(sessionId, body?.cols, body?.rows)
      } else {
        terminalManager.close(sessionId)
      }
      setJson(res, 200, { ok: true })
      return true
    }

    if (req.method === 'GET' && url.pathname === '/codex-api/thread-terminal-snapshot') {
      const threadId = url.searchParams.get('threadId')?.trim() ?? ''
      if (!threadId) {
        setJson(res, 400, { error: 'Missing threadId' })
        return true
      }
      setJson(res, 200, { session: terminalManager.getSnapshotForThread(threadId) })
      return true
    }

    return false
  }
}
