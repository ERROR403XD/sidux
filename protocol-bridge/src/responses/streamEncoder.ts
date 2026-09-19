import { createItemIdFactory } from '../id.js'
import type { NormalizedFinishReason, NormalizedStreamEvent, NormalizedUsage } from '../types.js'

/**
 * Wire shape of one Responses SSE event (the JSON payload behind a
 * `data:` line). Events are plain JSON-serializable objects.
 */
export type ResponsesStreamEvent = Record<string, unknown>

type MessageItemRecord = {
  kind: 'message'
  itemId: string
  outputIndex: number
  text: string
  open: boolean
}

type ReasoningItemRecord = {
  kind: 'reasoning'
  itemId: string
  outputIndex: number
  summaryText: string
  open: boolean
}

type FunctionCallItemRecord = {
  kind: 'function_call'
  itemId: string
  outputIndex: number
  callId: string
  name: string
  arguments: string
  open: boolean
}

type OutputItemRecord = MessageItemRecord | ReasoningItemRecord | FunctionCallItemRecord

/**
 * Encode normalized IR events into the Responses SSE event sequence.
 *
 * This is the streaming state machine (see docs/STREAMING.md). It owns all
 * response-level state: item ordering and indices, item ids, the sequence
 * number, and the final `output` array. One instance serves exactly one
 * request; nothing here is shared between requests.
 *
 * Memory note: the Responses protocol repeats the accumulated text in
 * `output_text.done`, `output_item.done`, and `response.completed`, so this
 * encoder must retain each item's full text. Memory is therefore
 * O(response size) by protocol requirement — but nothing larger.
 */
export class ResponsesStreamEncoder {
  private readonly items: OutputItemRecord[] = []
  private readonly toolRecords = new Map<number, FunctionCallItemRecord>()
  private messageRecord: MessageItemRecord | null = null
  private reasoningRecord: ReasoningItemRecord | null = null
  private responseId: string | null = null
  private model = ''
  private createdAt = 0
  private sequenceNumber = 0
  private started = false
  private terminal = false
  private itemsClosed = false
  private finishReason: NormalizedFinishReason | null = null
  private usage: NormalizedUsage | null = null
  private readonly newMessageId = createItemIdFactory('msg_')
  private readonly newReasoningId = createItemIdFactory('rs_')
  private readonly newCallItemId = createItemIdFactory('fc_')

  constructor(private readonly emit: (event: ResponsesStreamEvent) => void) {}

  get isStarted(): boolean {
    return this.started
  }

  get isTerminal(): boolean {
    return this.terminal
  }

  /** True once items are closed and only the final response event remains. */
  get isPendingCompleted(): boolean {
    return this.itemsClosed && !this.terminal
  }

  /** Consume one IR event; emits zero or more wire events synchronously. */
  consume(event: NormalizedStreamEvent): void {
    if (this.terminal) return
    switch (event.kind) {
      case 'start': this.start(event.responseId, event.model); return
      case 'reasoningDelta': this.reasoning(event.text); return
      case 'textDelta': this.text(event.text); return
      case 'toolCallStart': this.toolCallStart(event.toolIndex, event.callId, event.name); return
      case 'toolCallNameDelta': {
        const record = this.toolRecords.get(event.toolIndex)
        if (record) record.name += event.nameDelta
        return
      }
      case 'toolCallArgumentsDelta': {
        const record = this.toolRecords.get(event.toolIndex)
        if (!record) return
        record.arguments += event.argumentsDelta
        this.emitEvent({
          type: 'response.function_call_arguments.delta',
          item_id: record.itemId,
          output_index: record.outputIndex,
          delta: event.argumentsDelta,
        })
        return
      }
      case 'usage':
        // May arrive after finish (trailing usage chunk); completed is
        // deferred until completeStream() exactly for this case.
        this.usage = event.usage
        return
      case 'finish': this.finish(event.reason); return
    }
  }

  /**
   * Close all open items after a `finish` IR event. Item completion events
   * flow immediately so clients can start executing tool calls; the final
   * `response.completed` waits for completeStream() so trailing usage data
   * is still captured.
   */
  finish(reason: NormalizedFinishReason): void {
    if (this.terminal || this.itemsClosed) return
    if (!this.started) this.start('', '')
    this.finishReason = reason
    for (const record of this.items) this.closeItem(record)
    this.itemsClosed = true
  }

  /**
   * Emit the terminal event. With a finish reason this is
   * `response.completed` (or `incomplete` semantics via status); without
   * one it is `response.failed`.
   */
  completeStream(): void {
    if (this.terminal) return
    if (this.itemsClosed) {
      this.terminal = true
      const reason = this.finishReason ?? 'stop'
      const response: Record<string, unknown> = {
        id: this.responseId,
        object: 'response',
        created_at: this.createdAt,
        status: reason === 'length' || reason === 'content_filter' ? 'incomplete' : 'completed',
        model: this.model,
        output: this.items.map(record => this.completedItem(record)),
        ...(reason === 'length' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
        ...(reason === 'content_filter' ? { incomplete_details: { reason: 'content_filter' } } : {}),
        ...(this.usage ? { usage: encodeUsage(this.usage) } : {}),
      }
      this.emitEvent({ type: 'response.completed', response })
      return
    }
    this.fail({ code: 'stream_interrupted', message: 'upstream stream ended before the response finished' })
  }

  /**
   * Emit a `response.failed` terminal event. Safe to call whether or not
   * the response was started; a failed response still begins with
   * `response.created` so clients see a well-formed stream. If items were
   * already closed with a finish reason, the completed path wins instead.
   */
  fail(error: { code: string; message: string }): void {
    if (this.terminal) return
    if (this.itemsClosed) {
      this.completeStream()
      return
    }
    if (!this.started) this.start('', '')
    this.terminal = true
    const response: Record<string, unknown> = {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      status: 'failed',
      model: this.model,
      output: this.items.map(record => this.completedItem(record)),
      error: { code: error.code, message: error.message },
    }
    this.emitEvent({ type: 'response.failed', response })
  }

  private start(responseId: string, model: string): void {
    if (this.started) return
    this.started = true
    this.responseId = responseId || createItemIdFactory('resp_')()
    this.model = model
    this.createdAt = Math.floor(Date.now() / 1000)
    const response = {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      status: 'in_progress',
      model: this.model,
      output: [] as unknown[],
    }
    this.emitEvent({ type: 'response.created', response })
    this.emitEvent({ type: 'response.in_progress', response })
  }

  private reasoning(text: string): void {
    if (!this.reasoningRecord) {
      const itemId = this.newReasoningId()
      const record: ReasoningItemRecord = {
        kind: 'reasoning',
        itemId,
        outputIndex: this.items.length,
        summaryText: '',
        open: true,
      }
      this.items.push(record)
      this.reasoningRecord = record
      this.emitEvent({
        type: 'response.output_item.added',
        output_index: record.outputIndex,
        item: { type: 'reasoning', id: itemId, summary: [{ type: 'summary_text', text: '' }] },
      })
      this.emitEvent({
        type: 'response.reasoning_summary_part.added',
        item_id: itemId,
        output_index: record.outputIndex,
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      })
    }
    const record = this.reasoningRecord
    record.summaryText += text
    this.emitEvent({
      type: 'response.reasoning_summary_text.delta',
      item_id: record.itemId,
      output_index: record.outputIndex,
      summary_index: 0,
      delta: text,
    })
  }

  private text(text: string): void {
    if (!this.messageRecord) {
      const itemId = this.newMessageId()
      const record: MessageItemRecord = {
        kind: 'message',
        itemId,
        outputIndex: this.items.length,
        text: '',
        open: true,
      }
      this.items.push(record)
      this.messageRecord = record
      this.emitEvent({
        type: 'response.output_item.added',
        output_index: record.outputIndex,
        item: { type: 'message', id: itemId, status: 'in_progress', role: 'assistant', content: [] },
      })
      this.emitEvent({
        type: 'response.content_part.added',
        item_id: itemId,
        output_index: record.outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      })
    }
    const record = this.messageRecord
    record.text += text
    this.emitEvent({
      type: 'response.output_text.delta',
      item_id: record.itemId,
      output_index: record.outputIndex,
      content_index: 0,
      delta: text,
    })
  }

  private toolCallStart(toolIndex: number, callId: string, name: string): void {
    const existing = this.toolRecords.get(toolIndex)
    if (existing) return
    const itemId = this.newCallItemId()
    const record: FunctionCallItemRecord = {
      kind: 'function_call',
      itemId,
      outputIndex: this.items.length,
      callId,
      name,
      arguments: '',
      open: true,
    }
    this.items.push(record)
    this.toolRecords.set(toolIndex, record)
    this.emitEvent({
      type: 'response.output_item.added',
      output_index: record.outputIndex,
      item: { type: 'function_call', id: itemId, status: 'in_progress', call_id: callId, name, arguments: '' },
    })
  }

  private closeItem(record: OutputItemRecord): void {
    if (!record.open) return
    record.open = false
    if (record.kind === 'reasoning') {
      this.emitEvent({
        type: 'response.reasoning_summary_text.done',
        item_id: record.itemId,
        output_index: record.outputIndex,
        summary_index: 0,
        text: record.summaryText,
      })
      this.emitEvent({
        type: 'response.reasoning_summary_part.done',
        item_id: record.itemId,
        output_index: record.outputIndex,
        summary_index: 0,
        part: { type: 'summary_text', text: record.summaryText },
      })
      this.emitEvent({
        type: 'response.output_item.done',
        output_index: record.outputIndex,
        item: { type: 'reasoning', id: record.itemId, summary: [{ type: 'summary_text', text: record.summaryText }] },
      })
      return
    }
    if (record.kind === 'message') {
      this.emitEvent({
        type: 'response.output_text.done',
        item_id: record.itemId,
        output_index: record.outputIndex,
        content_index: 0,
        text: record.text,
      })
      this.emitEvent({
        type: 'response.content_part.done',
        item_id: record.itemId,
        output_index: record.outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: record.text, annotations: [] },
      })
      this.emitEvent({
        type: 'response.output_item.done',
        output_index: record.outputIndex,
        item: {
          type: 'message',
          id: record.itemId,
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: record.text, annotations: [] }],
        },
      })
      return
    }
    this.emitEvent({
      type: 'response.function_call_arguments.done',
      item_id: record.itemId,
      output_index: record.outputIndex,
      arguments: record.arguments,
    })
    this.emitEvent({
      type: 'response.output_item.done',
      output_index: record.outputIndex,
      item: {
        type: 'function_call',
        id: record.itemId,
        status: 'completed',
        call_id: record.callId,
        name: record.name,
        arguments: record.arguments,
      },
    })
  }

  private completedItem(record: OutputItemRecord): Record<string, unknown> {
    if (record.kind === 'reasoning') {
      return { type: 'reasoning', id: record.itemId, summary: [{ type: 'summary_text', text: record.summaryText }] }
    }
    if (record.kind === 'message') {
      return {
        type: 'message',
        id: record.itemId,
        status: this.finishReason === 'length' ? 'incomplete' : 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: record.text, annotations: [] }],
      }
    }
    return {
      type: 'function_call',
      id: record.itemId,
      status: 'completed',
      call_id: record.callId,
      name: record.name,
      arguments: record.arguments,
    }
  }

  private emitEvent(event: ResponsesStreamEvent): void {
    this.emit({ sequence_number: this.sequenceNumber++, ...event })
  }
}

function encodeUsage(usage: NormalizedUsage): Record<string, unknown> {
  return {
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    total_tokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    input_tokens_details: { cached_tokens: usage.cachedInputTokens ?? 0 },
    output_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 },
  }
}
