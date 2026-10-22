import { expect, it } from 'vitest'
import {
  buildWorkspaceRootsProjectOrderState,
  filterGroupsByWorkspaceRoots,
  mergeIncomingWithLocalInProgressThreads,
  mergeProjectOrder,
  mergeThreadGroups,
  mergeThreadGroupPages,
  organizeProjectGroups,
  orderGroupsByProjectOrder,
  removeThreadFromGroups,
  reorderProjectNames,
  type VirtualProject,
} from './projectOrganization'
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

it('merges and applies project order without duplicating or losing incoming groups', () => {
  const previousOrder = ['pinned', 'existing', 'stale']
  const incoming = [
    { projectName: 'new', threads: [] },
    { projectName: 'existing', threads: [] },
    { projectName: 'pinned', threads: [] },
  ]

  expect(mergeProjectOrder(previousOrder, incoming)).toEqual(['pinned', 'existing', 'stale', 'new'])
  expect(orderGroupsByProjectOrder(incoming, ['new', 'missing', 'pinned', 'existing', 'stale']))
    .toEqual([incoming[0], incoming[2], incoming[1]])
})

it('reorders only valid project-name moves and returns the same array reference for no-ops', () => {
  const order = ['first', 'second', 'third']

  expect(reorderProjectNames(order, 0, 2)).toEqual(['second', 'third', 'first'])
  expect(reorderProjectNames(order, 2, 0)).toEqual(['third', 'first', 'second'])
  expect(reorderProjectNames(order, 1, 1)).toBe(order)
  expect(reorderProjectNames(order, -1, 0)).toBe(order)
  expect(reorderProjectNames(order, 0, order.length)).toBe(order)
})

it('merges thread groups while preserving equal rows and replacing changed rows', () => {
  const kept = { ...thread, id: 'kept' }
  const changed = { ...thread, id: 'changed', title: 'incoming title' }
  const previous = [{ projectName: 'project', threads: [kept, changed, { ...thread, id: 'local-only' }] }]
  const incoming = [{ projectName: 'project', threads: [{ ...kept }, changed] }]

  expect(mergeThreadGroups(previous, incoming)).toEqual([{ projectName: 'project', threads: [{ ...kept }, changed] }])
  expect(mergeThreadGroups(previous, incoming)[0].threads[0]).toBe(kept)
  expect(mergeThreadGroups(previous, previous)).toBe(previous)
})

it('retains local in-progress and pending new threads missing from an incoming snapshot', () => {
  const active = { ...thread, id: 'active', projectName: 'project', inProgress: true }
  const pending = { ...thread, id: 'pending', projectName: 'new', inProgress: false }
  const serverRow = { ...thread, id: 'server', projectName: 'project' }
  const previous = [{ projectName: 'project', threads: [active] }, { projectName: 'new', threads: [pending] }]
  const incoming = [{ projectName: 'project', threads: [serverRow] }]

  expect(mergeIncomingWithLocalInProgressThreads(previous, incoming, { active: true }, new Set(['pending']))).toEqual([
    { projectName: 'project', threads: [active, serverRow] },
    { projectName: 'new', threads: [pending] },
  ])
  expect(mergeIncomingWithLocalInProgressThreads(previous, incoming, {})).toBe(incoming)
})

it('merges paged thread lists without losing groups and orders each page by latest activity', () => {
  const older = [
    { projectName: 'same', threads: [{ ...thread, id: 'base', updatedAtIso: '2025-12-31T00:00:00.000Z' }, { ...thread, id: 'older-only', updatedAtIso: '2026-01-01T00:00:00.000Z' }] },
    { projectName: 'removed', threads: [{ ...thread, id: 'removed', updatedAtIso: '2025-12-30T00:00:00.000Z' }] },
  ]
  const newer = [{
    projectName: 'same',
    threads: [
      { ...thread, id: 'newer', updatedAtIso: '2026-01-02T00:00:00.000Z' },
      { ...thread, id: 'older-only', updatedAtIso: '2026-01-01T00:00:00.000Z' },
    ],
  }]

  expect(mergeThreadGroupPages(older, newer)).toEqual([
    { projectName: 'chat', threads: [
      { ...thread, id: 'newer', updatedAtIso: '2026-01-02T00:00:00.000Z' },
      { ...thread, id: 'older-only', updatedAtIso: '2026-01-01T00:00:00.000Z' },
      { ...thread, id: 'base', updatedAtIso: '2025-12-31T00:00:00.000Z' },
      { ...thread, id: 'removed', updatedAtIso: '2025-12-30T00:00:00.000Z' },
    ] },
  ])
  expect(mergeThreadGroupPages([], newer)).toBe(newer)
  expect(mergeThreadGroupPages(older, [])).toBe(older)
})
