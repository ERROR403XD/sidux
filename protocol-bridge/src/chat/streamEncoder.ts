import type { NormalizedStreamEvent } from '../types.js'

/**
 * One Chat Completions stream chunk (JSON-serializable object, ready for
 * `data: ${JSON.stringify(chunk)}\n\n`).
 */
export type ChatStreamChunk = Record<string, unknown>

/**
 * Encode normalized IR events into Chat Completions stream chunks (reverse
 * direction). Follows the include_usage chunking convention: content deltas
 * carry finish_reason, and usage travels in a trailing choices-less chunk.
 */
export class ChatStreamEncoder {
  private started = false
  private finished = false
  private responseId = ''
  private model = ''
  private created = 0

  constructor(private readonly emit: (chunk: ChatStreamChunk) => void) {}

  get isFinished(): boolean {
    return this.finished
  }

  consume(event: NormalizedStreamEvent): void {
    if (this.finished) return
    switch (event.kind) {
      case 'start': this.start(event.responseId, event.model); return
      case 'textDelta': this.delta({ content: event.text }); return
      case 'reasoningDelta': this.delta({ reasoning_content: event.text }); return
      case 'toolCallStart':
        this.delta({
          tool_calls: [{
            index: event.toolIndex,
            id: event.callId,
            type: 'function',
            function: { name: event.name, arguments: '' },
          }],
        })
        return
      case 'toolCallNameDelta':
        this.delta({ tool_calls: [{ index: event.toolIndex, function: { name: event.nameDelta } }] })
        return
      case 'toolCallArgumentsDelta':
        this.delta({ tool_calls: [{ index: event.toolIndex, function: { arguments: event.argumentsDelta } }] })
        return
      case 'usage': this.emitUsageChunk(event.usage); return
      case 'finish': this.finishChunk(event.reason); return
    }
  }

  private start(responseId: string, model: string): void {
    if (this.started) return
    this.started = true
    this.responseId = responseId
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.emit(this.chunk({ role: 'assistant', content: '' }))
  }

  private delta(delta: Record<string, unknown>): void {
    if (!this.started) this.start('', '')
    this.emit(this.chunk(delta))
  }

  private finishChunk(reason: string): void {
    if (!this.started) this.start('', '')
    this.finished = true
    this.emit({ ...this.chunk({}), choices: [{ index: 0, delta: {}, finish_reason: reason }] })
  }

  private chunk(delta: Record<string, unknown>): ChatStreamChunk {
    return {
      id: this.responseId,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: null }],
    }
  }

  private emitUsageChunk(usage: {
    inputTokens: number | null
    outputTokens: number | null
    totalTokens: number | null
    cachedInputTokens: number | null
    reasoningTokens: number | null
  }): void {
    this.emit({
      id: this.responseId,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [],
      usage: {
        prompt_tokens: usage.inputTokens ?? 0,
        completion_tokens: usage.outputTokens ?? 0,
        total_tokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        ...(usage.cachedInputTokens !== null || usage.reasoningTokens !== null
          ? {
            prompt_tokens_details: { cached_tokens: usage.cachedInputTokens ?? 0 },
            completion_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 },
          }
          : {}),
      },
    })
  }
}
