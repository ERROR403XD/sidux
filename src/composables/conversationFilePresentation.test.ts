import { describe, expect, it } from 'vitest'
import type { UiFileChange } from '../types/codex'
import type { TurnFileChangeSummary } from './conversationFileChangeProjection'
import { buildDiffViewerLines, buildFileChangeCopyText, displayFileChangePath, fileChangeKey, fileChangeOperationLabel, fileChangeSummaryLabel, fileChangeSummaryStatusParts, inferDiffViewerLanguage } from './conversationFilePresentation'
import { escapeHtml } from './conversationRenderPrimitives'

const change = (fields: Partial<UiFileChange> = {}): UiFileChange => ({ path: 'a.txt', operation: 'update', movedToPath: null, diff: '', addedLineCount: 0, removedLineCount: 0, ...fields })
const summary = (changes: UiFileChange[]): TurnFileChangeSummary => ({ turnId: 'turn', source: 'metadata', sourceMessageIds: [], changes })

describe('Conversation file summary, paths and diff presentation', () => {
  it('keeps unified diff numbering, headers, multiple hunks and markup as literal text', () => {
    const input = change({ diff: '--- a/a.txt\r\n+++ b/a.txt\r\n@@ -3,2 +8,2 @@\r\n same\r\n-old <tag>\r\n+new & value\r\n@@ -20 +30 @@\r\n-last\r\n+next\r\n\\ No newline at end of file\r\n' })
    const lines = buildDiffViewerLines(input)
    expect(lines.map(row => [row.kind, row.oldLine, row.newLine, row.text])).toEqual([
      ['meta', null, null, '--- a/a.txt'], ['meta', null, null, '+++ b/a.txt'],
      ['hunk', null, null, '@@ -3,2 +8,2 @@'], ['context', 3, 8, 'same'],
      ['remove', 4, null, 'old <tag>'], ['add', null, 9, 'new & value'],
      ['hunk', null, null, '@@ -20 +30 @@'], ['remove', 20, null, 'last'], ['add', null, 30, 'next'],
      ['meta', null, null, '\\ No newline at end of file'],
    ])
    expect(new Set(lines.map(row => row.key)).size).toBe(lines.length)
    expect(escapeHtml('<tag> & "quoted" \'value\'')).toBe('&lt;tag&gt; &amp; &quot;quoted&quot; &#39;value&#39;')
    expect(input.diff).toContain('\r\n')
  })

  it('shows added and deleted content with correct line columns and no phantom final line', () => {
    for (const operation of ['add', 'delete'] as const) {
      const rows = buildDiffViewerLines(change({ operation, diff: 'first\r\n\r\nlast\r\n' }))
      expect(rows.map(row => row.text)).toEqual(['first', '', 'last'])
      expect(rows.map(row => [row.oldLine, row.newLine])).toEqual(operation === 'add' ? [[null, 1], [null, 2], [null, 3]] : [[1, null], [2, null], [3, null]])
    }
    expect(buildDiffViewerLines(change())).toEqual([])
    expect(buildDiffViewerLines(null)).toEqual([])
  })

  it('preserves move labels, file identity and language inferred from the destination', () => {
    const moved = change({ movedToPath: 'new.py', diff: '*** Move to: new.py' })
    expect(fileChangeOperationLabel(moved)).toBe('Moved')
    expect(fileChangeOperationLabel({ ...moved, addedLineCount: 1 })).toBe('Moved + edited')
    expect(fileChangeKey(moved)).not.toBe(fileChangeKey(change()))
    expect(inferDiffViewerLanguage(moved)).toBe('python')
    expect(buildDiffViewerLines(moved)[0]?.kind).toBe('meta')
  })

  it('keeps file paths consistent for display and copied summaries on Unix and Windows', () => {
    expect(displayFileChangePath('file:///fixture/project/src/../a.txt', '/fixture/project')).toBe('a.txt')
    expect(displayFileChangePath('C:\\work\\project\\src\\..\\a.txt', 'C:\\work\\project')).toBe('a.txt')
    expect(displayFileChangePath('../other/a.txt', '/fixture/project')).toBe('../other/a.txt')
    expect(displayFileChangePath('~/a.txt', '/home/user/project')).toBe('~/a.txt')
    const source = summary([change({ path: '/fixture/project/a.txt', movedToPath: './b.txt', addedLineCount: 2, removedLineCount: 1 })])
    expect(buildFileChangeCopyText(source, '/fixture/project')).toBe('Modified files:\n- Moved + edited: a.txt -> b.txt (+2 -1)')
    expect(source.changes[0]?.path).toBe('/fixture/project/a.txt')
  })

  it('preserves summary counts and neutral fallback without mutating inputs', () => {
    const source = summary([change({ operation: 'add', addedLineCount: 3 }), change({ operation: 'delete', removedLineCount: 2 }), change({ movedToPath: 'b.txt' })])
    expect(fileChangeSummaryLabel(source)).toBe('3 files changed · 1 added, 1 deleted, 1 moved')
    expect(fileChangeSummaryStatusParts(source)).toEqual([{ tone: 'add', label: '+3' }, { tone: 'remove', label: '-2' }])
    expect(fileChangeSummaryStatusParts(summary([change({ movedToPath: 'b.txt' })]))).toEqual([{ tone: 'neutral', label: 'Moved' }])
    expect(fileChangeSummaryStatusParts(summary([change()]))).toEqual([{ tone: 'neutral', label: 'Ready' }])
    expect(buildFileChangeCopyText(null, '/fixture')).toBe('')
  })
})
