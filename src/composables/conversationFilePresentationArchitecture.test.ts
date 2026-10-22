import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const script = (text: string) => text.split('<script setup lang="ts">')[1]!.split('</script>')[0]!
const parent = ts.createSourceFile('parent.ts', script(read('../components/content/ThreadConversation.vue')), ts.ScriptTarget.Latest, true)
const boundaries = [
  './useConversationFilePresentation.ts', './conversationFilePresentation.ts', './conversationRenderPrimitives.ts',
  '../components/content/ConversationFileChangeSummary.vue', '../components/content/ConversationDiffViewer.vue',
]

describe('Conversation file presentation ownership', () => {
  it('keeps presentation state and parsing outside the parent', () => {
    const violations: string[] = []
    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && /^(?:build.*DiffLines|buildDiffViewerLines|openDiffViewer|closeDiffViewer|toggleFileChangeSummary|resetFilePresentation|displayFileChangePath|buildFileChangeCopyText)$/.test(node.name?.text || '')) {
        violations.push(node.name!.text)
      }
      if (ts.isVariableDeclaration(node) && /^(?:expandedFileChangeSummaryIds|activeDiffViewerSummary|activeDiffViewerChangeKey|isDiffViewerFileListOpen)$/.test(node.name.getText(parent))) {
        violations.push(node.name.getText(parent))
      }
      ts.forEachChild(node, visit)
    }
    visit(parent)
    expect(violations).toEqual([])
  })

  it('limits all presentation modules to view dependencies', () => {
    for (const path of boundaries) {
      const text = read(path)
      const source = ts.createSourceFile(path, path.endsWith('.vue') ? script(text) : text, ts.ScriptTarget.Latest, true)
      const forbidden: string[] = []
      function visit(node: ts.Node) {
        if (ts.isImportDeclaration(node) && /api\/|Gateway|Desktop|rpc|server\//i.test(node.moduleSpecifier.getText(source))) {
          forbidden.push(node.moduleSpecifier.getText(source))
        }
        if (ts.isCallExpression(node) && /^(?:fetch|setTimeout|setInterval|structuredClone)$/.test(node.expression.getText(source))) {
          forbidden.push(node.expression.getText(source))
        }
        if (ts.isTypeReferenceNode(node) && node.typeName.getText(source) === 'UiMessage') forbidden.push('UiMessage')
        ts.forEachChild(node, visit)
      }
      visit(source)
      expect(forbidden, path).toEqual([])
    }
    const owner = read('./useConversationFilePresentation.ts')
    expect(owner).toContain('onScopeDispose(stop)')
    expect(owner).toContain("{ flush: 'sync' }")
    expect(owner).not.toMatch(/\b(?:window|document)\b/)
  })
})
