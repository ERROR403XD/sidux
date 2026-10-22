import type { UiMessage, UiPlanStep } from '../types/codex'

export function parsePlanFromMessageText(text: string): { explanation: string; steps: UiPlanStep[] } | null {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (!normalized) return null

  const steps: UiPlanStep[] = []
  const explanationLines: string[] = []

  for (const line of normalized.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      if (steps.length === 0) explanationLines.push('')
      continue
    }

    const match = trimmed.match(/^[-*]\s+\[([ xX~>|-])\]\s+(.+)$/)
    if (match) {
      const marker = (match[1] ?? ' ').toLowerCase()
      let status: UiPlanStep['status'] = 'pending'
      if (marker === 'x') status = 'completed'
      if (marker === '~' || marker === '>' || marker === '-') status = 'inProgress'
      steps.push({
        step: match[2]?.trim() ?? '',
        status,
      })
      continue
    }

    explanationLines.push(trimmed)
  }

  if (steps.length === 0) return null
  return {
    explanation: explanationLines.join('\n').trim(),
    steps: steps.filter((step) => step.step.length > 0),
  }
}

export function readPlanData(message: UiMessage): { explanation: string; steps: UiPlanStep[] } | null {
  if (message.plan && message.plan.steps.length > 0) {
    return {
      explanation: message.plan.explanation?.trim() ?? '',
      steps: message.plan.steps,
    }
  }
  return parsePlanFromMessageText(message.text)
}

export function isCommandMessage(message: UiMessage): boolean {
  return message.messageType === 'commandExecution' && !!message.commandExecution
}

export function isPlanMessage(message: UiMessage): boolean {
  return message.messageType === 'plan' || message.messageType === 'plan.live'
}

export function isTurnErrorMessage(message: UiMessage): boolean {
  return message.messageType === 'turnError'
}

export function isFileChangeMessage(message: UiMessage): boolean {
  return message.messageType === 'fileChange'
    && message.fileChangeStatus === 'completed'
    && Array.isArray(message.fileChanges)
    && message.fileChanges.length > 0
}

export function isCopyableAssistantMessage(message: UiMessage): boolean {
  return message.role === 'assistant'
    && !isCommandMessage(message)
    && message.messageType !== 'worked'
    && !(message.messageType ?? '').endsWith('.live')
}

export function readPlanExplanation(message: UiMessage): string {
  return readPlanData(message)?.explanation ?? ''
}

export function readPlanSteps(message: UiMessage): UiPlanStep[] {
  return readPlanData(message)?.steps ?? []
}

export function planStepStatusIcon(status: UiPlanStep['status']): string {
  switch (status) {
    case 'completed':
      return '✓'
    case 'inProgress':
      return '•'
    default:
      return '○'
  }
}

export function commandStatusClass(message: UiMessage): string {
  const s = message.commandExecution?.status
  if (s === 'inProgress') return 'cmd-status-running'
  if (s === 'completed' && message.commandExecution?.exitCode === 0) return 'cmd-status-ok'
  return 'cmd-status-error'
}

export function pruneCommandIdSet(source: Set<string>, validIds: Set<string>): Set<string> {
  if (source.size === 0) return source
  const next = new Set<string>()
  for (const id of source) {
    if (validIds.has(id)) next.add(id)
  }
  return next.size === source.size ? source : next
}

export function getCommandsForWorked(messages: UiMessage[], workedIndex: number): UiMessage[] {
  const result: UiMessage[] = []
  for (let i = workedIndex - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.messageType === 'commandExecution') result.unshift(m)
    else if (m.role === 'user' || m.messageType === 'worked') break
  }
  return result
}

export function planStepCopyMarker(status: UiPlanStep['status']): string {
  switch (status) {
    case 'completed':
      return '[x]'
    case 'inProgress':
      return '[~]'
    default:
      return '[ ]'
  }
}

export function buildPlanCopyText(message: UiMessage): string {
  const planData = readPlanData(message)
  if (!planData) return ''

  const sections: string[] = []
  if (planData.explanation?.trim()) {
    sections.push(planData.explanation.trim())
  }

  if (planData.steps.length > 0) {
    sections.push(planData.steps.map((step) => `- ${planStepCopyMarker(step.status)} ${step.step}`.trim()).join('\n'))
  }

  return sections.join('\n\n').trim()
}

export function buildCopyableMessageContent(message: UiMessage): string {
  const sections: string[] = []
  const rawTextContent = message.text.trim() || buildPlanCopyText(message)
  const textContent = isPlanMessage(message) && rawTextContent
    ? `Plan\n${rawTextContent}`
    : rawTextContent
  if (textContent) {
    sections.push(textContent)
  }

  const attachmentLines = (message.fileAttachments ?? [])
    .map((attachment) => attachment.path.trim())
    .filter((pathValue) => pathValue.length > 0)
  if (attachmentLines.length > 0) {
    sections.push(`Files:\n${attachmentLines.join('\n')}`)
  }

  const imageLines = (message.images ?? [])
    .map((imageUrl) => imageUrl.trim())
    .filter((imageUrl) => imageUrl.length > 0)
  if (imageLines.length > 0) {
    sections.push(`Images:\n${imageLines.join('\n')}`)
  }

  return sections.join('\n\n').trim()
}
