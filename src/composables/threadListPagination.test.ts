import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createThreadListPagination } from './threadListPagination'
import type { ThreadGroupsPage } from '../api/threadReadGateway'

const pages: ThreadGroupsPage[] = [
  { groups: [], nextCursor: 'first-remaining' },
  { groups: [], nextCursor: 'second-remaining' },
]

function createOptions() {
  const isFullyLoaded = ref(true)
  let accountRevision = 0
  return {
    isFullyLoaded,
    getAccountRevision: () => accountRevision,
    switchAccount: () => {
      accountRevision += 1
    },
    loadPage: vi.fn(async () => pages[1]),
    getLimit: vi.fn(() => 100),
    delayMs: 20,
    scheduleTimeout: vi.fn((callback: () => void, delay: number) => setTimeout(callback, delay) as unknown as number),
    cancelTimeout: vi.fn(clearTimeout),
    pageOne: pages[0],
  }
}

describe('thread list pagination state', () => {
  it('keeps a scheduled page deadline when refreshes repeatedly request pagination', async () => {
    vi.useFakeTimers()
    try {
      const options = createOptions()
      const pagination = createThreadListPagination(options)
      pagination.completeFirstPage('older', false)
      const run = vi.fn(async () => {})
      pagination.scheduleRemainingPages(run)
      await vi.advanceTimersByTimeAsync(10)
      pagination.scheduleRemainingPages(run)
      await vi.advanceTimersByTimeAsync(10)
      expect(run).toHaveBeenCalledOnce()
      expect(options.scheduleTimeout).toHaveBeenCalledOnce()
      pagination.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('carries the status revisions from before the page request to the commit', async () => {
    const options = createOptions()
    const revisions = new Map([['thread', 1]])
    let release!: (page: ThreadGroupsPage) => void
    options.loadPage.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const pagination = createThreadListPagination({ ...options, getStatusRevisions: () => new Map(revisions) })
    pagination.completeFirstPage('cursor', false)
    const apply = vi.fn()
    const loading = pagination.loadRemainingPages(apply)
    revisions.set('thread', 2)
    release({ groups: [], nextCursor: null })
    await loading
    expect(apply).toHaveBeenCalledWith({ groups: [], nextCursor: null }, new Map([['thread', 1]]))
  })

  it('does not apply or schedule a timer after stop while a page is pending', async () => {
    const options = createOptions()
    let release!: (page: ThreadGroupsPage) => void
    options.loadPage.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const pagination = createThreadListPagination(options)
    pagination.completeFirstPage('cursor', false)
    const apply = vi.fn()
    const loading = pagination.loadRemainingPages(apply)
    pagination.stop()
    release(pages[1])
    await loading
    pagination.scheduleRemainingPages(async () => {})
    expect(apply).not.toHaveBeenCalled()
    expect(options.scheduleTimeout).not.toHaveBeenCalled()
  })

  it('isolates the old request when a new lifecycle starts before it finishes', async () => {
    const options = createOptions()
    const releases: Array<(page: ThreadGroupsPage) => void> = []
    options.loadPage.mockImplementation(() => new Promise(resolve => { releases.push(resolve) }))
    const pagination = createThreadListPagination(options)
    pagination.completeFirstPage('cursor', false)
    const apply = vi.fn()
    const old = pagination.loadRemainingPages(apply)
    pagination.stop()
    pagination.start()
    const current = pagination.loadRemainingPages(apply)
    releases[0]!({ groups: [], nextCursor: null })
    await old
    expect(apply).not.toHaveBeenCalled()
    expect(pagination.isLoadingRemainingPages).toBe(true)
    releases[1]!({ groups: [], nextCursor: null })
    await current
    expect(apply).toHaveBeenCalledTimes(1)
    expect(pagination.isLoadingRemainingPages).toBe(false)
  })

  it('schedules one delayed request for the remaining page', async () => {
    vi.useFakeTimers()
    const options = createOptions()
    const pagination = createThreadListPagination(options)
    pagination.completeFirstPage(options.pageOne.nextCursor, false)
    pagination.scheduleRemainingPages(() => pagination.loadRemainingPages(() => undefined))
    expect(options.loadPage).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(19)
    expect(options.loadPage).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(options.loadPage).toHaveBeenCalledWith(pages[0].nextCursor, 100)
    expect(options.isFullyLoaded.value).toBe(false)
    vi.useRealTimers()
  })

  it('cancels a scheduled request and marks the list complete on account reset', () => {
    vi.useFakeTimers()
    const options = createOptions()
    const pagination = createThreadListPagination(options)
    pagination.completeFirstPage(options.pageOne.nextCursor, false)
    pagination.scheduleRemainingPages(() => pagination.loadRemainingPages(() => undefined))
    options.switchAccount()
    pagination.resetForAccountChange()
    pagination.stop()
    void vi.advanceTimersByTimeAsync(30)
    expect(options.loadPage).not.toHaveBeenCalled()
    expect(pagination.nextCursor).toBeNull()
    expect(options.isFullyLoaded.value).toBe(true)
    vi.useRealTimers()
  })

  it('discards a late page after the account changes', async () => {
    vi.useFakeTimers()
    const options = createOptions()
    let releasePage!: (value: ThreadGroupsPage) => void
    options.loadPage.mockImplementationOnce(() => new Promise(resolve => { releasePage = resolve }))
    const pagination = createThreadListPagination(options)
    pagination.completeFirstPage(options.pageOne.nextCursor, false)
    let appliedCount = 0
    const loading = pagination.loadRemainingPages(() => { appliedCount += 1 })
    options.switchAccount()
    pagination.resetForAccountChange()
    releasePage(pages[1])
    await loading
    expect(appliedCount).toBe(0)
    expect(pagination.nextCursor).toBeNull()
    expect(options.isFullyLoaded.value).toBe(true)
    vi.useRealTimers()
  })
})
