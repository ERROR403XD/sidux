import type { CustomConnectionDraft } from '../customConnections.js'
import type { BackendQueueProcessor } from './backendQueueRuntime.js'
import type { CustomConnectionStore } from './customConnectionStore.js'
import { getAccountAuthCoordinator } from './accountAuthCoordinator.js'
import { readNonEmptyString } from './runtimePaths.js'

type ConnectionOperations = Pick<CustomConnectionStore, 'ready' | 'test' | 'select' | 'remove' | 'save' | 'active' | 'snapshot'>
type ConnectionAction = 'test' | 'select' | 'remove' | 'create' | 'save'

export function isCustomConnectionBusy(id: string): boolean {
  return getAccountAuthCoordinator().executions.snapshot().some(entry => entry.storageId === id && entry.busy)
}

export function createCustomConnectionService(dependencies: {
  connections: () => ConnectionOperations
  runProviderChange: BackendQueueProcessor['runProviderChange']
  isConnectionBusy: (storageId: string) => boolean
}) {
  return {
    snapshot: async () => {
      const connections = dependencies.connections()
      await connections.ready
      return connections.snapshot()
    },
    hasActive: () => Boolean(dependencies.connections().active()),
    mutate: async (action: ConnectionAction, input: Record<string, unknown>) => {
      const connections = dependencies.connections()
      await connections.ready
      if (action === 'test') return connections.test(input as CustomConnectionDraft)
      const id = readNonEmptyString(input.storageId)
      const change = async () => {
        if (action !== 'select' && id && dependencies.isConnectionBusy(id)) throw new Error('连接正在使用，请等待任务完成')
        if (action === 'select') await connections.select(id || null)
        else if (action === 'remove') await connections.remove(id)
        else await connections.save(input as CustomConnectionDraft, String(input.testToken || ''))
        return connections.snapshot()
      }
      // Saving a new configuration leaves execution identity and auth unchanged.
      if (action === 'create' && !id) return change()
      return dependencies.runProviderChange(change)
    },
    switchToAccount: (switchAccount: () => Promise<boolean>) => dependencies.runProviderChange(async () => {
      const connections = dependencies.connections()
      const previous = connections.active()!.storageId
      await connections.select(null)
      try {
        if (!await switchAccount()) await connections.select(previous)
      } catch (error) {
        await connections.select(previous)
        throw error
      }
    }),
  }
}
