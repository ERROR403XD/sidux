import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { computed, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UiServerRequestReply } from '../types/codex'
import { createThreadPendingRequestController } from './threadPendingRequestController'

const api = vi.hoisted(() => ({ getPendingServerRequests: vi.fn(), replyToServerRequest: vi.fn() }))
vi.mock('../api/runtimeGateway', () => api)

function deferred() {
  let resolve!: () => void
  let reject!: (cause: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

type ReplyContextPort = { captureContext?: () => () => boolean; replyIds?: Readonly<{ value: ReadonlySet<number> }> }

// Execute the real App handler with its domain ports; do not duplicate its busy/follow-up policy.
function composeAppHandler(ports: Record<string, unknown>): {
  handleServerRequestResponse: (payload: UiServerRequestReply) => Promise<void>
  pendingReplyIds: Readonly<{ value: ReadonlySet<number> }>
} {
  const app = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
  const script = app.slice(app.indexOf('<script setup lang="ts">') + '<script setup lang="ts">'.length, app.indexOf('</script>'))
  const source = ts.createSourceFile('App.ts', script, ts.ScriptTarget.Latest, true)
  const handler = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'handleServerRequestResponse')
  const busy = source.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === 'pendingReplyIds'))
  if (!handler) throw new Error('App reply handler missing')
  const factory = `export function compose(ports: any) {
    const { ref, selectedThreadServerRequests, respondToPendingServerRequest, isHomeRoute,
      selectedThreadId, sendMessageToSelectedThread, capturePendingReplyContext${busy ? '' : ', pendingReplyIds'} } = ports
    ${busy?.getText(source) ?? ''}
    ${handler.getText(source)}
    return { handleServerRequestResponse, pendingReplyIds }
  }`
  const output = ts.transpileModule(factory, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: { compose?: (ports: Record<string, unknown>) => ReturnType<typeof composeAppHandler> } = {}
  new Function('exports', output)(exports)
  return exports.compose!(ports)
}

function setup() {
  let accountRevision = 0
  const pageError = vi.fn()
  const controller = createThreadPendingRequestController({ getAccountRevision: () => accountRevision, onChanged: vi.fn(), setPageError: pageError })
  const contextPort = controller as typeof controller & ReplyContextPort
  const selectedThreadId = ref('thread')
  const send = vi.fn(async () => {})
  const app = composeAppHandler({
    ref,
    selectedThreadServerRequests: computed(() => controller.getRequests(selectedThreadId.value)),
    respondToPendingServerRequest: controller.respond,
    isHomeRoute: ref(false), selectedThreadId, sendMessageToSelectedThread: send,
    capturePendingReplyContext: () => contextPort.captureContext?.() ?? (() => true),
    pendingReplyIds: contextPort.replyIds ?? computed(() => new Set<number>()),
  })
  const request = (itemId: string) => controller.handleNotification({ method: 'server/request', atIso: '',
    params: { id: 1, method: 'item/tool/requestUserInput', params: { threadId: 'thread', itemId } } })
  return { controller, app, send, request, pageError,
    transition: (kind: string) => {
      if (kind === 'account') { accountRevision++; controller.invalidateForAccountChange() }
      else { controller.stop(); controller.start() }
    },
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  api.getPendingServerRequests.mockResolvedValue([])
})

describe('App and pending reply composition', () => {
  it.each(['stop', 'account'])('allows a current reused ID after %s and keeps its busy state across an old completion', async kind => {
    const test = setup()
    const old = deferred()
    const current = deferred()
    api.replyToServerRequest.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    test.request('old')
    const oldReply = test.app.handleServerRequestResponse({ id: 1, result: {}, followUpMessageText: 'old follow-up' })
    test.transition(kind)
    test.request('current')
    const currentReply = test.app.handleServerRequestResponse({ id: 1, result: {}, followUpMessageText: 'current follow-up' })
    expect(api.replyToServerRequest).toHaveBeenCalledTimes(2)
    old.resolve()
    await oldReply
    expect(test.app.pendingReplyIds.value.has(1)).toBe(true)
    await test.app.handleServerRequestResponse({ id: 1, result: {} })
    expect(api.replyToServerRequest).toHaveBeenCalledTimes(2)
    expect(test.send).not.toHaveBeenCalled()
    current.resolve()
    await currentReply
    expect(test.app.pendingReplyIds.value.has(1)).toBe(false)
    expect(test.send).toHaveBeenCalledExactlyOnceWith('current follow-up', [], [], 'steer', [])
  })

  it('does not send a follow-up if context changes between domain acknowledgement and App continuation', async () => {
    const test = setup()
    const pending = deferred()
    api.replyToServerRequest.mockReturnValueOnce(pending.promise)
    test.request('old')
    const reply = test.app.handleServerRequestResponse({ id: 1, result: {}, followUpMessageText: 'old follow-up' })
    pending.resolve()
    await Promise.resolve()
    test.transition('account')
    await reply
    expect(test.send).not.toHaveBeenCalled()
  })

  it('prevents duplicate current replies and sends one current follow-up', async () => {
    const test = setup()
    const pending = deferred()
    api.replyToServerRequest.mockReturnValueOnce(pending.promise)
    test.request('current')
    const first = test.app.handleServerRequestResponse({ id: 1, result: {}, followUpMessageText: 'current follow-up' })
    await test.app.handleServerRequestResponse({ id: 1, result: {}, followUpMessageText: 'duplicate' })
    expect(api.replyToServerRequest).toHaveBeenCalledTimes(1)
    pending.resolve()
    await first
    expect(test.send).toHaveBeenCalledTimes(1)
    expect(test.app.pendingReplyIds.value.has(1)).toBe(false)
  })
})
