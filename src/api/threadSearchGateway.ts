import { type UiProjectGroup } from '../types/codex'
import { type ThreadSearchMode } from '../threadSearchMatch'
import { type ThreadListResponse } from './appServerDtos'
import { normalizeThreadGroupsV2 } from './normalizers/v2'

export type ThreadSearchResult = {
  groups?: UiProjectGroup[]
  threadIds: string[]
  indexedThreadCount: number
  titleScopeComplete?: boolean
  bodyThreadCount?: number
  bodyTurnLimit?: number
  bodyThreadLimit?: number
  partialBodyCount?: number
  failedBodyCount?: number
}

export async function searchThreads(
  query: string,
  limit = 200,
  signal?: AbortSignal,
  mode: ThreadSearchMode = 'title',
): Promise<ThreadSearchResult> {
  const response = await fetch('/codex-api/thread-search', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit, mode }),
  })
  const payload = (await response.json()) as { data?: ThreadSearchResult & { threads?: ThreadListResponse['data'] }; error?: string }
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to search threads')
  }
  const result = payload.data ?? { threadIds: [], indexedThreadCount: 0 }
  return {
    ...result,
    groups: payload.data?.threads ? normalizeThreadGroupsV2({ data: payload.data.threads, nextCursor: null }) : undefined,
  }
}
