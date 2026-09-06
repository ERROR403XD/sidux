import type { UiMessage, UiServerRequest } from './types/codex'

export type AsyncQuestion = { title: string; options: string[] }
export type QuestionReplyRef = { itemId: string; turnId: string; questionOrdinal?: number }
export type AsyncQuestionReply = QuestionReplyRef & { threadId: string; answers: string[] }

export function readAsyncQuestions(value: unknown): AsyncQuestion[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(row => {
    if (!row || typeof row !== 'object' || typeof row.title !== 'string' || !row.title.trim()) return []
    return [{
      title: row.title.trim(),
      options: Array.isArray(row.options)
        ? row.options.filter((option: unknown): option is string => typeof option === 'string' && !!option.trim())
        : [],
    }]
  })
}

export function isAsyncUserInputRequest(request: UiServerRequest): boolean {
  return request.method === 'item/tool/requestUserInput'
    && (request.params as { isBlocking?: unknown } | null)?.isBlocking === false
}

export function pendingRequestPriority(request: UiServerRequest): number {
  if (request.method.includes('Approval') || request.method.endsWith('Approval')) return 0
  return isAsyncUserInputRequest(request) ? 2 : 1
}

// Native async questions accept a normal user message. The comment binds that
// message to its source item while keeping the visible answer ordinary prose.
export function buildQuestionReply(message: UiMessage, answers: string[]): string {
  const questions = message.questions ?? []
  if (!message.turnId || !questions.length || answers.length !== questions.length || answers.some(answer => !answer.trim())) {
    throw new Error('请回答每个问题后再发送。')
  }
  const ref: QuestionReplyRef = { itemId: message.id, turnId: message.turnId, questionOrdinal: message.questionOrdinal }
  const marker = encodeURIComponent(JSON.stringify(ref))
  return `<!-- codexapp:question-reply ${marker} -->\n\n${questions.map((question, index) => `${question.title}\n${answers[index].trim()}`).join('\n\n')}`
}

export function readQuestionReply(text: string): { text: string; questionReply?: QuestionReplyRef } {
  const match = /^<!-- codexapp:question-reply ([^\n]{1,4096}) -->\n\n/u.exec(text)
  if (!match) return { text }
  try {
    const ref = JSON.parse(decodeURIComponent(match[1]))
    if (typeof ref.itemId !== 'string' || !ref.itemId || typeof ref.turnId !== 'string' || !ref.turnId) return { text }
    return { text: text.slice(match[0].length), questionReply: { itemId: ref.itemId, turnId: ref.turnId, ...(Number.isInteger(ref.questionOrdinal) && ref.questionOrdinal >= 0 ? { questionOrdinal: ref.questionOrdinal } : {}) } }
  } catch {
    return { text }
  }
}

export function questionRefKey(ref: QuestionReplyRef): string {
  return JSON.stringify([ref.turnId, ref.questionOrdinal ?? ref.itemId])
}
