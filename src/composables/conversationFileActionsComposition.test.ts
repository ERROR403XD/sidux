import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as vue from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TurnFileChangeSummary } from './conversationFileChangeProjection'
import { createConversationFileActionsController } from './conversationFileActionsController'

const update = vi.hoisted(() => vi.fn())
vi.mock('../api/threadCommandGateway', () => ({ updateThreadFileChanges: update }))

const scopes: vue.EffectScope[] = []
const summary = (turnId = 'turn-a'): TurnFileChangeSummary => ({ turnId, changes: [], sourceMessageIds: [], source: 'metadata' })
function deferred() {
  let resolve!: (result: { changed: number; errors: string[]; revertedPatchIds?: string[]; appliedPatchIds?: string[] }) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Parameters<typeof resolve>[0]>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function setup() {
  const props = vue.reactive({ activeThreadId: 'thread-a', cwd: '/fixture/a', accountRevision: 0, messages: [] })
  const mounted: Array<() => void> = []
  const unmounted: Array<() => void> = []
  const dependencies = {
    ...vue, props, updateThreadFileChanges: update, createConversationFileActionsController,
    onMounted: (fn: () => void) => mounted.push(fn), onBeforeUnmount: (fn: () => void) => unmounted.push(fn),
    autoFollowOutput: vue.ref(true), modalImageUrl: vue.ref(''), isLoadingMore: vue.ref(false), historyLoadError: vue.ref(''),
    historyLoadSequence: 0, renderWindowStart: vue.ref(0), RENDER_WINDOW_SIZE: 100,
    scheduleConversationScroll: async () => undefined, clearRenderCaches: () => undefined,
    resetRenderState: () => undefined, renderingStopped: false, highlightJsLoader: null,
    copyAttempt: 0, copiedMessageResetTimer: null,
    onWindowPointerDownForFileLinkContextMenu: () => undefined,
    onWindowBlurForFileLinkContextMenu: () => undefined, onWindowKeydownForFileLinkContextMenu: () => undefined,
  }
  const file = readFileSync(process.env.CONVERSATION_FILE_ACTION_SOURCE || new URL('../components/content/ThreadConversation.vue', import.meta.url), 'utf8')
  const script = file.split('<script setup lang="ts">')[1]!.split('</script>')[0]!
  const source = ts.createSourceFile('conversation.ts', script, ts.ScriptTarget.Latest, true)
  const owned = /^(?:fileChangeAction\w*|fileChangeNextAction|fileChangeRedoPatchIds|fileChangeAppliedPatchIds|fileChangePendingRedoPatchIds|resetFileChangeActions|isFileChangeActionable|isFileChangeActionPending|runFileChangeAction)$/
  const statements = source.statements.filter(node => {
    if (ts.isFunctionDeclaration(node)) return owned.test(node.name?.text || '')
    if (ts.isVariableStatement(node)) return node.declarationList.declarations.some(declaration => {
      if (ts.isObjectBindingPattern(declaration.name)) return declaration.name.elements.some(element => owned.test(element.name.getText(source)))
      return owned.test(declaration.name.getText(source))
    })
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression
      const name = call.expression.getText(source)
      return name === 'onMounted' || name === 'onBeforeUnmount' || (name === 'watch' && /props\.activeThreadId|resetFileChangeActions/.test(call.getText(source)) && !/resetFilePresentation/.test(call.getText(source)))
    }
    return false
  }).map(node => node.getText(source)).join('\n')
  const code = ts.transpile(statements + '\nreturn { isFileChangeActionable, fileChangeActionStatus: typeof fileChangeActionStatus === "undefined" ? fileChangeActions.fileChangeActionStatus : fileChangeActionStatus, fileChangeActionErrorText, fileChangeNextAction, fileChangeActionLabel, runFileChangeAction };', { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None })
  const names = Object.keys(dependencies).filter(name => /^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default')
  const scope = vue.effectScope()
  scopes.push(scope)
  const actions = scope.run(() => new Function(...names, code)(...names.map(name => dependencies[name as keyof typeof dependencies])))!
  mounted.forEach(fn => fn())
  return { props, actions, stop: () => { unmounted.forEach(fn => fn()); scope.stop() } }
}

beforeEach(() => {
  update.mockReset()
  update.mockResolvedValue({ changed: 1, errors: [], revertedPatchIds: ['patch-a'], appliedPatchIds: ['patch-a'] })
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
})
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); vi.unstubAllGlobals() })

describe('real Conversation file action declaration/watch/unmount composition', () => {
  it('allows only one workspace mutation while any turn action is pending', async () => {
    const waiting = deferred()
    update.mockReturnValueOnce(waiting.promise)
    const { actions } = setup()
    const first = actions.runFileChangeAction(summary(), 'undo')
    await actions.runFileChangeAction(summary(), 'undo')
    await actions.runFileChangeAction(summary('turn-b'), 'undo')
    expect(update).toHaveBeenCalledTimes(1)
    waiting.resolve({ changed: 1, errors: [], revertedPatchIds: ['patch-a'] })
    await first
  })

  it.each(['thread', 'cwd', 'account'])('invalidates a pending %s identity synchronously, including A → B → A', async identity => {
    const waiting = deferred()
    update.mockReturnValueOnce(waiting.promise)
    const { actions, props } = setup()
    const first = actions.runFileChangeAction(summary(), 'undo')
    if (identity === 'thread') { props.activeThreadId = 'thread-b'; props.activeThreadId = 'thread-a' }
    if (identity === 'cwd') { props.cwd = '/fixture/b'; props.cwd = '/fixture/a' }
    if (identity === 'account') props.accountRevision += 1
    waiting.resolve({ changed: 1, errors: [], revertedPatchIds: ['old-patch'] })
    await first
    expect(actions.fileChangeActionStatus(summary())).toBe('idle')
    expect(actions.fileChangeActionErrorText(summary())).toBe('')
    await actions.runFileChangeAction(summary(), 'undo')
    expect(update.mock.calls.at(-1)).toEqual(['thread-a', 'turn-a', '/fixture/a', 'undo', undefined, 'single_turn'])
  })

  it.each(['success', 'error'])('ignores late %s after unmount and rejects further actions', async outcome => {
    const waiting = deferred()
    update.mockReturnValueOnce(waiting.promise)
    const { actions, stop } = setup()
    const first = actions.runFileChangeAction(summary(), 'undo')
    stop()
    const status = actions.fileChangeActionStatus(summary())
    const error = actions.fileChangeActionErrorText(summary())
    if (outcome === 'success') waiting.resolve({ changed: 1, errors: [], revertedPatchIds: ['late'] })
    else waiting.reject(new Error('late failure'))
    await first
    expect(actions.fileChangeActionStatus(summary())).toBe(status)
    expect(actions.fileChangeActionErrorText(summary())).toBe(error)
    await actions.runFileChangeAction(summary('turn-b'), 'undo')
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('retains Undo on an API error with no changes and allows a genuine retry', async () => {
    update.mockResolvedValueOnce({ changed: 0, errors: ['HTTP 500'] })
    const { actions } = setup()
    await actions.runFileChangeAction(summary(), 'undo')
    expect(actions.fileChangeNextAction(summary())).toBe('undo')
    expect(actions.fileChangeActionErrorText(summary())).toBe('HTTP 500')
    await actions.runFileChangeAction(summary(), 'undo')
    expect(actions.fileChangeNextAction(summary())).toBe('redo')
    expect(actions.fileChangeActionErrorText(summary())).toBe('')
  })

  it('retries only the remaining partial-redo IDs then retains the entire undo scope', async () => {
    update.mockResolvedValueOnce({ changed: 2, errors: [], revertedPatchIds: ['patch-a', 'patch-b'] })
    const { actions } = setup()
    await actions.runFileChangeAction(summary(), 'undo')
    update.mockResolvedValueOnce({ changed: 1, errors: ['b failed'], appliedPatchIds: ['patch-a'] })
    await actions.runFileChangeAction(summary(), 'redo')
    expect(actions.fileChangeNextAction(summary())).toBe('redo')
    update.mockResolvedValueOnce({ changed: 1, errors: [], appliedPatchIds: ['patch-b'] })
    await actions.runFileChangeAction(summary(), 'redo')
    expect(update.mock.calls.at(-1)?.[4]).toEqual(['patch-b'])
    expect(actions.fileChangeNextAction(summary())).toBe('undo')
    await actions.runFileChangeAction(summary(), 'undo')
    expect(update.mock.calls.at(-1)?.[4]).toEqual(['patch-a', 'patch-b'])
  })

  it('keeps the original action and error when transport throws', async () => {
    update.mockRejectedValueOnce(new Error('offline'))
    const { actions } = setup()
    await actions.runFileChangeAction(summary(), 'undo')
    expect(actions.fileChangeActionStatus(summary())).toBe('idle')
    expect(actions.fileChangeActionErrorText(summary())).toBe('offline')
    await actions.runFileChangeAction(summary(), 'undo')
    expect(actions.fileChangeActionStatus(summary())).toBe('undone')
  })

  it('requires cwd and rejects an action that is inconsistent with the current state', async () => {
    const { actions, props } = setup()
    props.cwd = ''
    expect(actions.isFileChangeActionable(summary())).toBe(false)
    props.cwd = '/fixture/a'
    await actions.runFileChangeAction(summary(), 'redo')
    expect(update).not.toHaveBeenCalled()
  })

  it('holds the workspace mutation slot across an identity reset until the request settles', async () => {
    const waiting = deferred()
    update.mockReturnValueOnce(waiting.promise)
    const { actions, props } = setup()
    const first = actions.runFileChangeAction(summary(), 'undo')
    props.activeThreadId = 'thread-b'
    await actions.runFileChangeAction(summary('turn-b'), 'undo')
    expect(update).toHaveBeenCalledTimes(1)
    waiting.resolve({ changed: 1, errors: [], revertedPatchIds: ['old'] })
    await first
    await actions.runFileChangeAction(summary('turn-b'), 'undo')
    expect(update.mock.calls.at(-1)).toEqual(['thread-b', 'turn-b', '/fixture/a', 'undo', undefined, 'single_turn'])
  })

  it('does not broaden an empty reversible patch set into all patches', async () => {
    update.mockResolvedValueOnce({ changed: 1, errors: [], revertedPatchIds: [] })
    const { actions } = setup()
    await actions.runFileChangeAction(summary(), 'undo')
    update.mockResolvedValueOnce({ changed: 0, errors: [], message: 'No file changes to redo' })
    await actions.runFileChangeAction(summary(), 'redo')
    expect(update.mock.calls.at(-1)?.[4]).toEqual([])
    expect(actions.fileChangeNextAction(summary())).toBe('redo')
    expect(actions.fileChangeActionErrorText(summary())).toBe('No file changes to redo')
  })

  it('retains only actually reverted patches on partial undo and preserves them on failed redo', async () => {
    update.mockResolvedValueOnce({ changed: 1, errors: ['b failed'], revertedPatchIds: ['patch-a'] })
    const { actions } = setup()
    await actions.runFileChangeAction(summary(), 'undo')
    expect(actions.fileChangeNextAction(summary())).toBe('redo')
    update.mockResolvedValueOnce({ changed: 0, errors: ['offline'] })
    await actions.runFileChangeAction(summary(), 'redo')
    expect(actions.fileChangeNextAction(summary())).toBe('redo')
    expect(actions.fileChangeActionErrorText(summary())).toBe('offline')
    await actions.runFileChangeAction(summary(), 'redo')
    expect(update.mock.calls.at(-1)?.[4]).toEqual(['patch-a'])
    expect(actions.fileChangeNextAction(summary())).toBe('undo')
  })
})
