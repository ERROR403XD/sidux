import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as vue from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CODE_LANGUAGE_ALIASES, escapeHtml, normalizeFileUrlToPath, resolveRelativePath } from './conversationRenderPrimitives'
import { getPathLeafName } from '../pathUtils.js'
import { messageRenderKey } from '../messageIdentity'
import type { UiMessage } from '../types/codex'
import { useConversationRendering } from './useConversationRendering'

const scopes: vue.EffectScope[] = []

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function setup() {
  const props = vue.reactive({
    messages: [{ id: 'message', role: 'assistant', text: '![image](https://example.test/old.png)' }] as UiMessage[],
    activeThreadId: 'thread-a', cwd: '/fixture/a', accountRevision: 0,
  })
  const pending = deferred<{ default: Highlighter }>()
  const highlighter = { getLanguage: vi.fn(() => true), highlight: vi.fn((text: string) => ({ value: `<span>${escapeHtml(text)}</span>` })) }
  type Highlighter = typeof highlighter
  const loader = vi.fn(() => pending.promise)
  const dependencies = {
    ...vue, props, CODE_LANGUAGE_ALIASES, escapeHtml, normalizeFileUrlToPath, resolveRelativePath,
    useConversationRendering: (options: Parameters<typeof useConversationRendering>[0]) => useConversationRendering({ ...options, loadHighlighter: loader as unknown as NonNullable<typeof options.loadHighlighter> }),
    getPathLeafName, messageRenderKey, loadHighlightModule: loader,
    window: { removeEventListener: vi.fn(), location: { origin: 'https://fixture.test', pathname: '/' } },
    onBeforeUnmount: vue.onScopeDispose, copyAttempt: 0, copiedMessageResetTimer: null,
    fileChangeActions: { stop: () => undefined },
    onWindowPointerDownForFileLinkContextMenu: () => undefined,
    onWindowBlurForFileLinkContextMenu: () => undefined,
    onWindowKeydownForFileLinkContextMenu: () => undefined,
  }
  const file = readFileSync(process.env.CONVERSATION_RENDERING_SOURCE || new URL('../components/content/ThreadConversation.vue', import.meta.url), 'utf8')
  const script = file.split('<script setup lang="ts">')[1]!.split('</script>')[0]!
  const source = ts.createSourceFile('conversation.ts', script, ts.ScriptTarget.Latest, true)
  const assembly = source.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(row =>
    row.initializer && ts.isCallExpression(row.initializer) && row.initializer.expression.getText(source) === 'useConversationRendering',
  ))
  const declarations = new Map<string, ts.Statement>()
  for (const node of source.statements) {
    if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node)
    if (ts.isVariableStatement(node)) {
      for (const row of node.declarationList.declarations) {
        if (ts.isIdentifier(row.name) && row.name.text !== 'props') declarations.set(row.name.text, node)
      }
    }
  }
  const selected = new Set<ts.Statement>()
  const select = (name: string) => {
    const node = declarations.get(name)
    if (!node || selected.has(node)) return
    selected.add(node)
    function visit(child: ts.Node) {
      if (ts.isIdentifier(child)) select(child.text)
      ts.forEachChild(child, visit)
    }
    visit(node)
  }
  for (const name of ['getMessageBlocks', 'getInlineSegments', 'renderMarkdownBlocksAsHtml', 'renderCachedHighlightedCodeAsHtml', 'ensureHighlightJsLoaded', 'onMarkdownImageError', 'isMarkdownImageFailed', 'highlightCacheVersion', 'markdownImageFailureVersion', 'clearRenderCaches', 'resetRenderState']) select(name)
  for (const node of source.statements) {
    if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) continue
    const call = node.expression.expression.getText(source)
    if (call === 'onBeforeUnmount' || call === 'watch' && /ensureHighlightJsLoaded|resetRenderState/.test(node.getText(source))) selected.add(node)
  }
  const code = ts.transpile(
    assembly ? assembly.getText(source) + '\nreturn rendering;' : source.statements.filter(node => selected.has(node)).map(node => node.getText(source)).join('\n')
      .replace("import('highlight.js/lib/common')", 'loadHighlightModule()')
      + '\nreturn { getMessageBlocks, getInlineSegments, renderMarkdownBlocksAsHtml, renderCachedHighlightedCodeAsHtml, ensureHighlightJsLoaded, onMarkdownImageError, isMarkdownImageFailed, highlightCacheVersion, markdownImageFailureVersion };',
    { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  )
  const names = Object.keys(dependencies).filter(name => /^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default')
  const scope = vue.effectScope()
  scopes.push(scope)
  const state = scope.run(() => new Function(...names, code)(...names.map(name => dependencies[name as keyof typeof dependencies])))! as {
    getMessageBlocks(message: UiMessage): unknown[]
    getInlineSegments(text: string): unknown[]
    renderMarkdownBlocksAsHtml(text: string): string
    renderCachedHighlightedCodeAsHtml(language: string, value: string): string
    ensureHighlightJsLoaded(): Promise<void>
    onMarkdownImageError(messageId: string, blockIndex: number, imageUrl?: string, event?: Event): void
    isMarkdownImageFailed(messageId: string, blockIndex: number, imageUrl?: string): boolean
    highlightCacheVersion: vue.Ref<number>
    markdownImageFailureVersion: vue.Ref<number>
  }
  return { props, state, scope, pending, loader, highlighter, key: () => messageRenderKey(props.messages[0]!, props.activeThreadId) }
}

afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); vi.unstubAllGlobals() })

describe('real Conversation rendering lifecycle', () => {
  it('shares one pending highlighter load and replaces cached plain HTML when ready', async () => {
    const { state, pending, loader, highlighter } = setup()
    const before = state.renderMarkdownBlocksAsHtml('```js\nconst x = 1\n```')
    const first = state.ensureHighlightJsLoaded()
    const second = state.ensureHighlightJsLoaded()
    expect(first).toBe(second)
    expect(loader).toHaveBeenCalledTimes(1)
    pending.resolve({ default: highlighter })
    await first
    const after = state.renderMarkdownBlocksAsHtml('```js\nconst x = 1\n```')
    expect(before).not.toContain('<span>')
    expect(after).toContain('<span>')
    state.renderMarkdownBlocksAsHtml('```js\nconst x = 1\n```')
    expect(highlighter.highlight).toHaveBeenCalledTimes(1)
  })

  it('handles a failed module load as plain code and permits a later retry', async () => {
    const { state, pending, loader, highlighter } = setup()
    const loading = state.ensureHighlightJsLoaded()
    pending.reject(new Error('synthetic module failure'))
    await expect(loading).resolves.toBeUndefined()
    expect(state.renderCachedHighlightedCodeAsHtml('js', '<script>')).toBe('&lt;script&gt;')
    loader.mockResolvedValueOnce({ default: highlighter })
    await state.ensureHighlightJsLoaded()
    expect(loader).toHaveBeenCalledTimes(2)
    expect(state.renderCachedHighlightedCodeAsHtml('js', '<script>')).toContain('<span>')
  })

  it('ignores a pending module completion after disposal and refuses new loads', async () => {
    const { state, scope, pending, loader, highlighter } = setup()
    const loading = state.ensureHighlightJsLoaded()
    const version = state.highlightCacheVersion.value
    scope.stop()
    pending.resolve({ default: highlighter })
    await loading
    expect(state.highlightCacheVersion.value).toBe(version)
    await state.ensureHighlightJsLoaded()
    expect(loader).toHaveBeenCalledTimes(1)
    expect(state.renderMarkdownBlocksAsHtml('```js\nnew work\n```')).toBe('')
    expect(highlighter.highlight).not.toHaveBeenCalled()
  })

  for (const identity of ['thread', 'cwd', 'account'] as const) {
    it(`clears image failures synchronously across ${identity} A to B to A`, () => {
      const { props, state, key } = setup()
      state.onMarkdownImageError(key(), 0, 'https://example.test/old.png')
      expect(state.isMarkdownImageFailed(key(), 0, 'https://example.test/old.png')).toBe(true)
      if (identity === 'thread') { props.activeThreadId = 'thread-b'; props.activeThreadId = 'thread-a' }
      if (identity === 'cwd') { props.cwd = '/fixture/b'; props.cwd = '/fixture/a' }
      if (identity === 'account') { props.accountRevision = 1; props.accountRevision = 0 }
      expect(state.isMarkdownImageFailed(key(), 0, 'https://example.test/old.png')).toBe(false)
    })
  }

  it('does not carry a failed old URL to a corrected image at the same message position', () => {
    const { props, state, key } = setup()
    state.onMarkdownImageError(key(), 0, 'https://example.test/old.png')
    props.messages[0]!.text = '![image](https://example.test/new.png)'
    expect(state.isMarkdownImageFailed(key(), 0, 'https://example.test/new.png')).toBe(false)
    state.onMarkdownImageError(key(), 0, 'https://example.test/old.png')
    expect(state.isMarkdownImageFailed(key(), 0, 'https://example.test/new.png')).toBe(false)
  })

  it('rejects events from detached nodes and calls after disposal', () => {
    const { state, scope, key } = setup()
    const event = { currentTarget: { isConnected: false } } as unknown as Event
    state.onMarkdownImageError(key(), 0, 'https://example.test/old.png', event)
    expect(state.isMarkdownImageFailed(key(), 0, 'https://example.test/old.png')).toBe(false)
    scope.stop()
    const version = state.markdownImageFailureVersion.value
    state.onMarkdownImageError(key(), 0, 'https://example.test/old.png')
    expect(state.isMarkdownImageFailed(key(), 0, 'https://example.test/old.png')).toBe(false)
    expect(state.markdownImageFailureVersion.value).toBe(version)
  })

  it('invalidates cwd-dependent HTML while retaining the immutable highlighter', async () => {
    const { props, state, pending, loader, highlighter } = setup()
    const loading = state.ensureHighlightJsLoaded()
    props.cwd = '/fixture/b'
    pending.resolve({ default: highlighter })
    await loading
    expect(state.renderMarkdownBlocksAsHtml('[file](./readme.md)')).toContain('/codex-local-browse/fixture/b/readme.md')
    await state.ensureHighlightJsLoaded()
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('deduplicates image failures and clears them when the current message text changes', () => {
    const { props, state, key } = setup()
    state.onMarkdownImageError(key(), 0, 'https://example.test/old.png')
    const version = state.markdownImageFailureVersion.value
    state.onMarkdownImageError(key(), 0, 'https://example.test/old.png')
    expect(state.markdownImageFailureVersion.value).toBe(version)
    props.messages[0]!.text = 'New text\n\n![image](https://example.test/old.png)'
    state.getMessageBlocks(props.messages[0]!)
    expect(state.isMarkdownImageFailed(key(), 0, 'https://example.test/old.png')).toBe(false)
    state.onMarkdownImageError(key(), 0, 'https://example.test/old.png')
    expect(state.isMarkdownImageFailed(key(), 0, 'https://example.test/old.png')).toBe(false)
  })

  it('retains recently used message parses while evicting the oldest bounded entry', () => {
    const { state } = setup()
    const message = (id: number): UiMessage => ({ id: String(id), role: 'assistant', text: `Message ${id}` })
    const first = state.getMessageBlocks(message(0))
    const second = state.getMessageBlocks(message(1))
    for (let i = 2; i < 300; i++) state.getMessageBlocks(message(i))
    expect(state.getMessageBlocks(message(0))).toBe(first)
    state.getMessageBlocks(message(300))
    expect(state.getMessageBlocks(message(0))).toBe(first)
    expect(state.getMessageBlocks(message(1))).not.toBe(second)
  })

  it('escapes raw HTML, image attributes, unknown code and linked labels in HTML output', () => {
    const { state } = setup()
    const html = state.renderMarkdownBlocksAsHtml('<script>alert(1)</script>\n\n[label <tag>](https://example.test/?a=1&b=2)\n\n```unknown\n<script>\n```')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('a=1&amp;b=2')
    expect(html).toContain('&lt;tag&gt;')
  })

  it('handles late rejection after disposal and keeps stopped watches from loading again', async () => {
    const { props, state, scope, pending, loader } = setup()
    const loading = state.ensureHighlightJsLoaded()
    scope.stop()
    pending.reject(new Error('disposed module failure'))
    await expect(loading).resolves.toBeUndefined()
    props.messages[0]!.text = '```js\nlate\n```'
    await vue.nextTick()
    await state.ensureHighlightJsLoaded()
    expect(loader).toHaveBeenCalledTimes(1)
    expect(state.getMessageBlocks(props.messages[0]!)).toEqual([])
    expect(state.getInlineSegments('late')).toEqual([])
  })
})
