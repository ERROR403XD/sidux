import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const component = readFileSync(resolve(root, 'components/content/ThreadConversation.vue'), 'utf8')
const richText = readFileSync(resolve(root, 'components/content/ConversationRichText.vue'), 'utf8')
const parent = ts.createSourceFile('conversation.ts', component.split('<script setup lang="ts">')[1]!.split('</script>')[0]!, ts.ScriptTarget.Latest, true)
const ownerText = readFileSync(resolve(root, 'composables/useConversationRendering.ts'), 'utf8')
const owner = ts.createSourceFile('rendering.ts', ownerText, ts.ScriptTarget.Latest, true)
const parser = ts.createSourceFile('markdown.ts', readFileSync(resolve(root, 'composables/conversationMarkdown.ts'), 'utf8'), ts.ScriptTarget.Latest, true)

function identifiers(source: ts.SourceFile, pattern: RegExp) {
  const found: string[] = []
  function visit(node: ts.Node) {
    if (ts.isIdentifier(node) && pattern.test(node.text)) found.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe('Conversation Markdown and rendering ownership', () => {
  it('keeps parsing, mutable caches and highlighter loading outside the parent SFC', () => {
    const violations: string[] = []
    const owned = /^(?:parseMessageBlocks|parseTextBlocks|parseInlineSegmentsUncached|splitTextByFileUrls|messageBlockCache|inlineSegmentCache|markdownHtmlCache|highlightHtmlCache|failedMarkdownImages|highlightJsModule|highlightJsLoader|renderingStopped|clearRenderCaches|resetRenderState)$/
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && owned.test(node.name.getText(parent))) violations.push(node.getText(parent))
      if (ts.isFunctionDeclaration(node) && owned.test(node.name?.text || '')) violations.push(node.getText(parent))
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && /highlight\.js/.test(node.getText(parent))) violations.push(node.getText(parent))
      ts.forEachChild(node, visit)
    }
    visit(parent)
    expect(violations).toEqual([])
    expect(component).toContain('} = rendering')
    expect(richText).toContain('block.url, $event')
  })

  it('keeps the parser independent of Vue, browser globals, storage and transport', () => {
    expect(identifiers(parser, /^(?:props|window|document|fetch|watch|onScopeDispose|setTimeout|setInterval|localStorage|useDesktopState)$/)).toEqual([])
    expect(parser.statements.filter(ts.isImportDeclaration).map(node => (node.moduleSpecifier as ts.StringLiteral).text)).toEqual(['./conversationRenderPrimitives', '../pathUtils.js'])
  })

  it('keeps resource disposal, identity invalidation and lazy highlighter loading in one owner', () => {
    expect(identifiers(owner, /^(?:fetch|setTimeout|setInterval|localStorage|document|useDesktopState|rpcCall)$/)).toEqual([])
    expect(ownerText).toContain("import('highlight.js/lib/common')")
    expect(ownerText).toContain('onScopeDispose(stop)')
    expect(ownerText).toContain("{ flush: 'sync' }")
    expect(ownerText).toContain('stopIdentityWatch()')
    expect(ownerText).toContain('stopCodeWatch()')
    expect(ownerText).not.toMatch(/\.\.\.options\.getMessages|deep:\s*true/)
  })

  it('discovers the actual production consumers including reexports and literal dynamic imports', () => {
    const consumers = new Map<string, string[]>([['useConversationRendering', []], ['conversationMarkdown', []]])
    function scan(directory: string) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name)
        if (entry.isDirectory()) scan(path)
        else if (/\.(?:ts|vue)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
          const text = readFileSync(path, 'utf8')
          const content = entry.name.endsWith('.vue') ? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n') : text
          const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true)
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
    expect(consumers.get('useConversationRendering')).toEqual(['components/content/ConversationRichText.vue', 'components/content/ThreadConversation.vue'])
    expect(consumers.get('conversationMarkdown')).toEqual(['components/content/ConversationRichText.vue', 'composables/useConversationRendering.ts'])
  })
})
