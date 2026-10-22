import { describe, expect, it } from 'vitest'
import { computed, ref } from 'vue'
import { useSidebarThreadProjection } from './sidebarThreadProjection'
import type { UiProjectGroup, UiThread } from '../types/codex'

function thread(id: string, overrides: Partial<UiThread> = {}): UiThread {
  return {
    id,
    title: `Thread ${id}`,
    projectName: 'general',
    cwd: '/workspace',
    hasWorktree: false,
    createdAtIso: '2026-10-09T00:00:00.000Z',
    updatedAtIso: '2026-10-10T00:00:00.000Z',
    preview: '',
    unread: false,
    inProgress: false,
    ...overrides,
  }
}

function projection(
  groups: UiProjectGroup[],
  options: { statusFilter?: 'all' | 'unread'; retainedThreadId?: string; searchQuery?: string; searchMatchedThreadIds?: string[] } = {},
) {
  return useSidebarThreadProjection({
    groups: ref(groups),
    statusFilter: ref(options.statusFilter),
    retainedThreadId: ref(options.retainedThreadId),
    activeRetainedIds: ref(undefined),
    quotaInterrupted: ref(undefined),
    optimisticallyArchivedThreadIds: ref([]),
    pinnedThreadIds: ref([]),
    searchQuery: ref(options.searchQuery ?? ''),
    searchMatchedThreadIds: ref(options.searchMatchedThreadIds ?? null),
    chatSortMode: ref<'created' | 'updated'>('updated'),
  })
}

describe('sidebar thread projection', () => {
  it('keeps virtual project threads out of chronological chats', () => {
    const result = projection([
      { projectName: 'virtual', threads: [thread('virtual-thread')] },
      { projectName: 'general', threads: [thread('project-thread')] },
    ])

    expect(result.chatThreads.value.map((item) => item.id)).toEqual([])
    expect(result.globalThreads.value.map((item) => item.id)).toEqual(['virtual-thread', 'project-thread'])
  })

  it('keeps the retained thread visible while a status filter is active', () => {
    const result = projection(
      [{ projectName: 'general', threads: [thread('kept', { unread: false }), thread('unread', { unread: true })] }],
      { statusFilter: 'unread', retainedThreadId: 'kept' },
    )

    expect(result.globalThreads.value.map((item) => item.id)).toEqual(['kept', 'unread'])
  })

  it('sorts search results by the provided match order', () => {
    const result = projection([{ projectName: 'general', threads: [thread('first'), thread('second')] }], {
      searchQuery: 'Thread',
      searchMatchedThreadIds: ['second', 'first'],
    })

    expect(result.filteredGroups.value[0]?.threads.map((item) => item.id)).toEqual(['second', 'first'])
    expect(result.globalThreads.value.map((item) => item.id)).toEqual(['second', 'first'])
  })
})
