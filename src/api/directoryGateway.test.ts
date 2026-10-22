import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const catalog = {
  marketplaces: [{ name: 'fixture', plugins: [{ id: 'plugin', name: 'Plugin' }] }],
  marketplaceLoadErrors: [{ message: 'unavailable marketplace' }],
}

function response() {
  return new Response(JSON.stringify({ result: catalog }))
}

beforeEach(() => vi.resetModules())
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('directory plugin cache ownership', () => {
  it('shares one in-flight request and cached warnings across facade and domain consumers', async () => {
    let finish!: (value: Response) => void
    const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetch)
    const domain = await import('./directoryGateway')
    const facade = await import('./codexGateway')
    expect(facade.listDirectoryPlugins).toBe(domain.listDirectoryPlugins)
    const firstWarnings = vi.fn()
    const secondWarnings = vi.fn()
    const first = domain.listDirectoryPlugins(['/b', '/a'], false, firstWarnings)
    const second = facade.listDirectoryPlugins(['/a', '/b'], false, secondWarnings)
    expect(fetch).toHaveBeenCalledTimes(1)
    finish(response())
    const [left, right] = await Promise.all([first, second])
    expect(left).toBe(right)
    expect(firstWarnings).toHaveBeenCalledWith(['unavailable marketplace'])
    expect(secondWarnings).toHaveBeenCalledWith(['unavailable marketplace'])
    const cachedWarnings = vi.fn()
    expect(await domain.listDirectoryPlugins(['/a', '/b'], false, cachedWarnings)).toBe(left)
    expect(cachedWarnings).toHaveBeenCalledWith(['unavailable marketplace'])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('preserves force refresh and the next local 02:00 expiry', async () => {
    const domain = await import('./directoryGateway')
    vi.useFakeTimers()
    const beforeExpiry = new Date(2026, 9, 11, 1, 59, 59)
    vi.setSystemTime(beforeExpiry)
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response())
    vi.stubGlobal('fetch', fetch)
    await domain.listDirectoryPlugins(['/expiry'])
    await domain.listDirectoryPlugins(['/expiry'])
    expect(fetch).toHaveBeenCalledTimes(1)
    vi.setSystemTime(new Date(2026, 9, 11, 2, 0, 0))
    await domain.listDirectoryPlugins(['/expiry'])
    expect(fetch).toHaveBeenCalledTimes(2)
    await domain.listDirectoryPlugins(['/expiry'], true)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(JSON.parse(fetch.mock.calls[2][1]!.body as string).params.forceRefetch).toBe(true)
    vi.setSystemTime(new Date(2026, 9, 12, 1, 59, 59))
    await domain.listDirectoryPlugins(['/expiry'])
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('keeps at most twelve cwd keys and releases failed requests for retry', async () => {
    const domain = await import('./directoryGateway')
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response())
    vi.stubGlobal('fetch', fetch)
    for (let index = 0; index < 13; index += 1) {
      await domain.listDirectoryPlugins([`/project-${index}`])
    }
    await domain.listDirectoryPlugins(['/project-1'])
    expect(fetch).toHaveBeenCalledTimes(13)
    await domain.listDirectoryPlugins(['/project-0'])
    expect(fetch).toHaveBeenCalledTimes(14)
    fetch.mockRejectedValueOnce(new Error('disconnected'))
    await expect(domain.listDirectoryPlugins(['/retry'])).rejects.toThrow('disconnected')
    await domain.listDirectoryPlugins(['/retry'])
    expect(fetch).toHaveBeenCalledTimes(16)
  })
})
