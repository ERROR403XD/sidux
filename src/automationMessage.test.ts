import { describe, expect, it } from 'vitest'
import { buildAutomationMessage, parseAutomationMessage } from './automationMessage'
import { automationTimeContext } from './server/automationTime'
import { normalizeThreadMessagesV2 } from './api/normalizers/v2'
import type { ThreadReadResponse } from './api/appServerDtos'

const metadata = { runId: '11111111-1111-4111-8111-111111111111', automationId: 'fixture', name: '内部日记整理', scheduledAt: Date.parse('2026-09-06T17:00:00Z'), startedAt: Date.parse('2026-09-06T17:01:00Z'), timezone: 'Asia/Shanghai' }
const context = automationTimeContext({ ...metadata, trigger: 'manual' })

describe('automation message envelope', () => {
  it('retains identity and timestamps across history normalization without exposing the envelope', () => {
    const prompt = '整理样本\n\n保留第二段与 [文档](/tmp/fixture.md:12)。'
    const text = buildAutomationMessage(metadata, context, prompt)
    const payload = { thread: { turns: [{ id: 'turn', status: 'completed', items: [{ id: 'user', type: 'userMessage', content: [{ type: 'text', text }] }] }] } } as ThreadReadResponse
    expect(normalizeThreadMessagesV2(payload)[0]).toMatchObject({ text: prompt, isAutomationRun: true, automationDisplayName: metadata.name, automationRun: metadata })
  })

  it('recognizes the previous run marker while keeping incomplete and ordinary text unchanged', () => {
    expect(parseAutomationMessage(`[CodexApp automation run:${metadata.runId}]\n${context}\n\nlegacy prompt`)).toEqual({ prompt: 'legacy prompt', metadata: undefined })
    expect(parseAutomationMessage(`[CodexApp automation run:${metadata.runId}]\nordinary user text`)).toBeNull()
    expect(parseAutomationMessage(`quote:\n${buildAutomationMessage(metadata, context, 'prompt')}`)).toBeNull()
    expect(parseAutomationMessage(buildAutomationMessage({ ...metadata, scheduledAt: NaN }, context, 'prompt'))).toBeNull()
  })
})
