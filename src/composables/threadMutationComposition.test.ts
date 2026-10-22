import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

// Extract the actual App handlers so routing and feedback continuations remain covered.
function composeApp(ports: Record<string, unknown>): {
  onForkThread: (threadId: string) => Promise<void>
  onForkThreadFromMessage: (payload: { threadId: string; turnId: string }) => Promise<void>
  onRollback: (payload: { turnId: string }) => Promise<void>
} {
  const app = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
  const script = app.slice(app.indexOf('<script setup lang="ts">') + '<script setup lang="ts">'.length, app.indexOf('</script>'))
  const source = ts.createSourceFile('App.ts', script, ts.ScriptTarget.Latest, true)
  const names = ['onForkThread', 'onForkThreadFromMessage', 'onRollback']
  const handlers = names.map(name => {
    const node = source.statements.find(row => ts.isFunctionDeclaration(row) && row.name?.text === name)
    if (!node) throw new Error(`App handler missing: ${name}`)
    return node.getText(source)
  })
  const factory = `export function compose(ports: any) {
    const { ${Object.keys(ports).join(', ')} } = ports
    ${handlers.join('\n')}
    return { onForkThread, onForkThreadFromMessage, onRollback }
  }`
  const output = ts.transpileModule(factory, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: { compose?: (value: typeof ports) => ReturnType<typeof composeApp> } = {}
  new Function('exports', output)(exports)
  return exports.compose!(ports)
}

function setup() {
  let revision = 0
  const ports = {
    captureThreadActionContext: () => { const captured = revision; return () => captured === revision },
    selectedThreadId: ref('source'), isHomeRoute: ref(false), isMobile: ref(true),
    route: { fullPath: '/thread/source' }, routeThreadId: ref('source'),
    router: { push: vi.fn().mockResolvedValue(undefined), replace: vi.fn().mockResolvedValue(undefined) },
    forkThreadById: vi.fn(), forkThreadFromTurn: vi.fn(), selectThread: vi.fn(),
    desktopError: ref(''), threadHistoryActionError: ref(''),
    notifyOperation: vi.fn(), setSidebarCollapsed: vi.fn(),
    rollbackSelectedThread: vi.fn(),
    filteredMessages: ref([{ id: 'old', role: 'user' as const, text: 'Old draft', turnId: 'turn' }]),
    threadComposerRef: ref({ appendTextToDraft: vi.fn() }),
  }
  return { ports, app: composeApp(ports), transition: () => { revision++ } }
}

describe('App fork continuations', () => {
  it.each(['fork', 'fork-turn'])('routes and reports a current %s once', async action => {
    const test = setup()
    const finish = async () => {
      test.ports.selectedThreadId.value = 'forked'
      return 'forked'
    }
    test.ports.forkThreadById.mockImplementation(finish)
    test.ports.forkThreadFromTurn.mockImplementation(finish)
    test.ports.router.push.mockImplementation(async () => {
      test.ports.route.fullPath = '/thread/forked'
      test.ports.routeThreadId.value = 'forked'
    })
    if (action === 'fork') await test.app.onForkThread('source')
    else await test.app.onForkThreadFromMessage({ threadId: 'source', turnId: 'turn' })
    expect(test.ports.router.push).toHaveBeenCalledExactlyOnceWith({ name: 'thread', params: { threadId: 'forked' } })
    expect(test.ports.notifyOperation).toHaveBeenCalledExactlyOnceWith('分支已创建', 'success', 'forked')
    expect(test.ports.setSidebarCollapsed).toHaveBeenCalledExactlyOnceWith(true)
    expect(test.ports.selectThread).not.toHaveBeenCalled()
  })

  it.each(['fork', 'fork-turn'])('ignores old %s success after an account transition', async action => {
    const test = setup()
    const result = deferred<string>()
    test.ports.forkThreadById.mockReturnValue(result.promise)
    test.ports.forkThreadFromTurn.mockReturnValue(result.promise)
    const operation = action === 'fork' ? test.app.onForkThread('source') : test.app.onForkThreadFromMessage({ threadId: 'source', turnId: 'turn' })
    test.transition()
    result.resolve('old-fork')
    await operation
    expect(test.ports.router.push).not.toHaveBeenCalled()
    expect(test.ports.notifyOperation).not.toHaveBeenCalled()
    expect(test.ports.selectThread).not.toHaveBeenCalled()
  })

  it.each(['fork', 'fork-turn'])('ignores old %s cancellation without reporting a current error', async action => {
    const test = setup()
    const result = deferred<string>()
    test.ports.forkThreadById.mockReturnValue(result.promise)
    test.ports.forkThreadFromTurn.mockReturnValue(result.promise)
    const operation = action === 'fork' ? test.app.onForkThread('source') : test.app.onForkThreadFromMessage({ threadId: 'source', turnId: 'turn' })
    test.transition()
    test.ports.threadHistoryActionError.value = 'Current error'
    result.resolve('')
    await operation
    expect(test.ports.notifyOperation).not.toHaveBeenCalled()
    expect(test.ports.threadHistoryActionError.value).toBe('Current error')
  })

  it.each(['fork', 'fork-turn'])('does not change the current route after navigating during %s', async action => {
    const test = setup()
    const result = deferred<string>()
    test.ports.forkThreadById.mockReturnValue(result.promise)
    test.ports.forkThreadFromTurn.mockReturnValue(result.promise)
    const operation = action === 'fork' ? test.app.onForkThread('source') : test.app.onForkThreadFromMessage({ threadId: 'source', turnId: 'turn' })
    test.ports.route.fullPath = '/settings'
    test.ports.selectedThreadId.value = 'other'
    result.resolve('old-fork')
    await operation
    expect(test.ports.router.push).not.toHaveBeenCalled()
    expect(test.ports.notifyOperation).not.toHaveBeenCalled()
  })

  it.each(['fork', 'fork-turn'])('does not report success or reselect after a superseded %s router wait', async action => {
    const test = setup()
    const route = deferred<void>()
    test.ports.forkThreadById.mockResolvedValue('forked')
    test.ports.forkThreadFromTurn.mockResolvedValue('forked')
    test.ports.router.push.mockReturnValue(route.promise)
    const operation = action === 'fork' ? test.app.onForkThread('source') : test.app.onForkThreadFromMessage({ threadId: 'source', turnId: 'turn' })
    test.ports.selectedThreadId.value = 'forked'
    await vi.waitFor(() => expect(test.ports.router.push).toHaveBeenCalledOnce())
    test.ports.selectedThreadId.value = 'other'
    test.ports.route.fullPath = '/thread/other'
    test.ports.routeThreadId.value = 'other'
    route.resolve()
    await operation
    expect(test.ports.notifyOperation).not.toHaveBeenCalled()
    expect(test.ports.setSidebarCollapsed).not.toHaveBeenCalled()
    expect(test.ports.selectThread).not.toHaveBeenCalled()
  })
})

describe('App rollback continuations', () => {
  it('restores the current rollback draft exactly once', async () => {
    const test = setup()
    test.ports.rollbackSelectedThread.mockResolvedValueOnce(true)
    await test.app.onRollback({ turnId: 'turn' })
    expect(test.ports.threadComposerRef.value.appendTextToDraft).toHaveBeenCalledExactlyOnceWith('Old draft')
    expect(test.ports.threadHistoryActionError.value).toBe('')
  })

  it.each([true, false])('ignores an old rollback completion of %s for the same conversation ID on another account', async success => {
    const test = setup()
    const result = deferred<boolean>()
    test.ports.rollbackSelectedThread.mockReturnValueOnce(result.promise)
    const operation = test.app.onRollback({ turnId: 'turn' })
    test.transition()
    test.ports.threadHistoryActionError.value = 'Current error'
    result.resolve(success)
    await operation
    expect(test.ports.threadComposerRef.value.appendTextToDraft).not.toHaveBeenCalled()
    expect(test.ports.threadHistoryActionError.value).toBe('Current error')
  })
})
