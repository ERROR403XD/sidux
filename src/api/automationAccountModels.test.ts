import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadAutomationAccountModels } from './automationAccountModels'

afterEach(() => vi.unstubAllGlobals())

describe('Automation selected-account model transport', () => {
  it('encodes the identity, forwards cancellation and normalizes only valid models', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'm' }, null, {}], source: 'custom' })))
    vi.stubGlobal('fetch', fetcher)
    const signal = new AbortController().signal
    const models = await loadAutomationAccountModels('a/&b', signal)
    expect(fetcher).toHaveBeenCalledWith('/codex-api/accounts/models?storageId=a%2F%26b', { signal })
    expect(models.map(row => [row.id, row.providerId])).toEqual([['m', 'custom']])
  })

  it.each([{ data: {} }, { data: null }, null])('rejects malformed catalogs: %j', async payload => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload))))
    await expect(loadAutomationAccountModels('a', new AbortController().signal)).rejects.toThrow('所选账号模型目录读取失败')
  })

  it('does not accept a failed HTTP response as a catalog', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 401 })))
    await expect(loadAutomationAccountModels('a', new AbortController().signal)).rejects.toThrow('所选账号模型目录读取失败')
  })
})
