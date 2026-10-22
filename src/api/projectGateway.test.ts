import { afterEach, describe, expect, it, vi } from 'vitest'
import { getHomeDirectory, listLocalDirectories } from './projectGateway'

describe('project gateway files', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads the home directory', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input))
      return new Response(JSON.stringify({ data: { path: '/home/user' } }))
    }))

    await expect(getHomeDirectory()).resolves.toBe('/home/user')
    expect(requests).toEqual(['/codex-api/home-directory'])
  })

  it('normalizes local directory paths', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input))
      return new Response(JSON.stringify({
        data: {
          path: '/home/user',
          parentPath: '/home',
          entries: [{ name: 'repo', path: '/home/user/repo' }],
        },
      }))
    }))

    await expect(listLocalDirectories('/home', { showHidden: true })).resolves.toEqual({
      path: '/home/user',
      parentPath: '/home',
      entries: [{ name: 'repo', path: '/home/user/repo' }],
    })
    expect(requests).toEqual(['/codex-local-directories?path=%2Fhome&showHidden=1'])
  })
})
