import type { ThreadQueueState } from '../threadQueue.js'
import { threadsWithBackgroundTerminals } from './backgroundTerminalReader.js'

type RuntimeActivityDependencies = {
  methods: () => Promise<readonly string[]>
  rpc: (method: string, params: unknown) => Promise<unknown>
  isIdentityChanging: () => boolean
  readQueueState: () => Promise<ThreadQueueState>
}

export function createRuntimeActivityService(dependencies: RuntimeActivityDependencies) {
  const { methods, rpc, isIdentityChanging, readQueueState } = dependencies
  const hasQueuedMessages = async (id: string) => Boolean((await readQueueState())[id]?.length)
  return {
    hasQueuedMessages,
    async compactionBlocked(threadId: string): Promise<boolean> {
      return isIdentityChanging() || hasQueuedMessages(threadId)
    },
    async backgroundActivity(): Promise<string[]> {
      const available = await methods()
      if (!available.includes('thread/backgroundTerminals/list')) return []
      if (!available.includes('thread/loaded/list')) throw new Error('无法完整核对后台终端，暂不能切换账号')
      return threadsWithBackgroundTerminals(rpc)
    },
  }
}

export function createAccountDisconnectionHandler(dependencies: {
  cancelAutomations: (storageId: string, primary: boolean, runIds: string[]) => Promise<void>
  cancelAccountDeliveries: () => Promise<void>
}) {
  return (storageId: string, primary: boolean, runIds: string[]) => {
    void dependencies.cancelAutomations(storageId, primary, runIds).catch(() => undefined)
    if (primary) void dependencies.cancelAccountDeliveries().catch(() => undefined)
  }
}
