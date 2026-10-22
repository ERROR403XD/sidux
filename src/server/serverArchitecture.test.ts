import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const serverRoot = new URL('.', import.meta.url)
const bridgePath = new URL('codexAppServerBridge.ts', serverRoot)
const bridge = ts.createSourceFile('bridge.ts', readFileSync(bridgePath, 'utf8'), ts.ScriptTarget.Latest, true)

function productionSources(directory: URL): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory)
    if (entry.isDirectory()) return entry.name === 'fixtures' ? [] : productionSources(child)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts') ? [fileURLToPath(child)] : []
  })
}

describe('server composition and business dependency direction', () => {
  it('keeps protocol paths, filesystem persistence and child processes out of the composition root', () => {
    const imports = bridge.statements.filter(ts.isImportDeclaration).map(node => (node.moduleSpecifier as ts.StringLiteral).text)
    expect(imports.filter(name => /^node:(?:fs|child_process)(?:\/|$)/.test(name))).toEqual([])
    const businessOperations: string[] = []
    const forbidden = new Set(['readFile', 'writeFile', 'mkdir', 'stat', 'spawn', 'execFile', 'setJson'])
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'pathname') businessOperations.push(node.getText(bridge))
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && forbidden.has(node.expression.text)) businessOperations.push(node.getText(bridge))
      ts.forEachChild(node, visit)
    }
    visit(bridge)
    expect(businessOperations).toEqual([])
  })

  it('prevents business modules from importing runtime values from the compatibility root', () => {
    const violations: string[] = []
    for (const file of productionSources(serverRoot)) {
      if (file === fileURLToPath(bridgePath) || file === fileURLToPath(new URL('httpServer.ts', serverRoot))) continue
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
      const visit = (node: ts.Node) => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const typeOnly = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly : node.isTypeOnly
          const allNamedTypes = ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
            && !node.importClause.name && node.importClause.namedBindings.elements.every(element => element.isTypeOnly)
          if (!typeOnly && !allNamedTypes && /(?:^|\/)codexAppServerBridge(?:\.js)?$/.test(node.moduleSpecifier.text)) violations.push(file)
        }
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && /codexAppServerBridge/.test(node.arguments[0].text)) violations.push(file)
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    expect(violations.map(file => join('src/server', file.slice(fileURLToPath(serverRoot).length)))).toEqual([])
  })
})
