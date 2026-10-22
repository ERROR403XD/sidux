import { expect, it, vi } from 'vitest'
import { createConversationNotificationContextReader } from './conversationNotificationContext'
import type { WorkspaceRootsState } from './workspaceStateService'

const taskCwd = '/root/Documents/Codex/2026-10-18/task'
const roots: WorkspaceRootsState = {
  order: ['/code/Sidux'], active: [], projectOrder: [], labels: { '/code/Sidux': '项目别名' }, remoteProjects: [],
  virtualProjects: [{ id: 'virtual:fixture', label: '虚拟管理项目', cwds: [taskCwd] }],
}
it('reuses runtime metadata while preferring the latest saved title', async () => {
  const runtime = { rpc: vi.fn(), getLastThreadReadSnapshot: vi.fn(() => ({ thread: { title: '旧标题', cwd: '/code/Sidux' } })) }
  const read = createConversationNotificationContextReader(runtime, async () => ({ titles: { thread: '完成标题' }, order: [] }), async () => roots)
  expect(await read('thread')).toEqual({ title: '完成标题', projectName: '项目别名' })
  expect(runtime.rpc).not.toHaveBeenCalled()
})
it.each([
  [taskCwd, '虚拟管理项目'],
  ['/root/Documents/Codex/2026-10-18/no-project', ''],
  ['', ''],
])('loads only metadata for an unlisted external conversation in %s', async (cwd, projectName) => {
  const runtime = { rpc: vi.fn(async () => ({ thread: { title: '外部任务标题', cwd } })), getLastThreadReadSnapshot: () => null }
  const read = createConversationNotificationContextReader(runtime, async () => ({ titles: {}, order: [] }), async () => roots)
  expect(await read('external')).toEqual({ title: '外部任务标题', projectName })
  expect(runtime.rpc).toHaveBeenCalledExactlyOnceWith('thread/read', { threadId: 'external', includeTurns: false })
})
it('retains the known title if deleted metadata cannot be read', async () => {
  const runtime = { rpc: vi.fn(async () => { throw new Error('removed') }), getLastThreadReadSnapshot: () => null }
  const read = createConversationNotificationContextReader(runtime, async () => ({ titles: { thread: '已完成标题' }, order: [] }), async () => roots)
  expect(await read('thread')).toEqual({ title: '已完成标题', projectName: '' })
})
