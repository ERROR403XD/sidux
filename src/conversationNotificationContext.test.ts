import { expect, it } from 'vitest'
import { conversationNotificationProjectName } from './conversationNotificationContext'
import type { WorkspaceRootsState } from './api/projectGateway'

const taskCwd = '/root/Documents/Codex/2026-10-18/task'
const roots: WorkspaceRootsState = {
  order: ['/code/Sidux'], active: [], projectOrder: [], labels: { '/code/Sidux': '会话管理' },
  virtualProjects: [{ id: 'virtual:fixture', label: '管理虚拟项目', cwds: [taskCwd] }],
}
it.each([
  ['/code/Sidux', roots, '会话管理'],
  ['/unlisted/Hidden', roots, 'Hidden'],
  [taskCwd, roots, '管理虚拟项目'],
  ['/root/Documents/Codex/2026-10-18/ungrouped', roots, ''],
  ['', roots, ''],
  ['/root/.codex/worktrees/abc/Sidux', roots, '会话管理'],
  ['C:\\Work\\Sidux', { ...roots, order: ['C:/Work/Sidux'], labels: { 'c:/work/sidux': 'Windows 项目' } }, 'Windows 项目'],
])('resolves the notification project for %s', (cwd, state, expected) => {
  expect(conversationNotificationProjectName(cwd, state)).toBe(expected)
})
it('keeps projects sharing a directory name distinct', () => {
  const state = { ...roots, order: ['/one/app', '/two/app'], labels: { '/one/app': '第一个', '/two/app': '第二个' } }
  expect(conversationNotificationProjectName('/two/app', state)).toBe('第二个')
  expect(conversationNotificationProjectName('/two/app', { ...state, labels: {} })).toBe('/two/app')
})
