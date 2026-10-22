import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

type SubmitPayload = { text: string; imageUrls: string[]; fileAttachments: []; skills: []; mode: 'queue'; complete: (saved: boolean) => void }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

// Exercise the actual App continuations instead of reproducing their completion policy.
function composeApp(ports: Record<string, unknown>): {
  onSubmitThreadMessage: (payload: SubmitPayload) => void
  submitFirstMessageForNewThread: (text: string) => Promise<boolean>
} {
  const app = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
  const script = app.slice(app.indexOf('<script setup lang="ts">') + '<script setup lang="ts">'.length, app.indexOf('</script>'))
  const source = ts.createSourceFile('App.ts', script, ts.ScriptTarget.Latest, true)
  const names = ['onSubmitThreadMessage', 'submitFirstMessageForNewThread', 'runNewThreadSubmission']
  const handlers = names.map(name => {
    const node = source.statements.find(row => ts.isFunctionDeclaration(row) && row.name?.text === name)
    if (!node) throw new Error(`App handler missing: ${name}`)
    return node.getText(source)
  })
  const factory = `export function compose(ports: any) {
    const { ${Object.keys(ports).join(', ')} } = ports
    ${handlers.join('\n')}
    return { onSubmitThreadMessage, submitFirstMessageForNewThread }
  }`
  const output = ts.transpileModule(factory, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: { compose?: (value: typeof ports) => ReturnType<typeof composeApp> } = {}
  new Function('exports', output)(exports)
  return exports.compose!(ports)
}

function setup() {
  let revision = 0
  const ports = {
    captureThreadSendContext: () => { const captured = revision; return () => captured === revision },
    selectedThreadId: ref('thread'), composerThreadContextId: ref('thread'), isHomeRoute: ref(false),
    editingQueuedMessageState: ref<null | { threadId: string; messageId: string; revision: number; editToken: string }>(null),
    queueDraftError: ref(''), saveQueueDraftEdit: vi.fn(),
    scheduleMobileConversationJumpToLatest: vi.fn(), updateQueuedMessage: vi.fn(), sendMessageToSelectedThread: vi.fn(),
    newThreadSendError: ref(''), withNewThreadWatchdog: (work: Promise<boolean>) => work,
    newThreadFailureMessage: (cause: Error) => cause.message,
    notifyOperation: vi.fn(), t: (value: string) => value,
    router: { replace: vi.fn(async () => {}) }, nextTick: async () => {},
    threadComposerRef: ref({ hydrateDraft: vi.fn() }),
    worktreeInitStatus: ref({ phase: 'idle', title: '', message: '' }),
    newThreadCwd: ref('/project'), newThreadRuntime: ref('local'), newWorktreeBaseBranch: ref('main'),
    createWorktree: vi.fn(), isVirtualProjectId: () => false,
    createProjectlessThreadDirectory: vi.fn(), invalidateWorkspaceRootsStateCache: vi.fn(), sendMessageToNewThread: vi.fn(),
  }
  const app = composeApp(ports)
  const payload = (): SubmitPayload => ({ text: 'old draft', imageUrls: [], fileAttachments: [], skills: [], mode: 'queue', complete: vi.fn() })
  return { ports, app, payload, transition: () => { revision++ } }
}

describe('App send continuation context', () => {
  it.each(['saved', 'failed', 'edit'])('keeps the current draft and error after an old %s completion', async action => {
    const test = setup()
    const save = deferred<void>()
    test.ports.sendMessageToSelectedThread.mockReturnValue(save.promise)
    test.ports.updateQueuedMessage.mockReturnValue(save.promise)
    if (action === 'edit') test.ports.editingQueuedMessageState.value = { threadId: 'thread', messageId: 'edit', revision: 1, editToken: 'token' }
    const payload = test.payload()
    test.app.onSubmitThreadMessage(payload)
    test.transition()
    test.ports.queueDraftError.value = 'current error'
    if (action === 'failed') save.reject(new Error('old error'))
    else save.resolve()
    await save.promise.catch(() => {})
    await Promise.resolve()
    expect(payload.complete).toHaveBeenCalledExactlyOnceWith(false)
    expect(test.ports.saveQueueDraftEdit).not.toHaveBeenCalled()
    expect(test.ports.queueDraftError.value).toBe('current error')
  })

  it('acknowledges the submitted source after navigation so its revision can be cleared', async () => {
    const test = setup()
    const save = deferred<void>()
    test.ports.sendMessageToSelectedThread.mockReturnValue(save.promise)
    const payload = test.payload()
    test.app.onSubmitThreadMessage(payload)
    test.ports.selectedThreadId.value = 'other'
    test.ports.composerThreadContextId.value = 'other'
    save.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(payload.complete).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('acknowledges a current saved draft once', async () => {
    const test = setup()
    const save = deferred<void>()
    test.ports.sendMessageToSelectedThread.mockReturnValue(save.promise)
    const payload = test.payload()
    test.app.onSubmitThreadMessage(payload)
    save.resolve()
    await vi.waitFor(() => expect(payload.complete).toHaveBeenCalledExactlyOnceWith(true))
  })

  it('acknowledges an accepted new conversation without navigating back after the user leaves', async () => {
    const test = setup()
    test.ports.isHomeRoute.value = true
    const send = deferred<string>()
    test.ports.sendMessageToNewThread.mockReturnValue(send.promise)
    const submitting = test.app.submitFirstMessageForNewThread('sent')
    test.ports.isHomeRoute.value = false
    send.resolve('created')
    expect(await submitting).toBe(true)
    expect(test.ports.router.replace).not.toHaveBeenCalled()
  })

  it.each(['success', 'failure'])('does not navigate or report an old new-thread %s', async result => {
    const test = setup()
    test.ports.isHomeRoute.value = true
    const send = deferred<string>()
    test.ports.sendMessageToNewThread.mockReturnValue(send.promise)
    const submitting = test.app.submitFirstMessageForNewThread('old')
    test.transition()
    test.ports.newThreadSendError.value = 'current error'
    if (result === 'success') send.resolve('old-created')
    else send.reject(Object.assign(new Error('old error'), { createdThreadId: 'old-created' }))
    expect(await submitting).toBe(false)
    expect(test.ports.router.replace).not.toHaveBeenCalled()
    expect(test.ports.notifyOperation).not.toHaveBeenCalled()
    expect(test.ports.newThreadSendError.value).toBe('current error')
  })

  it.each(['directory', 'worktree'])('does not start a thread after an old %s preparation', async kind => {
    const test = setup()
    test.ports.isHomeRoute.value = true
    const prepare = deferred<{ cwd: string }>()
    if (kind === 'directory') {
      test.ports.newThreadCwd.value = ''
      test.ports.createProjectlessThreadDirectory.mockReturnValue(prepare.promise)
    } else {
      test.ports.newThreadRuntime.value = 'worktree'
      test.ports.createWorktree.mockReturnValue(prepare.promise)
    }
    const submitting = test.app.submitFirstMessageForNewThread('old')
    test.transition()
    prepare.resolve({ cwd: '/old-created' })
    expect(await submitting).toBe(false)
    expect(test.ports.sendMessageToNewThread).not.toHaveBeenCalled()
    if (kind === 'worktree') expect(test.ports.newThreadCwd.value).toBe('/project')
  })
})
