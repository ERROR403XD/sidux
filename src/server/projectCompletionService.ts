import { isThreadNotFoundError } from './threadReadErrors.js'
import { normalizePathForUi, toProjectName } from '../pathUtils.js'
import { filterGroupsByWorkspaceRoots } from '../projectOrganization.js'
import type { ThreadCompletionList } from './threadCompletionList.js'
import { readWorkspaceRootsState } from './workspaceStateService.js'
import type { AppServerProcess } from './appServerProcess.js'
import type { ThreadReadResponse } from '../api/appServerDtos.js'
import type { UiThread } from '../types/codex.js'

export function createProjectCompletionService(
  completions: Pick<ThreadCompletionList, 'read' | 'acknowledgeMany'>,
  runtime: Pick<AppServerProcess, 'rpc'>,
  readRoots = readWorkspaceRootsState,
) {
  return async (projectName: string): Promise<void> => {
    const entries = await completions.read()
    const roots = await readRoots()
    const tokens: Record<string, string> = Object.create(null)
    const ids = Object.keys(entries)
    const markedThreads: UiThread[] = []
    // Only marked conversations need a metadata read. Hidden/paginated rows are included.
    // Resolve every row before writing, so a failed read never reports a partial success.
    for (let offset = 0; offset < ids.length; offset += 4) {
      const rows = await Promise.all(ids.slice(offset, offset + 4).map(async id => {
        let payload: ThreadReadResponse
        try { payload = await runtime.rpc('thread/read', { threadId: id, includeTurns: false }) as ThreadReadResponse }
        catch (cause) {
          if (isThreadNotFoundError(cause)) return null
          throw cause
        }
        const cwd = normalizePathForUi(payload.thread.cwd)
        const thread: UiThread = {
          id, cwd, projectName: toProjectName(cwd), title: '', createdAtIso: '', updatedAtIso: '', preview: '', unread: false, inProgress: false,
          hasWorktree: cwd.includes('/.codex/worktrees/') || cwd.includes('/.git/worktrees/'),
        }
        return thread
      }))
      for (const thread of rows) if (thread) markedThreads.push(thread)
    }
    const groups = filterGroupsByWorkspaceRoots(markedThreads.map(thread => ({ projectName: thread.projectName, threads: [thread] })), roots)
    for (const group of groups) {
      if (group.projectName === projectName) for (const thread of group.threads) tokens[thread.id] = entries[thread.id]!
    }
    // Tokens belong to the click snapshot; newer completions survive the acknowledgement.
    await completions.acknowledgeMany(tokens)
  }
}
