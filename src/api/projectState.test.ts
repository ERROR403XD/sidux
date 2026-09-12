import { afterEach, expect, it, vi } from 'vitest'
import { getWorkspaceRootsState, invalidateWorkspaceRootsStateCache, setWorkspaceRootsState } from './codexGateway'

afterEach(() => { vi.unstubAllGlobals(); invalidateWorkspaceRootsStateCache() })
const project = { id: 'virtual:11111111-1111-4111-8111-111111111111', label: 'Organization', cwds: ['/fixture/Documents/Codex/2026-09-13/session'] }
const state = { order: ['/real'], active: ['/real'], labels: {}, projectOrder: [project.id, '/real'], virtualProjects: [project] }
const response = (value: unknown) => new Response(JSON.stringify({ data: value }))

it('re-reads server-owned membership after an order-only write and isolates returned arrays', async () => {
  const fetcher = vi.fn(async () => response(state))
  vi.stubGlobal('fetch', fetcher)
  const first = await getWorkspaceRootsState()
  first.virtualProjects![0].cwds.splice(0)
  expect((await getWorkspaceRootsState()).virtualProjects![0].cwds).toEqual(project.cwds)
  await setWorkspaceRootsState({ order: state.order, active: state.active, labels: state.labels, projectOrder: state.projectOrder })
  expect((await getWorkspaceRootsState()).virtualProjects).toEqual([project])
  expect(fetcher).toHaveBeenCalledTimes(3)
})

it('deduplicates concurrent reads but never repopulates the cache with a pre-mutation late result', async () => {
  let finish!: (value: Response) => void
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve })).mockResolvedValue(response(state))
  vi.stubGlobal('fetch', fetcher)
  const stale = getWorkspaceRootsState()
  const concurrent = getWorkspaceRootsState()
  expect(fetcher).toHaveBeenCalledTimes(1)
  invalidateWorkspaceRootsStateCache()
  const fresh = await getWorkspaceRootsState()
  finish(response({ ...state, virtualProjects: [] }))
  expect(await stale).toEqual(fresh)
  expect(await concurrent).toEqual(fresh)
  expect(fetcher).toHaveBeenCalledTimes(2)
})
