import { afterEach, describe, expect, it, vi } from 'vitest'
import { invalidateModelCatalog, loadModelCatalog } from './modelCatalog'
afterEach(() => { invalidateModelCatalog(); vi.unstubAllGlobals() })
const reply = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
describe('bounded model catalog reads', () => {
  it('merges simultaneous consumers, follows pagination once and invalidates explicitly', async () => {
    const rpc = vi.fn(async (_: string, params: Record<string, unknown>) => params.cursor ? { data: [{ id: 'second' }] } : { data: [{ id: 'first' }], nextCursor: 'next' })
    const [a, b] = await Promise.all([loadModelCatalog(rpc, { includeProviderModels: false }), loadModelCatalog(rpc, { includeProviderModels: false })])
    expect(a.map(row => row.id)).toEqual(['first', 'second'])
    expect(a).toEqual(b)
    expect(rpc).toHaveBeenCalledTimes(2)
    invalidateModelCatalog()
    await loadModelCatalog(rpc, { includeProviderModels: false })
    expect(rpc).toHaveBeenCalledTimes(4)
  })
  it('does not contaminate custom providers with matching Codex capabilities', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ data: ['same-name'], exclusive: true })))
    const rpc = vi.fn(async () => ({ data: [{ id: 'same-name', supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }] }] }))
    const standard = await loadModelCatalog(rpc, { includeProviderModels: false })
    const custom = await loadModelCatalog(rpc, { providerId: 'custom', requireProviderModels: true })
    expect(standard[0]?.efforts?.[0]?.value).toBe('ultra')
    expect(custom[0]?.efforts).toBeNull()
    expect(rpc).toHaveBeenCalledTimes(1)
  })
  it('retries failures and rejects repeated cursors rather than looping forever', async () => {
    const rpc = vi.fn(async () => ({ data: [], nextCursor: 'same' }))
    await expect(loadModelCatalog(rpc, { includeProviderModels: false })).rejects.toThrow('游标重复')
    expect(rpc).toHaveBeenCalledTimes(2)
    rpc.mockResolvedValue({ data: [], nextCursor: '' })
    await expect(loadModelCatalog(rpc, { includeProviderModels: false })).resolves.toEqual([])
  })
  it('does not restore an invalidated in-flight result to the current cache', async () => {
    let resolveOld!: (value: unknown) => void
    const rpc = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve })).mockResolvedValue({ data: [{ id: 'new-account' }] })
    const old = loadModelCatalog(rpc, { includeProviderModels: false })
    invalidateModelCatalog()
    const current = await loadModelCatalog(rpc, { includeProviderModels: false })
    resolveOld({ data: [{ id: 'old-account' }] })
    await old
    expect(await loadModelCatalog(rpc, { includeProviderModels: false })).toEqual(current)
    expect(current[0]?.id).toBe('new-account')
  })
})

it('keeps the active-account catalog separate from provider and proxy catalogs', async () => {
  const rpc = vi.fn()
  const fetcher = vi.fn(async (_url: string, _options?: unknown) => new Response(JSON.stringify({ data: [{ id: 'account-model', model: 'account-model', displayName: 'Account model', supportedReasoningEfforts: [] }] })))
  vi.stubGlobal('fetch', fetcher)
  const rows = await loadModelCatalog(rpc, { accountScoped: true, includeProviderModels: false })
  expect(rows.map(row => row.id)).toEqual(['account-model'])
  expect(fetcher.mock.calls[0]?.[0]).toBe('/codex-api/accounts/models')
  expect(rpc).not.toHaveBeenCalled()
})
