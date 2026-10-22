import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as vue from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { messageRenderKey } from '../messageIdentity'
import { useConversationCommandProjection } from './conversationCommandProjection'
import { useConversationFileChangeProjection } from './conversationFileChangeProjection'
import { buildFileChangeCopyText } from './conversationFilePresentation'
import { useConversationMessagePresentation } from './useConversationMessagePresentation'
import type { UiMessage } from '../types/codex'

const scopes: vue.EffectScope[] = []
const command = (id = 'command', status: 'inProgress' | 'completed' = 'completed'): UiMessage => ({
  id, role: 'system', text: '', messageType: 'commandExecution', turnId: 'turn', turnIndex: 0,
  commandExecution: { command: id, cwd: '/a', status, aggregatedOutput: 'output', exitCode: 0 },
})
const worked: UiMessage = { id: 'worked', role: 'system', text: 'Worked for 2s', messageType: 'worked', turnId: 'turn' }
const reply: UiMessage = { id: 'reply', role: 'assistant', text: 'Response', turnId: 'turn', turnIndex: 0 }

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function setup() {
  const props = vue.reactive({ messages: [command(), worked, reply] as UiMessage[], activeThreadId: 'a', cwd: '/a', accountRevision: 0, isLoading: false, liveOverlay: null })
  const clipboard = vi.fn(async (_text: string): Promise<void> => undefined)
  const emit = vi.fn()
  class FixtureElement {
    closest() { return this }
    getAttribute() { return '/codex-local-browse/old' }
  }
  const fixtureWindow = { addEventListener: vi.fn(), removeEventListener: vi.fn(), location: { href: 'http://fixture.test/' } }
  vi.stubGlobal('Element', FixtureElement)
  vi.stubGlobal('HTMLAnchorElement', FixtureElement)
  vi.stubGlobal('window', fixtureWindow)
  const file = readFileSync(process.env.CONVERSATION_MESSAGE_SOURCE || new URL('../components/content/ThreadConversation.vue', import.meta.url), 'utf8')
  const source = ts.createSourceFile('conversation.ts', file.split('<script setup lang="ts">')[1]!.split('</script>')[0]!, ts.ScriptTarget.Latest, true)
  const assembly = source.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(row =>
    row.initializer && ts.isCallExpression(row.initializer) && row.initializer.expression.getText(source) === 'useConversationMessagePresentation',
  ))
  const declarations = new Map<string, ts.Statement>()
  for (const node of source.statements) {
    if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node)
    if (ts.isVariableStatement(node)) for (const row of node.declarationList.declarations) {
      if (ts.isIdentifier(row.name) && row.name.text !== 'props') declarations.set(row.name.text, node)
      if (ts.isObjectBindingPattern(row.name)) for (const element of row.name.elements) if (ts.isIdentifier(element.name)) declarations.set(element.name.text, node)
    }
  }
  const selected = new Set<ts.Statement>()
  function select(name: string) {
    if (['props', 'emit', 'fileChangeActions', 'pruneFileChangeSummaries'].includes(name)) return
    const node = declarations.get(name)
    if (!node || selected.has(node)) return
    selected.add(node)
    function visit(child: ts.Node) { if (ts.isIdentifier(child)) select(child.text); ts.forEachChild(child, visit) }
    visit(node)
  }
  const exports = ['copyResponse', 'copyCodeBlock', 'copiedResponseAnchorId', 'copiedCodeBlockKey', 'copyFailureKey', 'toggleCommandExpand', 'isCommandExpanded', 'toggleCommandGroup', 'isCommandGroupExpanded', 'toggleWorkedExpand', 'isWorkedExpanded', 'openImageModal', 'modalImageUrl', 'forkResponse', 'editMessage', 'implementPlan', 'showCopyResponseButton', 'getCommandBlockForLatest', 'isFileLinkContextMenuVisible', 'fileLinkContextBrowseUrl', 'fileLinkContextEditUrl', 'onConversationContextMenu']
  exports.forEach(select)
  for (const node of source.statements) {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && ['watch', 'onBeforeUnmount', 'onMounted'].includes(node.expression.expression.getText(source))) {
      selected.add(node)
      function visit(child: ts.Node) { if (ts.isIdentifier(child)) select(child.text); ts.forEachChild(child, visit) }
      visit(node)
    }
  }
  const dependencies = {
    ...vue, props, emit, messageRenderKey, useConversationCommandProjection, useConversationFileChangeProjection, buildFileChangeCopyText,
    anchoredFileChangeSummaryByAnchorId: vue.computed(() => ({})),
    useConversationMessagePresentation: (options: Parameters<typeof useConversationMessagePresentation>[0]) => useConversationMessagePresentation({ ...options, writeClipboard: clipboard }),
    copyTextToClipboard: clipboard, onBeforeUnmount: vue.onScopeDispose, onMounted: () => undefined,
    fileChangeActions: { stop: () => undefined }, pruneFileChangeSummaries: () => undefined,
    window: fixtureWindow,
  }
  const code = ts.transpile(assembly ? assembly.getText(source) + '\nreturn { ...messagePresentation, ...messagePresentation.commandResults };' : source.statements.filter(node => selected.has(node)).map(node => node.getText(source)).join('\n') + `\nreturn { ${exports.join(', ')} };`, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None })
  const names = Object.keys(dependencies).filter(name => /^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default')
  const scope = vue.effectScope()
  scopes.push(scope)
  const state = scope.run(() => new Function(...names, code)(...names.map(name => dependencies[name as keyof typeof dependencies])))! as {
    copyResponse(id: string): Promise<void>; copyCodeBlock(key: string, text: string): Promise<void>
    copiedResponseAnchorId: vue.Ref<string>; copiedCodeBlockKey: vue.Ref<string>; copyFailureKey: vue.Ref<string>
    toggleCommandExpand(message: UiMessage): void; isCommandExpanded(message: UiMessage): boolean
    toggleCommandGroup(message: UiMessage): void; isCommandGroupExpanded(message: UiMessage): boolean
    toggleWorkedExpand(message: UiMessage): void; isWorkedExpanded(message: UiMessage): boolean
    openImageModal(url: string): void; modalImageUrl: vue.Ref<string>
    forkResponse(id: string): void; editMessage(id: string): void; implementPlan(message: UiMessage): void
    showCopyResponseButton(message: UiMessage): boolean; getCommandBlockForLatest(message: UiMessage): UiMessage[]
    isFileLinkContextMenuVisible: vue.Ref<boolean>; fileLinkContextBrowseUrl: vue.Ref<string>; fileLinkContextEditUrl: vue.Ref<string>
    onConversationContextMenu(event: MouseEvent): void
  }
  return { props, state, scope, clipboard, emit, fixtureWindow, openMenu: () => state.onConversationContextMenu({ target: new FixtureElement(), preventDefault: vi.fn(), stopPropagation: vi.fn(), clientX: 20, clientY: 40 } as unknown as MouseEvent), key: (message = reply) => messageRenderKey(message, props.activeThreadId) }
}

afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('real Conversation message presentation assembly', () => {
  for (const identity of ['activeThreadId', 'cwd', 'accountRevision'] as const) {
    for (const failure of [false, true]) it(`rejects late clipboard ${failure ? 'failure' : 'success'} across ${identity} A-B-A`, async () => {
      const { props, state, clipboard, key } = setup()
      const pending = deferred()
      clipboard.mockImplementationOnce(() => pending.promise)
      const copying = state.copyResponse(key())
      const original = props[identity]
      if (identity === 'accountRevision') { props[identity]++; props[identity] = original as number }
      else { props[identity] = 'b'; props[identity] = original as string }
      if (failure) pending.reject(new Error('clipboard unavailable')); else pending.resolve()
      await copying
      expect(state.copiedResponseAnchorId.value).toBe('')
      expect(state.copyFailureKey.value).toBe('')
    })
  }

  it('clears previous copy feedback and timer when a newer attempt starts', async () => {
    vi.useFakeTimers()
    const { state, clipboard, key } = setup()
    await state.copyResponse(key())
    expect(state.copiedResponseAnchorId.value).toBe(key())
    const pending = deferred()
    clipboard.mockImplementationOnce(() => pending.promise)
    const copying = state.copyCodeBlock('block', 'code')
    expect(state.copiedResponseAnchorId.value).toBe('')
    expect(vi.getTimerCount()).toBe(0)
    pending.resolve(); await copying
    expect(state.copiedCodeBlockKey.value).toBe('block')
    await vi.advanceTimersByTimeAsync(1800)
    expect(state.copiedCodeBlockKey.value).toBe('')
  })

  it('lets the newest copy win and keeps a late old failure from replacing it', async () => {
    const { state, clipboard, key } = setup()
    const old = deferred()
    clipboard.mockImplementationOnce(() => old.promise)
    const copying = state.copyResponse(key())
    await state.copyCodeBlock('new', 'code')
    old.reject(new Error('old failure')); await copying
    expect(state.copiedCodeBlockKey.value).toBe('new')
    expect(state.copyFailureKey.value).toBe('')
  })

  it('clears expansion, image, menu and copy feedback synchronously on identity change', async () => {
    vi.useFakeTimers()
    const { props, state, key, openMenu } = setup()
    props.messages = [command('first'), command('last'), worked, reply]
    await vue.nextTick()
    state.toggleCommandExpand(props.messages[0]!)
    state.toggleCommandGroup(props.messages[1]!)
    state.toggleWorkedExpand(worked)
    state.openImageModal('https://fixture.test/image.png')
    openMenu()
    await state.copyResponse(key())
    props.accountRevision++
    expect(state.isCommandExpanded(props.messages[0]!)).toBe(false)
    expect(state.isCommandGroupExpanded(props.messages[1]!)).toBe(false)
    expect(state.isWorkedExpanded(worked)).toBe(false)
    expect(state.modalImageUrl.value).toBe('')
    expect(state.isFileLinkContextMenuVisible.value).toBe(false)
    expect(state.fileLinkContextBrowseUrl.value).toBe('')
    expect(state.fileLinkContextEditUrl.value).toBe('')
    expect(state.copiedResponseAnchorId.value).toBe('')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('prunes worked and command state after loading completes without replacing messages again', async () => {
    const { props, state } = setup()
    state.toggleCommandExpand(props.messages[0]!)
    state.toggleWorkedExpand(worked)
    props.isLoading = true
    props.messages = [reply]
    await vue.nextTick()
    props.isLoading = false
    await vue.nextTick()
    props.messages = [command(), worked, reply]
    await vue.nextTick()
    expect(state.isCommandExpanded(props.messages[0]!)).toBe(false)
    expect(state.isWorkedExpanded(worked)).toBe(false)
  })

  it('keeps auto expansion, user collapse, completed labels and grouping semantics', async () => {
    const { props, state } = setup()
    props.messages = [command('one', 'inProgress')]
    await vue.nextTick()
    expect(state.isCommandExpanded(props.messages[0]!)).toBe(true)
    state.toggleCommandExpand(props.messages[0]!)
    expect(state.isCommandExpanded(props.messages[0]!)).toBe(false)
    props.messages = [command('one'), command('two', 'inProgress')]
    await vue.nextTick()
    expect(state.isCommandExpanded(props.messages[1]!)).toBe(true)
    expect(state.getCommandBlockForLatest(props.messages[1]!).map(row => row.id)).toEqual(['one', 'two'])
  })

  it('groups copy content at the last assistant anchor and emits narrow action payloads', async () => {
    const { props, state, clipboard, emit, key } = setup()
    const user: UiMessage = { id: 'user', role: 'user', text: 'Input', turnId: 'turn', turnIndex: 0 }
    const final: UiMessage = { ...reply, id: 'final', text: 'Final', fileAttachments: [{ path: '/a/file', label: 'file' }] }
    props.messages = [user, reply, final]
    expect(state.showCopyResponseButton(reply)).toBe(false)
    expect(state.showCopyResponseButton(final)).toBe(true)
    await state.copyResponse(key(final))
    expect(clipboard).toHaveBeenCalledWith('Response\n\nFinal\n\nFiles:\n/a/file')
    state.forkResponse(key(final)); state.editMessage(key(user)); state.implementPlan({ ...final, messageType: 'plan' })
    expect(emit.mock.calls).toEqual([['forkThread', { threadId: 'a', turnId: 'turn' }], ['rollback', { turnId: 'turn' }], ['implementPlan', { turnId: 'turn' }]])
  })

  it('disposes feedback and refuses clipboard, expansion, image and action commands after stop', async () => {
    vi.useFakeTimers()
    const { state, scope, clipboard, emit, key } = setup()
    await state.copyResponse(key())
    state.toggleWorkedExpand(worked)
    scope.stop()
    expect(state.copiedResponseAnchorId.value).toBe('')
    expect(state.isWorkedExpanded(worked)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    await state.copyResponse(key()); state.toggleWorkedExpand(worked); state.openImageModal('late')
    state.forkResponse(key()); state.implementPlan(reply)
    expect(clipboard).toHaveBeenCalledTimes(1)
    expect(state.isWorkedExpanded(worked)).toBe(false)
    expect(state.modalImageUrl.value).toBe('')
    expect(emit).not.toHaveBeenCalled()
  })

  it('releases menu listeners on close and rejects reopening after explicit stop', () => {
    const { state, fixtureWindow, openMenu, props } = setup()
    const owner = state as typeof state & { stop(): void; openFileLinkContextBrowse(): void }
    expect(fixtureWindow.addEventListener).not.toHaveBeenCalled()
    openMenu()
    expect(fixtureWindow.addEventListener).toHaveBeenCalledTimes(3)
    props.cwd = '/new'
    expect(fixtureWindow.removeEventListener.mock.calls.map(call => call[0])).toEqual(['pointerdown', 'blur', 'keydown'])
    openMenu()
    owner.stop(); owner.stop()
    expect(state.isFileLinkContextMenuVisible.value).toBe(false)
    openMenu()
    expect(fixtureWindow.addEventListener).toHaveBeenCalledTimes(6)
    expect(state.isFileLinkContextMenuVisible.value).toBe(false)
  })

  it('disposes pending copy success and failure without allocating a reset timer', async () => {
    vi.useFakeTimers()
    for (const failure of [false, true]) {
      const { state, scope, clipboard, key } = setup()
      const pending = deferred()
      clipboard.mockImplementationOnce(() => pending.promise)
      const copying = state.copyResponse(key())
      scope.stop()
      if (failure) pending.reject(new Error('disposed copy')); else pending.resolve()
      await copying
      expect(state.copiedResponseAnchorId.value).toBe('')
      expect(state.copyFailureKey.value).toBe('')
      expect(vi.getTimerCount()).toBe(0)
    }
  })
})
