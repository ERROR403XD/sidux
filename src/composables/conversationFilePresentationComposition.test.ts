import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { effectScope, reactive, toRaw, type EffectScope } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { useConversationFilePresentation } from './useConversationFilePresentation'
import type { TurnFileChangeSummary } from './conversationFileChangeProjection'

const scopes: EffectScope[] = []
const makeSummary = (): TurnFileChangeSummary => ({
  turnId: 'turn-a', source: 'metadata', sourceMessageIds: ['message'],
  changes: [{ path: 'a.txt', operation: 'update', movedToPath: null, diff: '-a\n+b', addedLineCount: 1, removedLineCount: 1 }],
})

function setup() {
  const props = reactive({ activeThreadId: 'thread-a', cwd: '/fixture/a', accountRevision: 0 })
  const component = readFileSync(new URL('../components/content/ThreadConversation.vue', import.meta.url), 'utf8')
  const script = component.split('<script setup lang="ts">')[1]!.split('</script>')[0]!
  const source = ts.createSourceFile('conversation.ts', script, ts.ScriptTarget.Latest, true)
  const declaration = source.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(row =>
    row.initializer && ts.isCallExpression(row.initializer) && row.initializer.expression.getText(source) === 'useConversationFilePresentation',
  ))
  if (!declaration) throw new Error('Conversation must assemble the file presentation owner')
  const code = ts.transpile(declaration.getText(source) + '\nreturn filePresentation;', { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None })
  const scope = effectScope()
  scopes.push(scope)
  const state = scope.run(() => new Function('props', 'useConversationFilePresentation', code)(props, useConversationFilePresentation)) as ReturnType<typeof useConversationFilePresentation>
  const summary = makeSummary()
  state.toggleFileChangeSummary('message')
  state.openDiffViewer(summary, summary.changes[0]!)
  state.toggleDiffViewerFileList()
  return { props, state, summary, scope }
}

afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))

describe('real Conversation file presentation assembly and lifecycle', () => {
  it('shares the summary and changes rather than copying them', () => {
    const { state, summary } = setup()
    expect(toRaw(state.activeDiffViewerSummary.value)).toBe(summary)
    expect(toRaw(state.diffViewerChanges.value)).toBe(summary.changes)
    expect(state.activeDiffViewerChangeKey.value).toBe('a.txt\u0000')
    expect(state.isDiffViewerFileListOpen.value).toBe(true)
  })

  for (const [property, value] of [['activeThreadId', 'thread-b'], ['cwd', '/fixture/b'], ['accountRevision', 1]] as const) {
    it(`clears old diff and expansion synchronously when ${property} changes`, () => {
      const { props, state } = setup()
      ;(props as Record<string, unknown>)[property] = value
      expect(state.activeDiffViewerSummary.value).toBeNull()
      expect(state.activeDiffViewerChangeKey.value).toBe('')
      expect(state.isDiffViewerFileListOpen.value).toBe(false)
      expect(state.expandedFileChangeSummaryIds.value.size).toBe(0)
    })
  }

  it('does not recover an old viewer or expansion after A to B to A', () => {
    const { props, state } = setup()
    props.activeThreadId = 'thread-b'
    props.activeThreadId = 'thread-a'
    expect(state.activeDiffViewerChange.value).toBeNull()
    expect(state.isFileChangeSummaryExpanded('message')).toBe(false)
  })

  it('preserves expansion for valid messages and prunes only removed summaries', () => {
    const { state } = setup()
    state.toggleFileChangeSummary('other')
    state.pruneFileChangeSummaries(new Set(['message']))
    expect(state.isFileChangeSummaryExpanded('message')).toBe(true)
    expect(state.isFileChangeSummaryExpanded('other')).toBe(false)
    const previous = state.expandedFileChangeSummaryIds.value
    state.pruneFileChangeSummaries(new Set(['message']))
    expect(state.expandedFileChangeSummaryIds.value).toBe(previous)
  })

  it('keeps desktop list state and closes the mobile sheet on selection', () => {
    const { state, summary } = setup()
    state.selectDiffViewerChange(summary.changes[0]!, false)
    expect(state.isDiffViewerFileListOpen.value).toBe(true)
    state.selectDiffViewerChange(summary.changes[0]!, true)
    expect(state.isDiffViewerFileListOpen.value).toBe(false)
  })

  it('uses a valid fallback when the selected file disappears from a reactive summary', () => {
    const { state } = setup()
    const summary = reactive(makeSummary())
    summary.changes.push({ ...summary.changes[0]!, path: 'b.txt' })
    state.openDiffViewer(summary, summary.changes[1]!)
    expect(state.activeDiffViewerChange.value?.path).toBe('b.txt')
    summary.changes.pop()
    expect(state.activeDiffViewerChange.value?.path).toBe('a.txt')
    summary.changes.splice(0)
    expect(state.activeDiffViewerChange.value).toBeNull()
  })

  it('stops once, clears state and ignores future presentation commands', () => {
    const { state, summary, props } = setup()
    state.stop()
    state.stop()
    props.cwd = '/fixture/b'
    state.toggleFileChangeSummary('message')
    state.openDiffViewer(summary, summary.changes[0]!)
    state.toggleDiffViewerFileList()
    state.selectDiffViewerChange(summary.changes[0]!, true)
    expect(state.activeDiffViewerChange.value).toBeNull()
    expect(state.activeDiffViewerChangeKey.value).toBe('')
    expect(state.expandedFileChangeSummaryIds.value.size).toBe(0)
    expect(state.isDiffViewerFileListOpen.value).toBe(false)
  })

  it('disposes the owner with the parent scope', () => {
    const { scope, state, summary } = setup()
    scope.stop()
    state.openDiffViewer(summary, summary.changes[0]!)
    expect(state.activeDiffViewerSummary.value).toBeNull()
    expect(state.expandedFileChangeSummaryIds.value.size).toBe(0)
  })
})
