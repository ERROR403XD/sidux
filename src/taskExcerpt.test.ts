import { describe, expect, it } from 'vitest'
import { extractTaskExcerpt, taskExcerptDraft } from './taskExcerpt'
describe('explicit task excerpts', () => {
  it('keeps recent visible conversation within the cap, excludes tools and commentary, and labels truncation', () => {
    const excerpt = extractTaskExcerpt({ id: 'source', name: 'Source', turns: [
      { items: [{ type: 'userMessage', content: [{ type: 'text', text: 'old'.repeat(4000) }] }] },
      { items: [{ type: 'commandExecution', aggregatedOutput: 'PRIVATE_TOOL_OUTPUT' }, { type: 'agentMessage', phase: 'commentary', text: 'COMMENTARY' }, { type: 'agentMessage', text: 'RECENT_FACT' }] },
    ] }, true)
    expect(excerpt.text.length).toBeLessThanOrEqual(6000)
    expect(excerpt.text).toContain('RECENT_FACT')
    expect(excerpt.text).not.toContain('PRIVATE_TOOL_OUTPUT')
    expect(excerpt.text).not.toContain('COMMENTARY')
    expect(excerpt.truncated).toBe(true)
    expect(taskExcerptDraft(excerpt)).toContain('(codex://threads/source)')
    expect(taskExcerptDraft(excerpt)).toContain('内容已截取')
  })
})
