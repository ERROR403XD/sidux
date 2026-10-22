import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcNotification } from '../api/codexRpcClient'
import type { AuthRecoveryState } from '../authRecovery'
import { createThreadPendingRequestController, GLOBAL_SERVER_REQUEST_SCOPE } from './threadPendingRequestController'

const api = vi.hoisted(() => ({ getPendingServerRequests: vi.fn(), replyToServerRequest: vi.fn() }))
vi.mock('../api/runtimeGateway', () => api)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((resolveValue, rejectValue) => { resolve = resolveValue; reject = rejectValue })
  return { promise, resolve, reject }
}

const recovery = (threadId: string, phase: AuthRecoveryState['phase'] = 'started'): AuthRecoveryState => ({ threadId, turnId: 'turn', provider: 'fixture', message: 'fixture recovery', phase })
const request = (id: number, threadId = 'thread', itemId = `item-${id}`) => ({ id, method: 'item/tool/requestUserInput', receivedAtIso: `2026-10-11T10:00:${String(id % 60).padStart(2, '0')}Z`, params: { threadId, itemId } })

function setup() {
  let accountRevision = 0
  const onChanged = vi.fn()
  const setPageError = vi.fn()
  const controller = createThreadPendingRequestController({ getAccountRevision: () => accountRevision, onChanged, setPageError })
  const send = (method: string, params: unknown) => controller.handleNotification({ method, params, atIso: '' } as RpcNotification)
  return { controller, send, onChanged, setPageError,
    switchAccount: () => { accountRevision++; controller.invalidateForAccountChange() },
  }
}

beforeEach(() => { vi.resetAllMocks() })

describe('complete pending server request owner', () => {
  it('exposes a request error, clears it when retrying and resolves it with the request', async () => {
    const test = setup()
    test.send('server/request', request(1))
    api.replyToServerRequest.mockRejectedValueOnce(new Error('HTTP 503'))
    expect(await test.controller.respond({ id: 1, result: { decision: 'accept' } })).toBe(false)
    expect(test.controller.replyErrors.value.get(1)).toBe('HTTP 503')
    expect(test.controller.getRequests('thread')).toHaveLength(1)
    const pending = deferred<void>()
    api.replyToServerRequest.mockImplementationOnce(() => pending.promise)
    const retry = test.controller.respond({ id: 1, result: { decision: 'accept' } })
    expect(test.controller.replyErrors.value.size).toBe(0)
    pending.resolve()
    expect(await retry).toBe(true)
    expect(test.controller.replyErrors.value.size).toBe(0)
    expect(test.controller.getRequests('thread')).toEqual([])
  })

  it.each(['account', 'stop', 'resolved'])('rejects a late reply error after %s', async transition => {
    const test = setup()
    test.send('server/request', request(1))
    const pending = deferred<void>()
    api.replyToServerRequest.mockImplementationOnce(() => pending.promise)
    const responding = test.controller.respond({ id: 1, result: {} })
    if (transition === 'account') test.switchAccount()
    else if (transition === 'stop') test.controller.stop()
    else test.send('server/request/resolved', { id: 1 })
    pending.reject(new Error('late failure'))
    expect(await responding).toBe(false)
    expect(test.controller.replyErrors.value.size).toBe(0)
  })

  it('prunes reply errors when a bridge snapshot drops the request', async () => {
    const test = setup()
    test.send('server/request', request(1))
    api.replyToServerRequest.mockRejectedValueOnce(new Error('HTTP 503'))
    await test.controller.respond({ id: 1, result: {} })
    api.getPendingServerRequests.mockResolvedValueOnce([])
    await test.controller.load()
    expect(test.controller.replyErrors.value.size).toBe(0)
  })
  it('owns reply busy IDs, rejects duplicate submissions and releases only the completed ID', async () => {
    const test = setup()
    const first = deferred<void>()
    const second = deferred<void>()
    api.replyToServerRequest.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const a = test.controller.respond({ id: 1, result: {} })
    const b = test.controller.respond({ id: 2, result: {} })
    expect([...test.controller.replyIds.value]).toEqual([1, 2])
    expect(await test.controller.respond({ id: 1, result: {} })).toBe(false)
    expect(api.replyToServerRequest).toHaveBeenCalledTimes(2)
    first.resolve()
    expect(await a).toBe(true)
    expect([...test.controller.replyIds.value]).toEqual([2])
    second.resolve()
    expect(await b).toBe(true)
    expect(test.controller.replyIds.value.size).toBe(0)
    if (false) {
      // @ts-expect-error readonly ID set
      test.controller.replyIds.value.add(3)
      // @ts-expect-error readonly computed
      test.controller.replyIds.value = new Set()
    }
  })

  it.each(['stop', 'account'])('keeps a current reused ID busy across an old failure after %s', async transition => {
    const test = setup()
    const old = deferred<void>()
    const current = deferred<void>()
    api.replyToServerRequest.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const previous = test.controller.respond({ id: 1, result: {} })
    if (transition === 'account') test.switchAccount()
    else { test.controller.stop(); test.controller.start() }
    const next = test.controller.respond({ id: 1, result: {} })
    old.reject(new Error('old reply failure'))
    expect(await previous).toBe(false)
    expect(test.controller.replyIds.value.has(1)).toBe(true)
    expect(test.setPageError).not.toHaveBeenCalled()
    current.resolve()
    expect(await next).toBe(true)
    expect(test.controller.replyIds.value.has(1)).toBe(false)
  })

  it('does not submit while stopped and releases busy state after a synchronous API failure', async () => {
    const test = setup()
    const isCurrent = test.controller.captureContext()
    test.controller.stop()
    expect(isCurrent()).toBe(false)
    expect(await test.controller.respond({ id: 1, result: {} })).toBe(false)
    expect(api.replyToServerRequest).not.toHaveBeenCalled()
    test.controller.start()
    api.replyToServerRequest.mockImplementationOnce(() => { throw new Error('synchronous reply failure') })
    expect(await test.controller.respond({ id: 1, result: {} })).toBe(false)
    expect(test.controller.replyIds.value.size).toBe(0)
    expect(test.setPageError).toHaveBeenCalledWith('synchronous reply failure')
    api.replyToServerRequest.mockResolvedValueOnce(undefined)
    expect(await test.controller.respond({ id: 1, result: {} })).toBe(true)
  })

  it('clears former-account requests and recovery while preserving same-account stop drafts', () => {
    const test = setup()
    test.send('server/request', request(1))
    test.send('server/request', { id: 2, method: 'unknown', params: null })
    test.controller.setAuthRecovery('thread', recovery('thread'))
    test.controller.stop()
    expect(test.controller.getRequests('thread')[0]?.id).toBe(1)
    test.controller.start()
    test.controller.setAuthRecovery('thread', recovery('thread'))
    test.onChanged.mockClear()
    test.switchAccount()
    expect(test.controller.requestsByThreadId.value).toEqual({})
    expect(test.controller.getAuthRecovery('thread')).toBeNull()
    expect(test.onChanged).toHaveBeenCalledTimes(1)
  })

  it('restores current pending state once after account invalidation without a new ready event', async () => {
    const test = setup()
    const current = deferred<unknown[]>()
    api.getPendingServerRequests.mockImplementation(onAuth => {
      onAuth([recovery('current-thread')])
      return current.promise
    })
    test.send('server/request', request(1))
    test.switchAccount()
    const joined = test.controller.load()
    expect(api.getPendingServerRequests).toHaveBeenCalledTimes(1)
    current.resolve([request(2, 'current-thread')])
    await joined
    expect(test.controller.getRequests('thread')).toEqual([])
    expect(test.controller.getRequests('current-thread')[0]?.id).toBe(2)
    expect(test.controller.getAuthRecovery('current-thread')?.phase).toBe('started')
  })

  it('joins in-flight reads and overlays live additions, resolutions and auth recovery onto the snapshot', async () => {
    const test = setup()
    const pending = deferred<unknown[]>()
    api.getPendingServerRequests.mockImplementation(onAuth => {
      onAuth([recovery('thread'), recovery('resolved-auth')])
      return pending.promise
    })
    const first = test.controller.load()
    expect(test.controller.load()).toBe(first)
    test.send('server/request', request(2))
    test.send('server/request/resolved', { id: 1 })
    test.controller.setAuthRecovery('thread', recovery('thread', 'completed'))
    test.controller.setAuthRecovery('resolved-auth', null)
    pending.resolve([request(1)])
    await first
    expect(api.getPendingServerRequests).toHaveBeenCalledTimes(1)
    expect(test.controller.getRequests('thread').map(row => row.id)).toEqual([2])
    expect(test.controller.getAuthRecovery('thread')?.phase).toBe('completed')
    expect(test.controller.getAuthRecovery('resolved-auth')).toBeNull()
  })

  it.each(['stop', 'account'])('does not let a former %s read commit or release the new read', async transition => {
    const test = setup()
    const old = deferred<unknown[]>()
    const current = deferred<unknown[]>()
    api.getPendingServerRequests.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const previous = test.controller.load()
    if (transition === 'stop') {
      test.controller.stop()
      test.controller.start()
    } else test.switchAccount()
    const next = test.controller.load()
    expect(api.getPendingServerRequests).toHaveBeenCalledTimes(2)
    old.resolve([request(1, 'thread', 'former')])
    await previous
    expect(test.controller.getRequests('thread')).toEqual([])
    expect(test.controller.load()).toBe(next)
    current.resolve([request(1, 'thread', 'current')])
    await next
    expect(test.controller.getRequests('thread')[0]?.itemId).toBe('current')
  })

  it.each(['stop', 'account'])('rejects late reply success and failure after %s without removing a current request', async transition => {
    const test = setup()
    const success = deferred<void>()
    const failure = deferred<void>()
    api.replyToServerRequest.mockReturnValueOnce(success.promise).mockReturnValueOnce(failure.promise)
    test.send('server/request', request(1))
    const oldSuccess = test.controller.respond({ id: 1, result: { accepted: true } })
    const oldFailure = test.controller.respond({ id: 2, result: {} })
    if (transition === 'stop') {
      test.controller.stop()
      test.controller.start()
    } else test.switchAccount()
    test.send('server/request', request(1, 'thread', 'new'))
    success.resolve()
    failure.reject(new Error('former failure'))
    expect(await oldSuccess).toBe(false)
    expect(await oldFailure).toBe(false)
    expect(test.controller.getRequests('thread')[0]?.itemId).toBe('new')
    expect(test.setPageError).not.toHaveBeenCalled()
    expect(api.replyToServerRequest).toHaveBeenCalledTimes(2)
  })

  it('handles current replies without hiding a failed request', async () => {
    const test = setup()
    test.send('server/request', request(1))
    test.send('server/request', request(2))
    api.replyToServerRequest.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('current failure'))
    expect(await test.controller.respond({ id: 1, result: 'accepted' })).toBe(true)
    expect(await test.controller.respond({ id: 2, error: { code: -1, message: 'declined' } })).toBe(false)
    expect(test.controller.getRequests('thread').map(row => row.id)).toEqual([2])
    expect(test.setPageError).toHaveBeenCalledExactlyOnceWith('current failure')
    expect(api.replyToServerRequest).toHaveBeenLastCalledWith(2, { result: undefined, error: { code: -1, message: 'declined' } })
  })

  it.each([
    ['exec_approval_request', { command: ['pwd'] }, 'item/commandExecution/requestApproval'],
    ['apply_patch_approval_request', { grant_root: '/fixture' }, 'item/fileChange/requestApproval'],
    ['request_user_input', { questions: [] }, 'item/tool/requestUserInput'],
    ['elicitation_request', { serverName: 'fixture', message: 'fixture', mode: 'form' }, 'mcpServer/elicitation/request'],
    ['item/permissions/requestApproval', { permissions: {}, turnId: 'turn', itemId: 'item' }, 'item/permissions/requestApproval'],
    ['dynamic_tool_call_request', { toolName: 'fixture' }, 'item/tool/call'],
  ])('normalizes the existing %s alias', (method, params, canonical) => {
    const test = setup()
    test.send('server/request', { id: 1, method, params: { thread_id: 'thread', ...params } })
    expect(test.controller.getRequests('thread')[0]).toMatchObject({ id: 1, threadId: 'thread', method: canonical })
  })

  it('keeps global scope, timestamp order and id-based replacement while pruning retired threads', () => {
    const test = setup()
    test.send('server/request', request(2))
    test.send('server/request', request(1))
    test.send('server/request', request(1, 'thread', 'replacement'))
    test.send('server/request', { id: 3, method: 'unknown', params: null })
    test.send('server/request', request(4, 'retired'))
    test.controller.prune(new Set(['thread']))
    expect(test.controller.getRequests('thread').map(row => [row.id, row.itemId])).toEqual([[1, 'replacement'], [2, 'item-2']])
    expect(test.controller.getRequests(GLOBAL_SERVER_REQUEST_SCOPE)[0]?.id).toBe(3)
    expect(test.controller.getRequests('retired')).toEqual([])
    expect(test.controller.getRequests('')).toEqual([])
    expect(test.send('server/request', { id: 'bad', method: 'unknown' })).toBe(true)
    expect(test.send('unrelated', {})).toBe(false)
  })

  it('derives approval priority without marking async questions as blocking', () => {
    const test = setup()
    test.send('server/request', { id: 1, method: 'item/tool/requestUserInput', params: { threadId: 'thread', isBlocking: false } })
    expect(test.controller.getRequestState('thread')).toBeNull()
    test.send('server/request', { id: 2, method: 'mcpServer/elicitation/request', params: { threadId: 'thread' } })
    expect(test.controller.getRequestState('thread')).toBe('response')
    test.send('server/request', { id: 3, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread' } })
    expect(test.controller.getRequestState('thread')).toBe('approval')
    test.send('server/request/resolved', { id: 3 })
    expect(test.controller.getRequestState('thread')).toBe('response')
  })

  it('preserves requests and recovery on read failure and allows retry after a synchronous API throw', async () => {
    const test = setup()
    test.send('server/request', request(1))
    test.controller.setAuthRecovery('thread', recovery('thread'))
    api.getPendingServerRequests.mockImplementationOnce(() => { throw new Error('fixture read failure') }).mockResolvedValueOnce([request(2)])
    await test.controller.load()
    expect(test.controller.getRequests('thread')[0]?.id).toBe(1)
    expect(test.controller.getAuthRecovery('thread')?.phase).toBe('started')
    await test.controller.load()
    expect(api.getPendingServerRequests).toHaveBeenCalledTimes(2)
    expect(test.controller.getRequests('thread')[0]?.id).toBe(2)
    expect(test.setPageError).not.toHaveBeenCalled()
  })

  it('bounds auth recovery, retains request drafts on stop and rejects stopped notification writes', () => {
    const test = setup()
    test.send('server/request', request(1))
    for (let index = 0; index < 101; index++) test.controller.setAuthRecovery(`thread-${index}`, recovery(`thread-${index}`))
    expect(test.controller.getAuthRecovery('thread-0')).toBeNull()
    expect(test.controller.getAuthRecovery('thread-100')).not.toBeNull()
    test.controller.stop()
    test.send('server/request/resolved', { id: 1 })
    test.send('server/request', request(2))
    expect(test.controller.getRequests('thread').map(row => row.id)).toEqual([1])
    expect(test.controller.getAuthRecovery('thread-100')).toBeNull()
    test.controller.start()
    test.send('server/request/resolved', { id: 1 })
    expect(test.controller.getRequests('thread')).toEqual([])
  })
})
