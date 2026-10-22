import { isVirtualProjectId } from '../projectOrganization.js'
import type { AppServerProcess } from './appServerProcess.js'
import { createAutomationRuntime } from './automationRuntime.js'
import { createAutomationProjectConversationDirectory } from './projectDirectoryService.js'
import type { ThreadHistory } from './threadHistory.js'

type AutomationExecutionPort = Pick<AppServerProcess,
  'automationRpc' | 'beginTaskPreparation' | 'endTaskPreparation' | 'acquireTaskAccount' |
  'releaseTaskAccount' | 'taskAccountStorageId' | 'listPendingServerRequests'>

export function createAppServerAutomationRuntime(
  appServer: AutomationExecutionPort,
  history: Pick<ThreadHistory, 'page'>,
  hasQueuedMessages: (id: string) => Promise<boolean>,
) {
  return createAutomationRuntime({
    resolveCwd: async (cwd, name) => isVirtualProjectId(cwd) ? (await createAutomationProjectConversationDirectory(name, cwd)).cwd : cwd,
    rpc: (method, params, runId, scope) => appServer.automationRpc(method, params, runId, scope),
    beginPreparation: (runId, scope) => appServer.beginTaskPreparation(runId, scope),
    endPreparation: runId => appServer.endTaskPreparation(runId),
    acquireAccount: (runId, settings, scope) => appServer.acquireTaskAccount(runId, settings, scope),
    releaseAccount: runId => appServer.releaseTaskAccount(runId),
    accountStorageId: runId => appServer.taskAccountStorageId(runId),
    accountBusy: () => false,
    hasQueuedMessages,
    pendingRequests: () => appServer.listPendingServerRequests(),
    readHistory: async threadId => (await history.page(threadId, { limit: 50 })).result,
    buildParams: async (threadId, text) => ({ threadId, input: [{ type: 'text', text }] }),
  })
}
