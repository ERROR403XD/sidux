import type { AppServerProcess } from './appServerProcess.js'
import type { AutomationEngine } from './automationEngine.js'
import type { ThreadTerminalManager } from './terminalManager.js'
import type { ThreadGoalReader } from './threadGoalReader.js'
import { asRecord, extractThreadIdFromNotification } from '../composables/threadNotificationValues.js'

export type BridgeNotification = { method: string; params: unknown; atIso: string }

type NotificationDependencies = {
  runtime: Pick<AppServerProcess, 'onNotification'>
  terminals: Pick<ThreadTerminalManager, 'subscribe'>
  automations: Pick<AutomationEngine, 'subscribe'>
  goals?: Pick<ThreadGoalReader, 'peekStatus'>
}

export function createNotificationService({ runtime, terminals, automations, goals }: NotificationDependencies) {
  function subscribe(listener: (notification: BridgeNotification) => void) {
    const unsubscribeAppServer = runtime.onNotification(notification => {
      if (notification.method === 'turn/completed') {
        const params = asRecord(notification.params)
        const turn = asRecord(params?.turn)
        if (turn?.status === 'completed' && !turn.error) {
          const threadId = extractThreadIdFromNotification({ ...notification, atIso: '' })
          const goalStatus = threadId ? goals?.peekStatus(threadId) : undefined
          if (goalStatus !== undefined) {
            listener({ ...notification, params: { ...params, goalStatus }, atIso: new Date().toISOString() })
            return
          }
        }
      }
      listener({ ...notification, atIso: new Date().toISOString() })
    })
    const unsubscribeTerminal = terminals.subscribe(notification => {
      listener({ ...notification, atIso: new Date().toISOString() })
    })
    const unsubscribeAutomation = automations.subscribe(() => {
      listener({ method: 'automation/changed', params: null, atIso: new Date().toISOString() })
    })
    return () => {
      unsubscribeAutomation()
      unsubscribeAppServer()
      unsubscribeTerminal()
    }
  }
  return { subscribe }
}
