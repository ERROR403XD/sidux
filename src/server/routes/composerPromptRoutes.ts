import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ComposerPromptRecord } from '../composerPromptService.js'
import { asRecord, getErrorMessage, setJson, type RouteRequestContext } from '../httpUtils.js'

type ComposerPromptRouteDependencies = {
  createPrompt: (name: string, content: string) => Promise<ComposerPromptRecord>
  listPrompts: () => Promise<ComposerPromptRecord[]>
  removePrompt: (promptPath: string) => Promise<boolean>
}

export function createComposerPromptRoutes(
  dependencies: ComposerPromptRouteDependencies,
): (req: IncomingMessage, res: ServerResponse, url: URL, context: RouteRequestContext) => Promise<boolean> {
  const { createPrompt, listPrompts, removePrompt } = dependencies

  return async (req, res, url, context) => {
    if (req.method === 'GET' && url.pathname === '/codex-api/prompts') {
      setJson(res, 200, { data: await listPrompts() })
      return true
    }

    if (req.method === 'POST' && url.pathname === '/codex-api/prompts') {
      const payload = asRecord(await context.readJsonBody(req))
      const name = typeof payload?.name === 'string' ? payload.name.trim() : ''
      const content = typeof payload?.content === 'string' ? payload.content : ''
      if (!name || !content.trim()) {
        setJson(res, 400, { error: 'Prompt name and content are required' })
        return true
      }
      try {
        const prompt = await createPrompt(name, content)
        setJson(res, 200, { data: prompt })
      } catch (error) {
        setJson(res, 500, { error: getErrorMessage(error, 'Failed to create prompt') })
      }
      return true
    }

    if (req.method === 'DELETE' && url.pathname === '/codex-api/prompts') {
      const promptPath = url.searchParams.get('path')?.trim() ?? ''
      if (!promptPath) {
        setJson(res, 400, { error: 'Missing path' })
        return true
      }
      try {
        const removed = await removePrompt(promptPath)
        setJson(res, 200, { data: { removed } })
      } catch (error) {
        setJson(res, 400, { error: getErrorMessage(error, 'Failed to remove prompt') })
      }
      return true
    }

    return false
  }
}
