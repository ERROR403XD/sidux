import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const component = readFileSync(resolve(root, 'components/content/ThreadConversation.vue'), 'utf8')
const script = component.split('<script setup lang="ts">')[1]!.split('</script>')[0]!
const parent = ts.createSourceFile('conversation.ts', script, ts.ScriptTarget.Latest, true)
const ownerText = readFileSync(resolve(root, 'composables/useConversationViewport.ts'), 'utf8')
const owner = ts.createSourceFile('viewport.ts', ownerText, ts.ScriptTarget.Latest, true)

describe('Conversation viewport ownership', () => {
  it('keeps history, render window and scroll mutation outside the parent view', () => {
    const violations: string[] = []
    const owned = /^(?:renderWindowStart|historyLoadSequence|conversationViewportStopped|autoFollowOutput|RENDER_WINDOW_SIZE|LOAD_MORE_\w+)$/
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && owned.test(node.name.getText(parent))) violations.push(node.getText(parent))
      if (ts.isFunctionDeclaration(node) && /^(?:loadMoreAbove|onConversationScroll|scheduleConversationScroll|enforceBottomState|scheduleBottomLock|jumpToLatest)$/.test(node.name?.text || '')) violations.push(node.getText(parent))
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && /scrollTop|(?:isLoadingMore|historyLoadError)\.value/.test(node.left.getText(parent))) violations.push(node.getText(parent))
      ts.forEachChild(node, visit)
    }
    visit(parent)
    expect(violations).toEqual([])
    expect(component).toContain('} = viewport')
    expect(component).toContain('defineExpose({\n  jumpToLatest,\n})')
  })

  it('uses only Vue, message types and the existing scroll mechanism', () => {
    const imports = owner.statements.filter(ts.isImportDeclaration).map(node => ({
      module: (node.moduleSpecifier as ts.StringLiteral).text,
      typeOnly: node.importClause?.isTypeOnly === true,
    }))
    expect(imports).toEqual([
      { module: 'vue', typeOnly: false },
      { module: '../types/codex', typeOnly: true },
      { module: './useConversationScrollState', typeOnly: false },
    ])
    const violations: string[] = []
    function visit(node: ts.Node) {
      if (ts.isIdentifier(node) && /^(?:fetch|setTimeout|setInterval|window|document|useDesktopState|JSON|parseMessageBlocks)$/.test(node.text)) violations.push(node.text)
      ts.forEachChild(node, visit)
    }
    visit(owner)
    expect(violations).toEqual([])
    expect(ownerText).not.toMatch(/props:|\.\.\.options\.getMessages|deep:\s*true[^]*getMessages/)
  })

  it('discovers one production consumer and leaves viewport disposal in its scope', () => {
    const consumers: string[] = []
    function scan(directory: string) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name)
        if (entry.isDirectory()) scan(path)
        else if (/\.(?:ts|vue)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) && entry.name !== 'useConversationViewport.ts') {
          const text = readFileSync(path, 'utf8')
          const content = entry.name.endsWith('.vue') ? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n') : text
          const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true)
          let importsViewport = false
          function visit(node: ts.Node) {
            const module = ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
              ? node.moduleSpecifier
              : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require') ? node.arguments[0] : undefined
            if (module && ts.isStringLiteralLike(module) && /\/useConversationViewport(?:\.[jt]s)?$/.test(module.text)) importsViewport = true
            ts.forEachChild(node, visit)
          }
          visit(source)
          if (importsViewport) consumers.push(path.slice(root.length + 1))
        }
      }
    }
    scan(root)
    expect(consumers).toEqual(['components/content/ThreadConversation.vue'])
    expect(ownerText).toContain('onScopeDispose(stop)')
  })
})
