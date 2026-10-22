import { toAutomationApiRecord, type ThreadAutomationRecord } from './automationDefinition.js'
import { createAutomationDefinitionStore } from './automationDefinitionStore.js'
import type { AutomationEngine } from './automationEngine.js'
import { createAutomationSchedule, validateAutomationTimezone } from './automationSchedule.js'

type DefinitionEngine = Pick<AutomationEngine, 'readyPromise' | 'snapshot' | 'timezone' | 'decorate' | 'refresh'>
type DefinitionStore = ReturnType<typeof createAutomationDefinitionStore>

function toAutomationApiMap(automationsByTarget: Record<string, ThreadAutomationRecord[]>) {
  return Object.fromEntries(Object.entries(automationsByTarget).map(([target, automations]) => [target, automations.map(toAutomationApiRecord)]))
}

export function createAutomationDefinitionService(home: string, engine: DefinitionEngine) {
  const store = createAutomationDefinitionStore(home, record => engine.decorate(record))
  const prepareSchedule = async (id: string | undefined, rrule: string, inputTimezone: string | undefined) => {
    await engine.readyPromise
    if (!engine.snapshot().ready) throw new Error(engine.snapshot().error ?? '调度器尚未就绪')
    const timezone = validateAutomationTimezone(inputTimezone ?? engine.snapshot().definitions.find(row => row.id === id)?.timezone ?? engine.timezone)
    createAutomationSchedule(rrule, timezone, Date.now())
    return timezone
  }
  return {
    listThread: async () => toAutomationApiMap(await store.listThreadHeartbeatAutomations()),
    listProject: async () => toAutomationApiMap(await store.listProjectCronAutomations()),
    readThread: async (threadId: string, id: string) => {
      if (!id) return (await store.readThreadHeartbeatAutomations(threadId)).map(toAutomationApiRecord)
      const record = await store.readThreadHeartbeatAutomation(threadId, id)
      return record ? toAutomationApiRecord(record) : null
    },
    readProject: async (projectName: string, id: string) => {
      if (!id) return (await store.readProjectCronAutomations(projectName)).map(toAutomationApiRecord)
      const record = await store.readProjectCronAutomation(projectName, id)
      return record ? toAutomationApiRecord(record) : null
    },
    saveThread: async (input: Parameters<DefinitionStore['writeThreadHeartbeatAutomation']>[0]) => {
      const timezone = await prepareSchedule(input.id, input.rrule, input.timezone)
      const record = await store.writeThreadHeartbeatAutomation({ ...input, timezone })
      await engine.refresh(record.id, timezone)
      return toAutomationApiRecord(engine.decorate(record))
    },
    saveProject: async (input: Parameters<DefinitionStore['writeProjectCronAutomation']>[0]) => {
      const timezone = await prepareSchedule(input.id, input.rrule, input.timezone)
      const record = await store.writeProjectCronAutomation({ ...input, timezone })
      await engine.refresh(record.id, timezone)
      return toAutomationApiRecord(engine.decorate(record))
    },
    deleteThread: async (threadId: string, id: string) => {
      const removed = await store.deleteThreadHeartbeatAutomation(threadId, id)
      await engine.refresh()
      return { removed }
    },
    deleteProject: async (projectName: string, id: string) => {
      const removed = await store.deleteProjectCronAutomation(projectName, id)
      await engine.refresh()
      return { removed }
    },
  }
}
