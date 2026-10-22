import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as vue from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversationScrollState } from './useConversationScrollState'
import { useConversationViewport } from './useConversationViewport'
import type { UiLiveOverlay, UiMessage, UiServerRequest } from '../types/codex'

const scopes: vue.EffectScope[] = []
let frames: Map<number, FrameRequestCallback>
function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function setup(initialMessages?: UiMessage[]) {
  const earlier = vi.fn(async (_threadId: string): Promise<void> => undefined)
  const props = vue.reactive({
    messages: initialMessages ?? [{ id: 'message', text: 'text', role: 'assistant' }] as UiMessage[],
    pendingRequests: [] as UiServerRequest[], liveOverlay: null as UiLiveOverlay | null,
    activeThreadId: 'thread-a', cwd: '/fixture/a', accountRevision: 0, isLoading: false,
    hasMorePersistedAbove: true, isLoadingPersistedAbove: false, loadEarlierMessages: earlier,
  })
  const container = { scrollTop: 320, scrollHeight: 1000, clientHeight: 500, querySelectorAll: () => [] }
  const dependencies = {
    ...vue, props, useConversationScrollState, useConversationViewport,
    conversationListRef: vue.ref<HTMLElement | null>(container as unknown as HTMLElement), bottomAnchorRef: vue.ref({ scrollIntoView: vi.fn() }),
    modalImageUrl: vue.ref(''), autoFollowOutput: vue.ref(true),
    onScrollState: { reset: () => undefined },
    scheduleConversationScroll: async () => undefined,
    clearRenderCaches: () => undefined, copyAttempt: 0, copiedMessageResetTimer: null,
    fileChangeActions: { stop: () => undefined },
    onWindowPointerDownForFileLinkContextMenu: () => undefined,
    onWindowBlurForFileLinkContextMenu: () => undefined, onWindowKeydownForFileLinkContextMenu: () => undefined,
  }
  const file = readFileSync(process.env.CONVERSATION_VIEWPORT_SOURCE || new URL('../components/content/ThreadConversation.vue', import.meta.url), 'utf8')
  const script = file.split('<script setup lang="ts">')[1]!.split('</script>')[0]!
  const source = ts.createSourceFile('conversation.ts', script, ts.ScriptTarget.Latest, true)
  const assembly = source.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(row =>
    row.initializer && ts.isCallExpression(row.initializer) && row.initializer.expression.getText(source) === 'useConversationViewport',
  ))
  const variables = /^(?:RENDER_WINDOW_SIZE|LOAD_MORE_\w+|renderWindowStart|isLoadingMore|historyLoad\w+|visibleMessages|hasMoreAbove|conversationViewportStopped)$/
  const statements = source.statements.filter(node => {
    if (ts.isVariableStatement(node)) return node.declarationList.declarations.some(row => variables.test(row.name.getText(source)))
    if (ts.isFunctionDeclaration(node)) return ['loadMoreAbove', 'onConversationScroll'].includes(node.name?.text || '')
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const name = node.expression.expression.getText(source)
      return name === 'watch' && /props\.activeThreadId/.test(node.getText(source)) && !/resetFileChangeActions|resetFilePresentation/.test(node.getText(source))
        || name === 'onScopeDispose' && /historyLoad|conversationViewport/.test(node.getText(source))
    }
    return false
  }).map(node => node.getText(source)).join('\n')
  const code = ts.transpile(assembly ? assembly.getText(source) + '\nreturn viewport;' : statements + '\nreturn { visibleMessages, hasMoreAbove, isLoadingMore, historyLoadError, loadMoreAbove };', { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None })
  const names = Object.keys(dependencies).filter(name => /^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default')
  const scope = vue.effectScope()
  scopes.push(scope)
  const state = scope.run(() => new Function(...names, code)(...names.map(name => dependencies[name as keyof typeof dependencies])))! as ReturnType<typeof useConversationViewport>
  return { props, state, container, earlier, scope, containerRef: dependencies.conversationListRef }
}

beforeEach(() => {
  frames = new Map()
  let nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('window', { removeEventListener: vi.fn() })
})
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); vi.unstubAllGlobals() })

describe('real Conversation history request lifecycle', () => {
  it('bounds a cached initial message list before any loading or message watch fires', () => {
    const { state } = setup(Array.from({ length: 100 }, (_, i) => ({ id: String(i), role: 'assistant', text: String(i) })))
    expect(state.visibleMessages.value.length).toBe(50)
    expect(state.visibleMessages.value[0]?.id).toBe('50')
  })

  it('initializes scrolling for mounted cached refs without a loading transition', async () => {
    const { container, earlier, containerRef } = setup()
    await vue.nextTick()
    expect(frames.size).toBe(1)
    const callbacks = [...frames.values()]
    frames.clear()
    callbacks.forEach(callback => callback(0))
    expect(container.scrollTop).toBe(1000)
    containerRef.value = null
    expect(frames.size).toBe(0)
    containerRef.value = container as unknown as HTMLElement
    await vue.nextTick()
    expect(frames.size).toBe(1)
    expect(earlier).not.toHaveBeenCalled()
  })

  it('preserves the prepend anchor and prevents duplicate requests', async () => {
    const waiting = deferred()
    const { earlier, state, container } = setup()
    earlier.mockReturnValueOnce(waiting.promise)
    const loading = state.loadMoreAbove()
    await state.loadMoreAbove()
    expect(earlier).toHaveBeenCalledExactlyOnceWith('thread-a')
    container.scrollHeight += 200
    waiting.resolve()
    await loading
    expect(container.scrollTop).toBe(520)
    expect(state.isLoadingMore.value).toBe(false)
  })

  it('keeps a newer jump position when an earlier history request finishes', async () => {
    const waiting = deferred()
    const { earlier, state, container } = setup()
    earlier.mockReturnValueOnce(waiting.promise)
    const loading = state.loadMoreAbove()
    state.jumpToLatest()
    const jumpTop = container.scrollTop
    container.scrollHeight += 200
    waiting.resolve()
    await loading
    expect(container.scrollTop).toBe(jumpTop)
    expect(state.isLoadingMore.value).toBe(false)
  })

  for (const identity of ['thread', 'cwd', 'account'] as const) {
    it(`invalidates an old page synchronously across ${identity} A to B to A`, async () => {
      const waiting = deferred()
      const { props, earlier, state, container } = setup()
      earlier.mockReturnValueOnce(waiting.promise)
      const loading = state.loadMoreAbove()
      if (identity === 'thread') { props.activeThreadId = 'thread-b'; props.activeThreadId = 'thread-a' }
      if (identity === 'cwd') { props.cwd = '/fixture/b'; props.cwd = '/fixture/a' }
      if (identity === 'account') { props.accountRevision = 1; props.accountRevision = 0 }
      expect(state.isLoadingMore.value).toBe(false)
      container.scrollTop = 77
      container.scrollHeight += 500
      waiting.resolve()
      await loading
      expect(container.scrollTop).toBe(77)
      expect(state.historyLoadError.value).toBe('')
    })
  }

  it.each(['success', 'error'])('ignores a late %s after scope disposal', async outcome => {
    const waiting = deferred()
    const { earlier, state, container, scope } = setup()
    earlier.mockReturnValueOnce(waiting.promise)
    const loading = state.loadMoreAbove()
    scope.stop()
    container.scrollHeight += 500
    if (outcome === 'success') waiting.resolve()
    else waiting.reject(new Error('old history failure'))
    await loading
    expect(container.scrollTop).toBe(320)
    expect(state.historyLoadError.value).toBe('')
    await state.loadMoreAbove()
    expect(earlier).toHaveBeenCalledTimes(1)
  })

  it('does not let an old request clear the loading flag or error of a new identity', async () => {
    const old = deferred()
    const current = deferred()
    const { props, earlier, state } = setup()
    earlier.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const first = state.loadMoreAbove()
    props.accountRevision += 1
    const second = state.loadMoreAbove()
    old.reject(new Error('old account failure'))
    await first
    expect(state.isLoadingMore.value).toBe(true)
    expect(state.historyLoadError.value).toBe('')
    current.resolve()
    await second
    expect(state.isLoadingMore.value).toBe(false)
  })

  it('does not restore a detached container and still releases the current loading flag', async () => {
    const waiting = deferred()
    const { earlier, state, container, containerRef } = setup()
    earlier.mockReturnValueOnce(waiting.promise)
    const loading = state.loadMoreAbove()
    containerRef.value = null
    container.scrollHeight += 500
    waiting.resolve()
    await loading
    expect(container.scrollTop).toBe(320)
    expect(state.isLoadingMore.value).toBe(false)
  })

  it('retains a genuine error, suppresses scroll retries, and allows an explicit retry', async () => {
    const { earlier, state, container } = setup()
    earlier.mockRejectedValueOnce(new Error('offline'))
    await state.loadMoreAbove()
    expect(state.historyLoadError.value).toBe('offline')
    container.scrollTop = 100
    state.onConversationScroll()
    expect(earlier).toHaveBeenCalledTimes(1)
    await state.loadMoreAbove()
    expect(earlier).toHaveBeenCalledTimes(2)
    expect(state.historyLoadError.value).toBe('')
  })

  it('respects external pagination busy state and the absence of older history', async () => {
    const { props, earlier, state } = setup()
    props.isLoadingPersistedAbove = true
    await state.loadMoreAbove()
    props.isLoadingPersistedAbove = false
    props.hasMorePersistedAbove = false
    await state.loadMoreAbove()
    expect(earlier).not.toHaveBeenCalled()
  })

  it('owns the bounded following window and reveals local history without requests or message copies', async () => {
    const { props, state, earlier, container } = setup()
    props.messages = Array.from({ length: 100 }, (_, i) => ({ id: String(i), role: 'assistant', text: String(i) }))
    await vue.nextTick()
    expect(state.visibleMessages.value.length).toBe(50)
    expect(vue.toRaw(state.visibleMessages.value[0]!)).toBe(vue.toRaw(props.messages[50]!))
    container.scrollTop = 320
    state.onConversationScroll()
    await state.loadMoreAbove()
    expect(state.visibleMessages.value.length).toBe(80)
    expect(earlier).not.toHaveBeenCalled()
    state.jumpToLatest()
    expect(state.visibleMessages.value.length).toBe(50)
    container.scrollTop = 320
    state.onConversationScroll()
    await state.loadMoreAbove()
    expect(state.visibleMessages.value.length).toBe(80)
    props.messages = props.messages.slice(0, 5)
    await vue.nextTick()
    expect(state.visibleMessages.value.length).toBe(1)
    state.jumpToLatest()
    props.messages = [...props.messages, { id: 'new', role: 'assistant', text: 'new' }]
    await vue.nextTick()
    expect(state.visibleMessages.value.length).toBe(6)
  })

  it('stops all watches and further commands without reviving animation frames', async () => {
    const { state, props, container } = setup()
    props.accountRevision += 1
    await vue.nextTick()
    expect(frames.size).toBe(1)
    state.stop()
    state.stop()
    props.cwd = '/fixture/new'
    props.messages = [...props.messages]
    container.scrollTop = 100
    state.onConversationScroll()
    state.jumpToLatest()
    await vue.nextTick()
    expect(frames.size).toBe(0)
    expect(container.scrollTop).toBe(100)
  })

  it('does not let an overlay nextTick override a user who just scrolled away', async () => {
    const { props, state, container } = setup()
    props.liveOverlay = { activityLabel: 'Writing', activityDetails: [], reasoningText: '', errorText: '' }
    await vue.nextTick()
    container.scrollTop = 320
    state.onConversationScroll()
    await vue.nextTick()
    expect(container.scrollTop).toBe(320)
    const callbacks = [...frames.values()]
    frames.clear()
    callbacks.forEach(callback => callback(0))
    expect(container.scrollTop).toBe(320)
    expect(frames.size).toBe(0)
  })

  it('does not resume an overlay continuation after identity reset or disposal', async () => {
    const { props, state, container } = setup()
    props.liveOverlay = { activityLabel: 'Writing', activityDetails: [], reasoningText: '', errorText: '' }
    await vue.nextTick()
    props.accountRevision += 1
    state.stop()
    await vue.nextTick()
    expect(container.scrollTop).toBe(320)
    expect(frames.size).toBe(0)
  })

  it('coalesces message and pending-request notifications into one scroll frame', async () => {
    const { props } = setup()
    props.messages = [...props.messages]
    props.pendingRequests = [{ id: 1, method: 'approval', threadId: 'thread-a', turnId: 'turn', itemId: 'item', receivedAtIso: '', params: {} }]
    await vue.nextTick()
    await vue.nextTick()
    expect(frames.size).toBe(1)
  })
})
