import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AutomationHistory } from './automationHistory.js'
import { AutomationStore } from './automationStore.js'

/** Explicit offline maintenance. The same scheduler lease excludes a live owner. */
export async function maintainAutomationHistory(home: string, exportLegacy = false) {
  const directory = join(resolve(home), 'codexapp-automations')
  if (!(await stat(directory)).isDirectory()) throw new Error('找不到自动化数据目录')
  const store = new AutomationStore(directory)
  if (!await store.acquire(Date.now())) throw new Error('目标自动化调度器仍在运行，请先停止对应实例')
  try {
    await store.read()
    return await new AutomationHistory(directory).repairIndexes({ exportLegacy })
  } finally {
    await store.release()
  }
}
