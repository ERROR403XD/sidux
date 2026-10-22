import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
function script(file: string) {
  const text = readFileSync(resolve(root, file), 'utf8')
  const code = file.endsWith('.vue') ? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n') : text
  return ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true)
}

describe('Conversation message presentation boundaries', () => {
  it('assembles one complete presentation owner and keeps mutable display state outside the parent', () => {
    const parent = script('components/content/ThreadConversation.vue')
    const violations: string[] = []
    let assemblies = 0
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(parent) === 'useConversationMessagePresentation') assemblies++
      if (ts.isVariableDeclaration(node) && /^(expandedCommandIds|collapsedAutoCommandIds|expandedCommandGroupIds|expandedWorkedIds|copyAttempt|copiedMessageResetTimer|copyableResponseContentByAnchorId|forkableTurnIdByAnchorId|editableTurnIdByMessageId)$/.test(node.name.getText(parent))) violations.push(node.getText(parent))
      if (ts.isCallExpression(node) && /^window\.(addEventListener|removeEventListener)$/.test(node.expression.getText(parent))) violations.push(node.getText(parent))
      ts.forEachChild(node, visit)
    }
    visit(parent)
    expect(assemblies).toBe(1)
    expect(violations).toEqual([])
  })

  it('keeps extracted result views free of state, transport, copies of history and lifecycle resources', () => {
    const violations: string[] = []
    for (const file of ['ConversationCommandResults', 'ConversationWorkedResults', 'ConversationRichText']) {
      const source = script(`components/content/${file}.vue`)
      function visit(node: ts.Node) {
        if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && /^(ref|reactive|watch|watchEffect|onMounted|onBeforeUnmount|onScopeDispose|fetch|rpcCall|useConversationRendering|useConversationMessagePresentation|Set|Map)$/.test(node.expression.getText(source))) violations.push(`${file}: ${node.getText(source)}`)
        if (ts.isSpreadElement(node) && /messages|history/.test(node.expression.getText(source))) violations.push(`${file}: ${node.getText(source)}`)
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    expect(violations).toEqual([])
  })

  it('discovers actual production consumers instead of checking only a fixed import spelling', () => {
    const consumers = new Map<string, string[]>([['useConversationMessagePresentation', []], ['conversationMessagePresentation', []]])
    function scan(directory: string) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name)
        if (entry.isDirectory()) scan(path)
        else if (/\.(ts|vue)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
          const source = script(path.slice(root.length + 1))
          const found = new Set<string>()
          function visit(node: ts.Node) {
            const module = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
              : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require') ? node.arguments[0] : undefined
            if (module && ts.isStringLiteralLike(module)) for (const name of consumers.keys()) if (module.text.match(/([^/]+?)(?:\.[jt]s)?$/)?.[1] === name) found.add(name)
            ts.forEachChild(node, visit)
          }
          visit(source)
          for (const name of found) consumers.get(name)!.push(path.slice(root.length + 1))
        }
      }
    }
    scan(root)
    expect(consumers.get('useConversationMessagePresentation')).toEqual(['components/content/ConversationCommandResults.vue', 'components/content/ConversationWorkedResults.vue', 'components/content/ThreadConversation.vue'])
    expect(consumers.get('conversationMessagePresentation')).toEqual(['components/content/ThreadConversation.vue', 'composables/useConversationMessagePresentation.ts'])
  })
})
