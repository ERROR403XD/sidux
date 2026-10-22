import { conversationNotificationProjectName, type ConversationNotificationContext } from '../conversationNotificationContext.js'
import { asRecord, readString } from '../composables/threadNotificationValues.js'
import { readMergedThreadTitleCache } from './preferencesService.js'
import { readWorkspaceRootsState } from './workspaceStateService.js'
import type { AppServerProcess } from './appServerProcess.js'

export function createConversationNotificationContextReader(
  runtime: Pick<AppServerProcess, 'rpc' | 'getLastThreadReadSnapshot'>,
  readTitles = readMergedThreadTitleCache,
  readRoots = readWorkspaceRootsState,
) {
  return async (threadId: string): Promise<ConversationNotificationContext> => {
    const cachedTitle = (await readTitles()).titles[threadId] || ''
    let thread = asRecord(asRecord(runtime.getLastThreadReadSnapshot(threadId))?.thread)
    if (!thread || typeof thread.cwd !== 'string' || (!cachedTitle && !readString(thread.title) && !readString(thread.name))) {
      try {
        const response = asRecord(await runtime.rpc('thread/read', { threadId, includeTurns: false }))
        thread = asRecord(response?.thread)
      } catch { /* Retain a known title if the conversation has since been removed. */ }
    }
    const cwd = readString(thread?.cwd)
    const roots = cwd ? await readRoots().catch(() => null) : null
    return {
      title: cachedTitle || readString(thread?.title) || readString(thread?.name) || readString(thread?.preview),
      projectName: conversationNotificationProjectName(cwd, roots),
    }
  }
}
