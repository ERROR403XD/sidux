import { expect, it, vi } from 'vitest'
import { ConversationCreationError, createConversationCreationService } from './conversationCreationService.js'

function fixture() {
  const rpc = vi.fn(async (method: string, _params: unknown): Promise<unknown> => method === 'thread/start'
    ? { thread: { id: 'new-thread' }, model: 'default-model', reasoningEffort: 'medium' }
    : {})
  const deliveryContext = vi.fn(async () => 'original-account-context')
  const submit = vi.fn(async (_input: unknown): Promise<Record<string, unknown>> => ({ status: 'accepted', turnId: 'native-turn' }))
  const resolveProject = vi.fn(async (_project: string, _command: string) => '/tmp/project')
  const isIdentityChanging = vi.fn(() => false)
  const assertActive = vi.fn()
  const create = createConversationCreationService({ rpc, deliveryContext, submit, resolveProject, isIdentityChanging })
  return { create, rpc, deliveryContext, submit, resolveProject, isIdentityChanging, assertActive }
}

it('preserves the exact command and snapshots explicit model and reasoning for native start and durable delivery', async () => {
  const test = fixture()
  const command = '执行 "验证"\n保留换行与 {{模板}}'
  const result = await test.create({ project: '/tmp/project', command, model: 'provider/model', reasoningEffort: 'ultra' }, test.assertActive)
  expect(test.rpc).toHaveBeenNthCalledWith(1, 'thread/start', { cwd: '/tmp/project', model: 'provider/model', config: { model_reasoning_effort: 'ultra' } })
  expect(test.rpc).toHaveBeenNthCalledWith(2, 'thread/name/set', { threadId: 'new-thread', name: '执行 "验证"' })
  expect(test.submit).toHaveBeenCalledExactlyOnceWith({
    protocol: 2, threadId: 'new-thread', expectedContextId: 'original-account-context',
    message: { id: result.messageId, text: command, model: 'provider/model', effort: 'ultra' },
    params: { threadId: 'new-thread', model: 'provider/model', effort: 'ultra', input: [{ type: 'text', text: command }] },
  })
  expect(result).toMatchObject({ object: 'conversation', threadId: 'new-thread', status: 'accepted', turnId: 'native-turn', url: '/#/thread/new-thread' })
  expect(test.rpc).toHaveBeenCalledTimes(2)
  expect(test.deliveryContext).toHaveBeenCalledOnce()
})

it('takes omitted settings from the newly created native thread and keeps creation working when naming fails', async () => {
  const test = fixture()
  test.rpc.mockImplementation(async method => {
    if (method === 'thread/name/set') throw new Error('optional naming unavailable')
    return { thread: { id: 'new-thread' }, model: 'native-default', reasoningEffort: 'max' }
  })
  const result = await test.create({ project: '/tmp/project', command: '检查项目' }, test.assertActive)
  expect(test.rpc).toHaveBeenNthCalledWith(1, 'thread/start', { cwd: '/tmp/project' })
  expect(result).toMatchObject({ model: 'native-default', reasoningEffort: 'max', status: 'accepted' })
  expect(test.submit.mock.calls[0]![0]).toMatchObject({ message: { model: 'native-default', effort: 'max' }, params: { model: 'native-default', effort: 'max' } })
})

it.each([
  null, [], {}, { project: 'relative', command: 'run' }, { project: '/tmp/project', command: '  ' },
  { project: '/tmp/project', command: 42 }, { project: '/tmp/project', command: 'run', model: {} },
  { project: '/tmp/project', command: 'run', reasoningEffort: '\ninvalid' },
])('rejects invalid input before filesystem, runtime or delivery work: %j', async input => {
  const test = fixture()
  await expect(test.create(input, test.assertActive)).rejects.toMatchObject({ status: 400 })
  expect(test.resolveProject).not.toHaveBeenCalled()
  expect(test.rpc).not.toHaveBeenCalled()
  expect(test.deliveryContext).not.toHaveBeenCalled()
  expect(test.submit).not.toHaveBeenCalled()
})

it('rejects account changes and cancellation before creating a native thread', async () => {
  const test = fixture()
  test.isIdentityChanging.mockReturnValue(true)
  await expect(test.create({ project: '/tmp/project', command: 'run' }, test.assertActive)).rejects.toMatchObject({ code: 'account_busy', status: 409 })
  expect(test.resolveProject).not.toHaveBeenCalled()
  test.isIdentityChanging.mockReturnValue(false)
  test.deliveryContext.mockImplementation(async () => {
    test.assertActive.mockImplementation(() => { throw new Error('cancelled') })
    return 'context'
  })
  await expect(test.create({ project: '/tmp/project', command: 'run' }, test.assertActive)).rejects.toThrow('cancelled')
  expect(test.rpc).not.toHaveBeenCalled()
})

it('returns recoverable IDs on submission failure and never retries or deletes the conversation', async () => {
  const test = fixture()
  test.submit.mockRejectedValue(new Error('transport uncertain'))
  const failure = await test.create({ project: '/tmp/project', command: 'run' }, test.assertActive).catch(error => error)
  expect(failure).toBeInstanceOf(ConversationCreationError)
  expect(failure).toMatchObject({ status: 502, threadId: 'new-thread', messageId: expect.stringMatching(/^d-\d+-/) })
  expect(test.submit).toHaveBeenCalledOnce()
  expect(test.rpc).toHaveBeenCalledTimes(2)
})

it.each(['queued', 'unknown', 'failed'])('preserves durable delivery status %s without claiming a running turn', async status => {
  const test = fixture()
  test.submit.mockResolvedValue({ status })
  const result = await test.create({ project: '/tmp/project', command: 'run' }, test.assertActive)
  expect(result.status).toBe(status)
  expect(result).not.toHaveProperty('turnId')
  expect(test.submit).toHaveBeenCalledOnce()
})
