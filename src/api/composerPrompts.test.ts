import { afterEach, expect, it, vi } from 'vitest'
import { createComposerPrompt, getComposerPrompts, removeComposerPrompt } from './codexGateway'
afterEach(() => vi.unstubAllGlobals())
const response = (data: unknown) => new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json' } })

it('shares only pending prompt reads and retries after a failure', async () => {
  let resolve!: (value: Response) => void
  const fetcher = vi.fn().mockReturnValueOnce(new Promise<Response>(done => { resolve = done }))
  vi.stubGlobal('fetch', fetcher)
  const first = getComposerPrompts()
  const second = getComposerPrompts()
  expect(fetcher).toHaveBeenCalledTimes(1)
  resolve(response([{ name: 'One', path: '/one', content: 'one' }]))
  expect(await first).toEqual(await second)
  fetcher.mockRejectedValueOnce(new Error('Offline'))
  expect(await getComposerPrompts()).toEqual([])
  fetcher.mockResolvedValueOnce(response([]))
  expect(await getComposerPrompts()).toEqual([])
  expect(fetcher).toHaveBeenCalledTimes(3)
})

it.each(['create', 'remove'])('invalidates a pending read after %s and keeps a newer read independent', async operation => {
  let oldResolve!: (value: Response) => void
  let currentResolve!: (value: Response) => void
  const fetcher = vi.fn()
    .mockReturnValueOnce(new Promise<Response>(done => { oldResolve = done }))
    .mockResolvedValueOnce(response({ name: 'New', path: '/new', content: 'new' }))
    .mockReturnValueOnce(new Promise<Response>(done => { currentResolve = done }))
  vi.stubGlobal('fetch', fetcher)
  const old = getComposerPrompts()
  if (operation === 'create') await createComposerPrompt('New', 'new')
  else await removeComposerPrompt('/old')
  const current = getComposerPrompts()
  oldResolve(response([{ name: 'Old', path: '/old', content: 'old' }]))
  await old
  const shared = getComposerPrompts()
  expect(fetcher).toHaveBeenCalledTimes(3)
  currentResolve(response([{ name: 'New', path: '/new', content: 'new' }]))
  expect(await current).toEqual(await shared)
  expect(await shared).toEqual([{ name: 'New', path: '/new', content: 'new' }])
})
