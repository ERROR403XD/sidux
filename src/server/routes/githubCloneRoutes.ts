import type { IncomingMessage, ServerResponse } from 'node:http'
import { asRecord, setJson, type RouteRequestContext } from '../httpUtils.js'

type GithubCloneRouteDependencies = {
  cloneGithubRepository: (rawUrl: string, rawBasePath: string) => Promise<string>
}

export function createGithubCloneRoutes(
  dependencies: GithubCloneRouteDependencies,
): (req: IncomingMessage, res: ServerResponse, url: URL, context: RouteRequestContext) => Promise<boolean> {
  const { cloneGithubRepository } = dependencies

  return async (req, res, url, context) => {
    if (req.method === 'POST' && url.pathname === '/codex-api/github-clone') {
      const payload = asRecord(await context.readJsonBody(req))
      const repoUrl = typeof payload?.url === 'string' ? payload.url.trim() : ''
      const basePath = typeof payload?.basePath === 'string' ? payload.basePath.trim() : ''
      try {
        const clonedPath = await cloneGithubRepository(repoUrl, basePath)
        setJson(res, 200, { data: { path: clonedPath } })
      } catch (error) {
        setJson(res, 400, {
          error: error instanceof Error ? error.message : 'Failed to clone GitHub repository',
        })
      }
      return true
    }

    return false
  }
}
