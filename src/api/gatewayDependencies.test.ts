import { readdirSync, readFileSync } from 'node:fs'
import { dirname, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

type Dependency = { from: string; to: string | null; specifier: string; typeOnly: boolean }
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const facade = 'src/api/codexGateway.ts'

function readProductionSources(root: string): Map<string, string> {
  const sources = new Map<string, string>()
  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !['fixtures', '__tests__'].includes(entry.name)) {
        walk(resolve(directory, entry.name))
      } else if (entry.isFile() && /\.(ts|tsx|js|cjs|mjs|vue)$/.test(entry.name)
        && !/\.(test|spec)\.|\.d\.ts$/.test(entry.name)) {
        const file = resolve(directory, entry.name)
        const relative = `src/${file.slice(root.length + 1).replaceAll('\\', '/')}`
        sources.set(relative, readFileSync(file, 'utf8'))
      }
    }
  }
  walk(root)
  return sources
}

function parseScript(file: string, source: string): ts.SourceFile {
  let script = source
  if (file.endsWith('.vue')) {
    // Preserve source offsets while excluding template and style syntax.
    const chars = source.replace(/[^\r\n]/g, ' ').split('')
    for (const match of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
      const start = match.index! + match[0].indexOf('>') + 1
      for (let index = 0; index < match[1].length; index += 1) {
        chars[start + index] = match[1][index]
      }
    }
    script = chars.join('')
  }
  return ts.createSourceFile(file, script, ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}

function dependencies(sources: Map<string, string>): Dependency[] {
  const edges: Dependency[] = []
  function resolveLocal(from: string, specifier: string): string | null {
    const stem = specifier.startsWith('@/')
      ? `src/${specifier.slice(2)}`
      : specifier.startsWith('.')
        ? posix.normalize(posix.join(posix.dirname(from), specifier))
        : null
    if (!stem) return null
    const candidates = [stem, stem.replace(/\.js$/, '.ts'), stem.replace(/\.js$/, '.tsx'),
      ...['.ts', '.tsx', '.js', '.cjs', '.mjs', '.vue', '/index.ts', '/index.js'].map(suffix => stem + suffix)]
    return candidates.find(candidate => sources.has(candidate)) ?? null
  }
  for (const [file, text] of sources) {
    const ast = parseScript(file, text)
    function add(specifier: string, typeOnly: boolean) {
      edges.push({ from: file, to: resolveLocal(file, specifier), specifier, typeOnly })
    }
    function visit(node: ts.Node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        let typeOnly = ts.isExportDeclaration(node) && node.isTypeOnly
        if (ts.isImportDeclaration(node)) {
          const clause = node.importClause
          const bindings = clause?.namedBindings
          typeOnly = Boolean(clause?.isTypeOnly || (clause && !clause.name && bindings
            && ts.isNamedImports(bindings) && bindings.elements.length > 0
            && bindings.elements.every(item => item.isTypeOnly)))
        } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          typeOnly ||= node.exportClause.elements.length > 0
            && node.exportClause.elements.every(item => item.isTypeOnly)
        }
        add(node.moduleSpecifier.text, typeOnly)
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
        && ts.isStringLiteral(node.argument.literal)) {
        add(node.argument.literal.text, true)
      } else if (ts.isCallExpression(node) && node.arguments.length
        && ts.isStringLiteral(node.arguments[0])
        && (node.expression.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        add(node.arguments[0].text, false)
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
  return edges
}

function runtimeCycles(sources: Map<string, string>, edges: Dependency[]): string[][] {
  const adjacency = new Map([...sources.keys()].map(file => [file, new Set<string>()]))
  for (const edge of edges) {
    if (edge.to && !edge.typeOnly) adjacency.get(edge.from)!.add(edge.to)
  }
  const indices = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const cycles: string[][] = []
  let next = 0
  function visit(file: string) {
    indices.set(file, next)
    low.set(file, next)
    next += 1
    stack.push(file)
    onStack.add(file)
    for (const target of adjacency.get(file)!) {
      if (!indices.has(target)) {
        visit(target)
        low.set(file, Math.min(low.get(file)!, low.get(target)!))
      } else if (onStack.has(target)) {
        low.set(file, Math.min(low.get(file)!, indices.get(target)!))
      }
    }
    if (low.get(file) !== indices.get(file)) return
    const group: string[] = []
    let target: string
    do {
      target = stack.pop()!
      onStack.delete(target)
      group.push(target)
    } while (target !== file)
    if (group.length > 1 || adjacency.get(file)!.has(file)) cycles.push(group.sort())
  }
  for (const file of sources.keys()) {
    if (!indices.has(file)) visit(file)
  }
  return cycles.sort((left, right) => left[0].localeCompare(right[0]))
}

const sources = readProductionSources(sourceRoot)
const edges = dependencies(sources)

describe('API gateway dependency direction', () => {
  it('keeps the compatibility facade to explicit re-exports', () => {
    const ast = parseScript(facade, sources.get(facade)!)
    expect(ast.statements.length).toBeGreaterThan(0)
    expect(ast.statements.every(node => ts.isExportDeclaration(node)
      && Boolean(node.moduleSpecifier) && Boolean(node.exportClause && ts.isNamedExports(node.exportClause)))).toBe(true)
  })

  it('discovers every production consumer and prevents facade back-imports including types', () => {
    expect(edges.filter(edge => edge.to === facade)).toEqual([])
  })

  it('checks the complete local literal runtime graph for indirect cycles', () => {
    expect(runtimeCycles(sources, edges)).toEqual([])
  })

  it('keeps thread command boundaries independent of thread reads', () => {
    expect(edges.filter(edge => edge.from === 'src/api/threadCommandGateway.ts'
      && edge.to === 'src/api/threadReadGateway.ts')).toEqual([])
  })

  it('resolves Vue, alias, JS extensions, re-exports, dynamic imports and new consumers', () => {
    const fixture = new Map([
      ['src/api/codexGateway.ts', 'export const value = 1'],
      ['src/a.vue', '<template><div>import ignored</div></template><script setup lang="ts">import { value } from "@/api/codexGateway.js"; export { b } from "./b.js"</script>'],
      ['src/b.ts', 'export const b = import("./c")'],
      ['src/c.ts', 'import "./a.vue"'],
      ['src/type.ts', 'import type { value } from "./api/codexGateway"; export { type b } from "./b"'],
      ['src/late.ts', 'const api = require("./api/codexGateway.js")'],
    ])
    const actual = dependencies(fixture)
    expect(actual.filter(edge => edge.to === facade).map(edge => [edge.from, edge.typeOnly])).toEqual([
      ['src/a.vue', false], ['src/type.ts', true], ['src/late.ts', false],
    ])
    expect(runtimeCycles(fixture, actual)).toEqual([['src/a.vue', 'src/b.ts', 'src/c.ts']])
  })

  it('does not report explicit type-only cycles as runtime cycles', () => {
    const fixture = new Map([
      ['src/a.ts', 'import { type B } from "./b.js"; export type A = B'],
      ['src/b.ts', 'export type { A as B } from "./a"'],
    ])
    expect(runtimeCycles(fixture, dependencies(fixture))).toEqual([])
  })
})
