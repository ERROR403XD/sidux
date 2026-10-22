import { createApiRequestMetrics } from './apiRequestMetrics.js'
import { createRuntimeNotificationObserver } from './runtimeNotificationService.js'
import { createProjectCompletionService } from './projectCompletionService.js'
import { ThreadScheduledResume } from './threadScheduledResume.js'
import { createThreadScheduledResumeRuntime } from './threadScheduledResumeRuntime.js'
import { createThreadScheduledResumeRoutes } from './routes/threadScheduledResumeRoutes.js'
import { createThreadResumeControlService } from './threadResumeControlService.js'
import { initializeTelegramBridge, rememberTelegramChatId } from './telegramRuntimeService.js'
import { failBridgeRequest } from './httpUtils.js'
import { createPreferencesService } from './preferencesService.js'
import { createConversationNotificationContextReader } from './conversationNotificationContext.js'
import { createConversationCreationService, type ConversationCreationResult } from './conversationCreationService.js'
import type { ConversationNotificationContext } from '../conversationNotificationContext.js'
import { createThreadQueryService } from './threadQueryService.js'
import { callRpcWithArchiveRecovery } from './threadArchiveRecoveryService.js'
export { callRpcWithArchiveRecovery } from './threadArchiveRecoveryService.js'
export { isThreadNotFoundError } from './threadReadErrors.js'
import { createProjectAccessService } from './projectAccessService.js'
import { createLocalDirectoryService } from './localDirectoryService.js'
import { createProjectDiscoveryService } from './projectDiscoveryService.js'
import { listTerminalQuickCommands } from './terminalQuickCommandService.js'
import { createComposerPromptFile, listComposerPrompts, removeComposerPromptFile } from './composerPromptService.js'
import { createProjectArchiveService } from './projectArchiveService.js'
import { mergeImportedThreadsIntoThreadListResult } from './importedSessionService.js'
export { mergeImportedThreadsIntoThreadListResult, registerImportedSessionsInStateDb } from './importedSessionService.js'
import { cloneGithubRepositoryIntoBase, createProjectConversationDirectory, createProjectlessThreadDirectory } from './projectDirectoryService.js'
export { buildProjectlessFolderName } from './projectDirectoryService.js'
import { createProjectRootService } from './projectRootService.js'
import { createWorkspaceService, persistWorkspaceRoot, queueWorkspaceRootsMutation } from './workspaceStateService.js'
export { canonicalizeWorkspaceRootsState, canonicalizeWorkspaceRootsStateForRead, canonicalizeThreadListResponseForRead, writeWorkspaceRootsState, type WorkspaceRootsState } from './workspaceStateService.js'
import { createBrandingRoutes } from './routes/brandingRoutes.js'
import { createMediaRoutes } from './routes/mediaRoutes.js'
import { createProviderProxyService } from './providerProxyService.js'
import { createProviderProxyRoutes } from './routes/providerProxyRoutes.js'
import { createRouteDispatcher, readAnyJsonBody } from './httpUtils.js'
import { getCustomConnectionStore } from './customConnectionStore.js'
import { getWebUiBrandingStore } from './webUiBrandingStore.js'
import { createPreferencesRoutes } from './routes/preferencesRoutes.js'
import { createWorkspaceRoutes } from './routes/workspaceRoutes.js'
import { createSessionRoutes } from './routes/sessionRoutes.js'
import { createProjectRoutes } from './routes/projectRoutes.js'
import { createProjectRootRoutes } from './routes/projectRootRoutes.js'
import { createLocalDirectoryRoutes } from './routes/localDirectoryRoutes.js'
import { createGithubCloneRoutes } from './routes/githubCloneRoutes.js'
import { createProjectConversationRoutes } from './routes/projectConversationRoutes.js'
import { createProjectArchiveRoutes } from './routes/projectArchiveRoutes.js'
import { createProjectDiscoveryRoutes } from './routes/projectDiscoveryRoutes.js'
import { createComposerPromptRoutes } from './routes/composerPromptRoutes.js'
import { createTerminalRoutes } from './routes/terminalRoutes.js'
import { createDeliveryRoutes } from './routes/deliveryRoutes.js'
import { createAutomationRuntimeRoutes } from './routes/automationRuntimeRoutes.js'
import { createAutomationDefinitionRoutes } from './routes/automationDefinitionRoutes.js'
import { createAutomationDefinitionService } from './automationDefinitionService.js'
import { createFreeModeRoutes } from './routes/freeModeRoutes.js'
import { createCustomConnectionRoutes } from './routes/customConnectionRoutes.js'
import { createCustomConnectionService, isCustomConnectionBusy } from './customConnectionService.js'
import { createTelegramRoutes } from './routes/telegramRoutes.js'
import { createGitRoutes } from './routes/gitRoutes.js'
import { createGitWorkspaceService } from './gitWorkspaceService.js'
import { createThreadStatusService } from './threadStatusService.js'
import { createThreadStatusRoutes } from './routes/threadStatusRoutes.js'
import { DirectoryPluginCache } from './directoryPluginCache.js'
import { DirectoryMcpReader } from './directoryMcpReader.js'
import { BackgroundTerminalReader } from './backgroundTerminalReader.js'
import { ProcessActivityStore } from './processActivityStore.js'
import { createProcessActivityService } from './processActivityService.js'
import { createProcessActivityRoutes } from './routes/processActivityRoutes.js'
import { createThreadFileRollbackService } from './threadFileRollbackService.js'
import { createThreadFileRollbackRoutes } from './routes/threadFileRollbackRoutes.js'
import { createThreadReadService } from './threadReadService.js'
import { createThreadReadRoutes } from './routes/threadReadRoutes.js'
import { createThreadSearchRoutes } from './routes/threadSearchRoutes.js'
import { createNotificationService } from './notificationService.js'
import { createNotificationRoutes } from './routes/notificationRoutes.js'
import { createRuntimeMetadataService } from './runtimeMetadataService.js'
import { createRuntimeMetadataRoutes } from './routes/runtimeMetadataRoutes.js'
import { createDirectoryMcpRoutes } from './routes/directoryMcpRoutes.js'
import { createRpcService } from './rpcService.js'
import { createProviderModelService, fetchCustomEndpointDefaultModel, fetchOpenCodeZenModelIds, sortOpenCodeZenModelIds } from './providerModelService.js'
export { normalizeProviderModelsData } from './providerModelService.js'
import { createProviderModelRoutes } from './routes/providerModelRoutes.js'
import { createRpcRoutes, type RpcRouteRequestContext } from './routes/rpcRoutes.js'
import {
  mergeSessionSkillInputsIntoTurns,
  readCachedSessionSkillInputsByTurn,
} from './sessionSkillRecovery.js'
export { sanitizeThreadTurnsInlinePayloads } from './inlinePayloadSanitizer.js'
import { BackendQueueProcessor } from './backendQueueRuntime.js'
export { BackendQueueProcessor } from './backendQueueRuntime.js'
import { AppServerProcess } from './appServerProcess.js'
export { AppServerProcess } from './appServerProcess.js'
import { getCodexHomeDir, readNonEmptyString } from './runtimePaths.js'
import { hasUsableCodexAuth } from './appServerAuth.js'
export { hasUsableCodexAuth } from './appServerAuth.js'
export { ensureDefaultFreeModeStateForMissingAuthSync, refreshChatgptAuthTokensForExternalAuth } from './appServerRuntimeDependencies.js'
import { MethodCatalog } from './runtimeCapabilities.js'
import { version as appVersion } from '../../package.json'
import { ThreadGoalReader } from './threadGoalReader.js'
import { ThreadCompactionGate } from './threadCompactionGate.js'
import { AutomationEngine } from './automationEngine.js'
import { executeAutomationByRequest } from './automationExecute.js'
import type { ThreadQuotaResume } from './threadQuotaResume.js'
import { createThreadQuotaResumeService } from './threadQuotaResumeRuntime.js'
import { createAppServerAutomationRuntime } from './appServerAutomationRuntime.js'
import { createAccountDisconnectionHandler, createRuntimeActivityService } from './runtimeActivityService.js'
export { parseAutomationToml, toAutomationApiRecord } from './automationDefinition.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { handleAccountRoutes } from './accountRoutes.js'
import { handleReviewRoutes } from './reviewGit.js'
import { handleSkillsRoutes } from './skillsRoutes.js'
import { TelegramThreadBridge } from './telegramThreadBridge.js'
import { getRandomFreeKey, getFreeKeyCount, getCachedFreeModels, getFreeModels, refreshFreeModelsInBackground, filterOpenCodeZenModelsForAuthState, shouldMarkOpenRouterKeyAsCustom } from './freeMode.js'
import { ThreadTerminalManager } from './terminalManager.js'

export { mergeSessionSkillInputsIntoTurns, readCachedSessionSkillInputsByTurn }

export { isEmptyThreadReadError, isThreadMaterializationPendingError, isUnauthenticatedRateLimitError } from './threadReadErrors.js'

export { failBridgeRequest } from './httpUtils.js'

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return readAnyJsonBody(req)
}

type CodexBridgeMiddleware = ((req: IncomingMessage, res: ServerResponse, next: () => void) => Promise<void>) & {
  dispose: () => Promise<void>
  subscribeNotifications: (listener: (value: { method: string; params: unknown; atIso: string }) => void) => () => void
  readConversationNotificationContext: (threadId: string) => Promise<ConversationNotificationContext>
  createConversation: (input: unknown, assertActive: () => void) => Promise<ConversationCreationResult>
}

type SharedBridgeState = {
  unsubscribeQuota: () => void
  quotaResume: ThreadQuotaResume
  scheduledResume: ThreadScheduledResume
  resumeControls: ReturnType<typeof createThreadResumeControlService>
  disposed: boolean
  owners: number
  disposal: Promise<void> | null
  version: string
  appServer: AppServerProcess
  terminalManager: ThreadTerminalManager
  methodCatalog: MethodCatalog
  telegramBridge: TelegramThreadBridge
  backendQueueProcessor: BackendQueueProcessor
  automationEngine: AutomationEngine
  threadGoalReader: ThreadGoalReader
  threadCompactionGate: ThreadCompactionGate
  processActivity: ProcessActivityStore
}

const SHARED_BRIDGE_KEY = '__codexRemoteSharedBridge__'
const SHARED_BRIDGE_VERSION = 'shared-runtime-022-resume-exclusion-v1'

function disposeSharedBridgeState(state: SharedBridgeState): Promise<void> {
  if (state.disposal) return state.disposal
    state.disposed = true
  state.disposal = (async () => {
    state.unsubscribeQuota?.()
    const automationDisposal = state.automationEngine.dispose()
    state.telegramBridge.stop()
    state.terminalManager.dispose()
    const deliveryDisposal = state.backendQueueProcessor.dispose()
    state.appServer.stopTaskRouting?.()
    state.appServer.dispose()
    await Promise.all([automationDisposal, deliveryDisposal, state.telegramBridge.settleNotifications(), state.processActivity.flush(), state.quotaResume?.close(), state.scheduledResume?.close()])
  })()
  return state.disposal
}

function getSharedBridgeState(): SharedBridgeState {
  const globalScope = globalThis as typeof globalThis & {
    [SHARED_BRIDGE_KEY]?: SharedBridgeState
  }

  const existing = globalScope[SHARED_BRIDGE_KEY]
  if (existing && !existing.disposed && existing.version === SHARED_BRIDGE_VERSION && existing.terminalManager) {
    return existing
  }
  const previousRuntimeStopped = existing ? disposeSharedBridgeState(existing) : undefined

  const appServer = new AppServerProcess()
  const processActivity = existing?.processActivity ?? new ProcessActivityStore(join(getCodexHomeDir(), 'codexapp-hook-observations.json'))
  const terminalManager = new ThreadTerminalManager()
  const methodCatalog = new MethodCatalog()
  const runtimeActivity = createRuntimeActivityService({
    methods: async () => (await methodCatalog.snapshot()).methods,
    rpc: (method, params) => appServer.rpc(method, params),
    isIdentityChanging: () => backendQueueProcessor.isIdentityChanging(),
    readQueueState: () => backendQueueProcessor.readState(),
  })
  appServer.backgroundActivity = runtimeActivity.backgroundActivity
  const backendQueueProcessor = new BackendQueueProcessor(appServer, { features: async () => (await methodCatalog.snapshot()).features, previousRuntimeStopped })
  const { quotaResume, unsubscribeQuota } = createThreadQuotaResumeService(getCodexHomeDir(), appServer, backendQueueProcessor, undefined, true, previousRuntimeStopped)
  const scheduledResume = new ThreadScheduledResume(getCodexHomeDir(), createThreadScheduledResumeRuntime(appServer, backendQueueProcessor), Date.now, true, previousRuntimeStopped)
  const resumeControls = createThreadResumeControlService(quotaResume, scheduledResume)
  appServer.quotaBlocked = (threadId, turnId) => quotaResume.blocked(threadId, turnId)
  const threadGoalReader = new ThreadGoalReader((method, params) => appServer.rpc(method, params))
  const threadCompactionGate = new ThreadCompactionGate((method, params) => appServer.rpc(method, params),
    runtimeActivity.compactionBlocked)
  const automationEngine = new AutomationEngine(getCodexHomeDir(), createAppServerAutomationRuntime(
    appServer, backendQueueProcessor.history, runtimeActivity.hasQueuedMessages,
  ), Date.now, true, previousRuntimeStopped)
  appServer.automationActivity = () => automationEngine.activity()
  appServer.accountDisconnected = createAccountDisconnectionHandler({
    cancelAutomations: (storageId, primary, runIds) => automationEngine.cancelAccount(storageId, primary, runIds),
    cancelAccountDeliveries: () => backendQueueProcessor.cancelAccountDeliveries(),
  })
  appServer.onNotification(createRuntimeNotificationObserver({
    completions: appServer.completions,
    interruptions: appServer.interruptions,
    quotaResume,
    scheduledResume,
    observeAccountQuota: params => appServer.observeAccountQuota(params),
    automationEngine,
    threadGoalReader,
    threadCompactionGate,
    processActivity,
  }))
  const created: SharedBridgeState = {
    resumeControls,
    scheduledResume,
    unsubscribeQuota,
    quotaResume,
    disposed: false,
    owners: 0,
    disposal: null,
    automationEngine,
    threadGoalReader,
    threadCompactionGate,
    processActivity,
    version: SHARED_BRIDGE_VERSION,
    appServer,
    terminalManager,
    methodCatalog,
    backendQueueProcessor,
    telegramBridge: new TelegramThreadBridge(appServer, {
      notificationDirectory: join(getCodexHomeDir(), 'telegram-notifications'),
      onChatSeen: (chatId) => {
        void rememberTelegramChatId(chatId).catch(() => {})
      },
    }),
  }
  globalScope[SHARED_BRIDGE_KEY] = created
  return created
}

export function createCodexBridgeMiddleware(): CodexBridgeMiddleware {
  const sharedState = getSharedBridgeState()
  sharedState.owners++
  const { appServer, terminalManager, methodCatalog, telegramBridge, backendQueueProcessor, automationEngine, threadGoalReader, threadCompactionGate } = sharedState
  const directoryPlugins = new DirectoryPluginCache(join(getCodexHomeDir(), 'cache', 'plugin-catalog'), params => appServer.rpc('plugin/list', params))
  const directoryMcps = new DirectoryMcpReader((method, params) => appServer.rpc(method, params))
  const backgroundTerminals = new BackgroundTerminalReader((method, params) => appServer.rpc(method, params), () => backendQueueProcessor.isIdentityChanging())
  const threadQueries = createThreadQueryService(appServer, async () => (await methodCatalog.snapshot()).features)
  const { history, search, sidebarThreadStatus } = threadQueries
  const ignoredQuotaErrors = appServer.ignoredErrors
  const routeContext = {
    readJsonBody,
  }
  const accountRouteContext = { appServer, readJsonBody }
  const skillsRouteContext = { appServer, readJsonBody }
  const preferencesRoutes = createPreferencesRoutes(createPreferencesService({
    invalidateThreadSearch: (threadId?: string) => search.invalidate(threadId),
    mutateGlobalState: queueWorkspaceRootsMutation,
  }))
  const workspaceRoutes = createWorkspaceRoutes(createWorkspaceService())
  const sessionRoutes = createSessionRoutes({
    completions: appServer.completions,
    acknowledgeProject: createProjectCompletionService(appServer.completions, appServer),
    queueStateReader: () => backendQueueProcessor.readState(),
    readNonEmptyString,
  })
  const projectRoutes = createProjectRoutes(createProjectAccessService())
  const projectRootRoutes = createProjectRootRoutes(createProjectRootService())
  const localDirectoryRoutes = createLocalDirectoryRoutes(createLocalDirectoryService())
  const githubCloneRoutes = createGithubCloneRoutes({
    cloneGithubRepository: cloneGithubRepositoryIntoBase,
  })
  const projectConversationRoutes = createProjectConversationRoutes({
    createProjectConversationDirectory,
    createProjectlessThreadDirectory,
  })
  const projectArchiveRoutes = createProjectArchiveRoutes(createProjectArchiveService(() => search.invalidate()))
  const projectDiscoveryRoutes = createProjectDiscoveryRoutes(createProjectDiscoveryService())
  const composerPromptRoutes = createComposerPromptRoutes({
    createPrompt: createComposerPromptFile,
    listPrompts: listComposerPrompts,
    removePrompt: removeComposerPromptFile,
  })
  const terminalRoutes = createTerminalRoutes({
    listQuickCommands: listTerminalQuickCommands,
    terminalManager,
  })
  const deliveryRoutes = createDeliveryRoutes({ backendQueueProcessor })
  const automationRuntimeRoutes = createAutomationRuntimeRoutes({
    appServer,
    scheduledResume: sharedState.scheduledResume,
    automationEngine,
    executeAutomation: payload => executeAutomationByRequest(automationEngine, payload),
  })
  const freeModeRoutes = createFreeModeRoutes({
    appServer,
    backendQueueProcessor,
    getRandomFreeKey,
    getFreeKeyCount,
    getFreeModels,
    getCachedFreeModels,
    refreshFreeModelsInBackground,
    fetchOpenCodeZenModelIds,
    sortOpenCodeZenModelIds,
    filterOpenCodeZenModelsForAuthState,
    fetchCustomEndpointDefaultModel,
    shouldMarkOpenRouterKeyAsCustom,
  })
  const telegramRoutes = createTelegramRoutes({ telegramBridge })
  const automationDefinitionRoutes = createAutomationDefinitionRoutes(createAutomationDefinitionService(getCodexHomeDir(), automationEngine))
  const gitRoutes = createGitRoutes(createGitWorkspaceService({ getCodexHomeDir, persistWorkspaceRoot }))
  const threadStatusRoutes = createThreadStatusRoutes(createThreadStatusService({
    quotaResume: sharedState.resumeControls.quotaResume,
    interruptions: appServer.interruptions,
    ignoredErrors: ignoredQuotaErrors,
    sidebarStatus: sidebarThreadStatus,
    goals: threadGoalReader,
    notifyErrorIgnored: threadId => appServer.notifyQuotaErrorIgnored(threadId),
  }))
  const processActivityRoutes = createProcessActivityRoutes(createProcessActivityService({
    observations: sharedState.processActivity,
    backgroundTerminals,
    history,
    rpc: (method, params) => appServer.rpc(method, params),
  }))
  const threadReadRoutes = createThreadReadRoutes(createThreadReadService({
    runtime: appServer,
    history,
    invalidateSearch: () => search.invalidate(),
  }))
  const threadFileRollbackRoutes = createThreadFileRollbackRoutes(createThreadFileRollbackService({
    history,
    rpc: (method, params) => appServer.rpc(method, params),
  }))
  const customConnectionRoutes = createCustomConnectionRoutes(createCustomConnectionService({
    connections: getCustomConnectionStore,
    runProviderChange: change => backendQueueProcessor.runProviderChange(change),
    isConnectionBusy: isCustomConnectionBusy,
  }), async (request, response, url) => {
    await handleAccountRoutes(request, response, url, accountRouteContext)
    return response.statusCode < 400
  })
  const notifications = createNotificationService({ runtime: appServer, terminals: terminalManager, automations: automationEngine, goals: threadGoalReader })
  const rpcRoutes = createRpcRoutes(createRpcService({
    runtime: appServer, history, plugins: directoryPlugins, compaction: threadCompactionGate,
    recoveredRpc: (method, params) => callRpcWithArchiveRecovery(appServer, method, params),
    mergeImportedThreads: mergeImportedThreadsIntoThreadListResult,
    hasUsableAuth: hasUsableCodexAuth,
    invalidateDirectory: () => directoryMcps.invalidate(),
    invalidateSearch: threadId => search.invalidate(threadId),
  }))
  const brandingRoutes = createBrandingRoutes(getWebUiBrandingStore)
  const providerProxyRoutes = createProviderProxyRoutes(createProviderProxyService(getCustomConnectionStore))
  const dispatchRoute = createRouteDispatcher<RpcRouteRequestContext>([
    createProviderModelRoutes(createProviderModelService(appServer, getCustomConnectionStore)),
    customConnectionRoutes,
    rpcRoutes,
    (request, response, url) => handleAccountRoutes(request, response, url, accountRouteContext),
    (request, response, url) => handleSkillsRoutes(request, response, url, skillsRouteContext),
    handleReviewRoutes,
    preferencesRoutes,
    workspaceRoutes,
    sessionRoutes,
    projectRoutes,
    projectRootRoutes,
    localDirectoryRoutes,
    githubCloneRoutes,
    projectConversationRoutes,
    projectArchiveRoutes,
    projectDiscoveryRoutes,
    composerPromptRoutes,
    terminalRoutes,
    deliveryRoutes,
    automationRuntimeRoutes,
    automationDefinitionRoutes,
    freeModeRoutes,
    telegramRoutes,
    gitRoutes,
    threadStatusRoutes,
    processActivityRoutes,
    threadReadRoutes,
    threadFileRollbackRoutes,
    createThreadSearchRoutes(search),
    createNotificationRoutes(notifications),
    createThreadScheduledResumeRoutes(sharedState.resumeControls.scheduledResume),
    createDirectoryMcpRoutes(directoryMcps),
    createRuntimeMetadataRoutes(createRuntimeMetadataService({
      appVersion, runtime: appServer, catalog: methodCatalog,
      readAuthRecovery: () => appServer.authRecovery.snapshot(),
    })),
    createMediaRoutes(),
  ])
  void initializeTelegramBridge(telegramBridge).catch(() => {})

  const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const metrics = createApiRequestMetrics(req, res)

    try {
      if (!req.url) {
        next()
        return
      }

      const url = new URL(req.url, 'http://localhost')
      if (await brandingRoutes(req, res, url, routeContext)) return
      await getCustomConnectionStore().ready
      if (await providerProxyRoutes(req, res, url)) return

      if (await dispatchRoute(req, res, url, {
        ...routeContext,
        recordRpcRequest: metrics.recordRpcRequest,
      })) return

      next()
    } catch (error) {
      failBridgeRequest(res, error)
    }
  }

  let middlewareDisposal: Promise<void> | null = null
  middleware.dispose = () => {
    if (middlewareDisposal) return middlewareDisposal
    directoryPlugins.dispose()
    threadQueries.dispose()
    sharedState.owners--
    middlewareDisposal = sharedState.owners === 0 ? disposeSharedBridgeState(sharedState) : Promise.resolve()
    return middlewareDisposal
  }
  middleware.subscribeNotifications = notifications.subscribe
  middleware.readConversationNotificationContext = createConversationNotificationContextReader(appServer)
  middleware.createConversation = createConversationCreationService({
    rpc: (method, params) => appServer.rpc(method, params),
    deliveryContext: () => backendQueueProcessor.deliveryContext(),
    submit: input => backendQueueProcessor.submit(input),
    isIdentityChanging: () => backendQueueProcessor.isIdentityChanging(),
  })

  return middleware
}
