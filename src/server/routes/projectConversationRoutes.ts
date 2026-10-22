import type { IncomingMessage, ServerResponse } from 'node:http'
import { asRecord, setJson, type RouteRequestContext } from '../httpUtils.js'

type ConversationDirectory = Record<string, unknown>

type ProjectConversationRouteDependencies = {
  createProjectConversationDirectory: (prompt: string | null, projectId: string) => Promise<ConversationDirectory>
  createProjectlessThreadDirectory: (prompt: string | null) => Promise<ConversationDirectory>
}

export function createProjectConversationRoutes(
  dependencies: ProjectConversationRouteDependencies,
): (req: IncomingMessage, res: ServerResponse, url: URL, context: RouteRequestContext) => Promise<boolean> {
  const { createProjectConversationDirectory, createProjectlessThreadDirectory } = dependencies

  return async (req, res, url, context) => {
    if (req.method === 'POST' && url.pathname === '/codex-api/projectless-thread-cwd') {
      const payload = asRecord(await context.readJsonBody(req))
      const prompt = typeof payload?.prompt === 'string' ? payload.prompt : null
      try {
        const projectId = typeof payload?.projectId === 'string' ? payload.projectId : ''
        const directory = projectId
          ? await createProjectConversationDirectory(prompt, projectId)
          : await createProjectlessThreadDirectory(prompt)
        setJson(res, 200, { data: directory })
      } catch (error) {
        setJson(res, 500, {
          error: error instanceof Error ? error.message : 'Failed to create new chat folder',
        })
      }
      return true
    }

    return false
  }
}
