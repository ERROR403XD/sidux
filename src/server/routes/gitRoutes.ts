import type { IncomingMessage, ServerResponse } from 'node:http'
import { GitWorkspaceError, type createGitWorkspaceService } from '../gitWorkspaceService.js'
import { asRecord, getErrorMessage, setJson, type RouteRequestContext } from '../httpUtils.js'
import { readNonEmptyString } from '../runtimePaths.js'

export function createGitRoutes(service: ReturnType<typeof createGitWorkspaceService>) {
  async function respond(res: ServerResponse, operation: () => Promise<unknown>, fallback: string): Promise<void> {
    try {
      setJson(res, 200, { data: await operation() })
    } catch (error) {
      const status = error instanceof GitWorkspaceError
        ? { 'invalid-input': 400, 'missing-directory': 404, 'path-exists': 409 }[error.code]
        : 500
      setJson(res, status, { error: getErrorMessage(error, fallback) })
    }
  }

  return async (req: IncomingMessage, res: ServerResponse, url: URL, context: RouteRequestContext): Promise<boolean> => {
    if (req.method === 'GET' && url.pathname === '/codex-api/git/branches') {
      const cwd = (url.searchParams.get('cwd') ?? '').trim()
      if (!cwd) {
        setJson(res, 400, { error: 'Missing cwd' })
        return true
      }
      await respond(res, () => service.readBranches(cwd), 'Failed to read Git branches')
      return true
    }

    if (req.method === 'GET' && url.pathname === '/codex-api/git/repository-status') {
      const cwd = (url.searchParams.get('cwd') ?? '').trim()
      if (!cwd) {
        setJson(res, 400, { error: 'Missing cwd' })
        return true
      }
      await respond(res, () => service.readRepositoryStatus(cwd), 'Failed to read Git repository status')
      return true
    }

    if (req.method === 'GET' && url.pathname === '/codex-api/worktree/branches') {
      const sourceCwd = (url.searchParams.get('sourceCwd') ?? '').trim()
      if (!sourceCwd) {
        setJson(res, 400, { error: 'Missing sourceCwd' })
        return true
      }
      await respond(res, () => service.readWorktreeBranches(sourceCwd), 'Failed to list branches')
      return true
    }

    if (req.method === 'POST' && url.pathname === '/codex-api/worktree/create') {
      const payload = asRecord(await context.readJsonBody(req))
      const sourceCwd = readNonEmptyString(payload?.sourceCwd).trim()
      const baseBranch = readNonEmptyString(payload?.baseBranch).trim()
      if (!sourceCwd) {
        setJson(res, 400, { error: 'Missing sourceCwd' })
        return true
      }
      await respond(res, () => service.createWorktree(sourceCwd, baseBranch), 'Failed to create worktree')
      return true
    }

    if (req.method === 'POST' && url.pathname === '/codex-api/worktree/create-permanent') {
      const payload = asRecord(await context.readJsonBody(req))
      const sourceCwd = readNonEmptyString(payload?.sourceCwd).trim()
      const worktreeName = readNonEmptyString(payload?.worktreeName).trim()
      if (!sourceCwd) {
        setJson(res, 400, { error: 'Missing sourceCwd' })
        return true
      }
      if (!worktreeName) {
        setJson(res, 400, { error: 'Missing worktreeName' })
        return true
      }
      await respond(res, () => service.createPermanentWorktree(sourceCwd, worktreeName), 'Failed to create worktree')
      return true
    }

    if (req.method === 'POST' && ['/codex-api/git/checkout', '/codex-api/git/reset-to-commit'].includes(url.pathname)) {
      const record = asRecord(await context.readJsonBody(req))
      if (!record) {
        setJson(res, 400, { error: 'Invalid body: expected object' })
        return true
      }
      const cwd = readNonEmptyString(record.cwd)
      const branch = readNonEmptyString(record.branch)
      if (!cwd) {
        setJson(res, 400, { error: 'Missing cwd' })
        return true
      }
      if (!branch) {
        setJson(res, 400, { error: 'Missing branch' })
        return true
      }
      if (url.pathname === '/codex-api/git/checkout') {
        await respond(res, () => service.checkoutBranch(cwd, branch), 'Failed to switch branch')
        return true
      }
      const sha = readNonEmptyString(record.sha)
      if (!sha) {
        setJson(res, 400, { error: 'Missing commit' })
        return true
      }
      await respond(res, () => service.resetToCommit(cwd, branch, sha), 'Failed to reset branch to commit')
      return true
    }

    if (req.method === 'GET' && url.pathname === '/codex-api/git/branch-commits') {
      const cwd = (url.searchParams.get('cwd') ?? '').trim()
      const branch = (url.searchParams.get('branch') ?? '').trim()
      if (!cwd) {
        setJson(res, 400, { error: 'Missing cwd' })
        return true
      }
      if (!branch) {
        setJson(res, 400, { error: 'Missing branch' })
        return true
      }
      const includeResetHistory = url.searchParams.get('includeResetHistory') !== 'false'
      await respond(res, () => service.readBranchCommits(cwd, branch, includeResetHistory), 'Failed to load branch commits')
      return true
    }

    if (req.method === 'GET' && url.pathname === '/codex-api/git/commit-files') {
      const cwd = (url.searchParams.get('cwd') ?? '').trim()
      const sha = (url.searchParams.get('sha') ?? '').trim()
      if (!cwd) {
        setJson(res, 400, { error: 'Missing cwd' })
        return true
      }
      if (!sha) {
        setJson(res, 400, { error: 'Missing sha' })
        return true
      }
      await respond(res, () => service.readCommitFiles(cwd, sha), 'Failed to load commit files')
      return true
    }

    return false
  }
}
