import { expect, it } from 'vitest'
import { organizeProjectGroups, type VirtualProject } from './projectOrganization'
import { filterGroupsByWorkspaceRoots, buildWorkspaceRootsProjectOrderState } from './composables/useDesktopState'
import type { UiThread } from './types/codex'

const id = 'virtual:11111111-1111-4111-8111-111111111111'
const id2 = 'virtual:22222222-2222-4222-8222-222222222222'
const cwd = '/fixture/Documents/Codex/2026-09-13/chat'
const project: VirtualProject = { id, label: '同名项目', cwds: [cwd] }
const emptyProject: VirtualProject = { id: id2, label: '同名项目', cwds: [] }
const thread = { id: 'active', cwd, projectName: 'chat', inProgress: true, executionAccountStorageId: 'account-a', pendingRequestState: 'approval', title: 'original' } as unknown as UiThread

it('groups native conversations and their forks without changing cwd, account, active state or approval identity', () => {
  const original = { projectName: 'chat', threads: [thread, { ...thread, id: 'fork' }] }
  const real = { projectName: 'real', threads: [{ ...thread, id: 'real', cwd: '/real/project' }] }
  const result = organizeProjectGroups([original, real], [project, emptyProject])
  expect(result.map(group => [group.projectName, group.threads.map(thread => thread.id)])).toEqual([['real', ['real']], [id, ['active', 'fork']], [id2, []]])
  expect(result[1].threads[0]).toEqual({ ...thread, projectName: id })
  expect(original.threads[0]).toBe(thread)
  expect(original.projectName).toBe('chat')
})

it('retains empty and same-name projects, orders them with real roots and never persists member cwds as workspace roots', () => {
  const roots = { order: ['/real/project'], active: ['/real/project'], labels: {}, projectOrder: [id2, '/real/project', id], virtualProjects: [project, emptyProject] }
  const groups = filterGroupsByWorkspaceRoots([{ projectName: 'chat', threads: [thread] }], roots)
  expect(groups.map(group => group.projectName)).toEqual([id2, 'project', id])
  expect(buildWorkspaceRootsProjectOrderState(roots, [id, id2, 'project'], groups)).toEqual({ order: ['/real/project'], active: ['/real/project'], projectOrder: [id, id2, '/real/project'] })
  expect(filterGroupsByWorkspaceRoots([{ projectName: 'chat', threads: [thread] }], { ...roots, virtualProjects: [] }).find(group => group.projectName === 'chat')?.threads[0]).toBe(thread)
})

it('supports a workspace containing only organized projects without swallowing unrelated ungrouped conversations', () => {
  const other = { ...thread, id: 'other', cwd: '/fixture/Documents/Codex/2026-09-13/other' }
  const groups = filterGroupsByWorkspaceRoots([{ projectName: 'chat', threads: [thread, other] }], { order: [], labels: {}, active: [], projectOrder: [id], virtualProjects: [project] })
  expect(groups.flatMap(group => group.threads.map(thread => thread.id)).sort()).toEqual(['active', 'other'])
  expect(groups.find(group => group.projectName === id)?.threads[0].cwd).toBe(cwd)
})
