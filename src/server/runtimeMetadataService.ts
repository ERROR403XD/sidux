import { homedir } from 'node:os'
import type { AppServerProcess } from './appServerProcess.js'
import type { MethodCatalog } from './runtimeCapabilities.js'

type RuntimeMetadataDependencies = {
  appVersion: string
  runtime: Pick<AppServerProcess, 'respondToServerRequest' | 'listPendingServerRequests' | 'workerPoolDiagnostics'>
  readAuthRecovery: AppServerProcess['authRecovery']['snapshot']
  catalog: Pick<MethodCatalog, 'snapshot' | 'listMethods' | 'listNotificationMethods'>
}

export function createRuntimeMetadataService({ appVersion, runtime, readAuthRecovery, catalog }: RuntimeMetadataDependencies) {
  return {
    async readCapabilities() {
      return { appVersion, ...(await catalog.snapshot()) }
    },
    readMethods: () => catalog.listMethods(),
    readNotificationMethods: () => catalog.listNotificationMethods(),
    readPendingRequests() {
      return { data: runtime.listPendingServerRequests(), authRecovery: readAuthRecovery() }
    },
    respondToServerRequest: (payload: unknown) => runtime.respondToServerRequest(payload),
    // Keep the existing identity-free counters; do not add account/content data.
    readWorkerPools: () => runtime.workerPoolDiagnostics(),
    readHomeDirectory: () => ({ path: homedir() }),
  }
}
