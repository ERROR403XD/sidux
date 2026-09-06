export type AutomationMessageMetadata = {
  runId: string
  automationId: string
  name: string
  scheduledAt: number
  startedAt: number
  timezone: string
}

export function buildAutomationMessage(metadata: AutomationMessageMetadata, context: string, prompt: string): string {
  return `[CodexApp automation run:${metadata.runId}]\n[CodexApp automation metadata:${JSON.stringify(metadata)}]\n${context}\n\n${prompt}`
}

export function parseAutomationMessage(text: string): { prompt: string; metadata?: AutomationMessageMetadata } | null {
  const prefix = /^\[CodexApp automation run:([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})\]\n/u.exec(text)
  if (!prefix) return null
  let rest = text.slice(prefix[0].length)
  let metadata: AutomationMessageMetadata | undefined
  const metadataLine = /^\[CodexApp automation metadata:(.+)\]\n/u.exec(rest)
  if (metadataLine) {
    try {
      const value = JSON.parse(metadataLine[1]!)
      if (value.runId !== prefix[1] || typeof value.automationId !== 'string' || typeof value.name !== 'string'
        || !Number.isFinite(value.scheduledAt) || !Number.isFinite(value.startedAt) || typeof value.timezone !== 'string') return null
      metadata = value
      rest = rest.slice(metadataLine[0].length)
    } catch {
      return null
    }
  }
  // Also retain messages produced before the structured metadata was added.
  const context = /^(?:手动请求时间|本次重试请求时间|计划触发时间)：[^\n]+\n实际开始时间：[^\n]+\n以上时间已换算到任务时区[^\n]*\n\n/u.exec(rest)
  if (!context) return null
  return { prompt: rest.slice(context[0].length), metadata }
}
