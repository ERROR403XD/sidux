import { normalizeModelCapability, type ModelCapability } from '../modelCapabilities'

export type ModelCatalogOptions = { accountScoped?: boolean; includeProviderModels?: boolean; requireProviderModels?: boolean; providerId?: string }
type Rpc = (method: string, params: Record<string, unknown>) => Promise<unknown>
const cache = new Map<string, { promise: Promise<ModelCapability[]>; until: number }>()

export function invalidateModelCatalog(): void {
  cache.clear()
}

export function loadModelCatalog(rpc: Rpc, options: ModelCatalogOptions = {}): Promise<ModelCapability[]> {
  const key = JSON.stringify([options.providerId || '', options.includeProviderModels !== false, !!options.requireProviderModels, !!options.accountScoped])
  const cached = cache.get(key)
  if (cached && cached.until > Date.now()) return cached.promise
  const entry = { promise: Promise.resolve([] as ModelCapability[]), until: Infinity }
  entry.promise = readCatalog(rpc, options).then(rows => {
    entry.until = Date.now() + 2000
    return rows
  }, error => {
    if (cache.get(key) === entry) cache.delete(key)
    throw error
  })
  // A bounded recent-result cache only; account/config events explicitly clear it.
  if (cache.size >= 16) cache.delete(cache.keys().next().value!)
  cache.set(key, entry)
  return entry.promise
}

async function readCatalog(rpc: Rpc, options: ModelCatalogOptions): Promise<ModelCapability[]> {
  if (options.accountScoped) {
    const response = await fetch('/codex-api/accounts/models', { signal: AbortSignal.timeout(30_000) })
    if (response.status !== 404) {
      const data = await response.json()
      if (!response.ok || !Array.isArray(data.data)) throw new Error('主激活账号模型目录读取失败')
      return uniqueModels(data.data.flatMap((row: unknown) => {
        if (row && typeof row === 'object' && (row as { hidden?: boolean }).hidden) return []
        const model = normalizeModelCapability(row, data.source || 'codex')
        return model ? [model] : []
      }))
    }
  }
  let providerRows: ModelCapability[] = []
  if (options.includeProviderModels !== false) {
    const suffix = options.providerId ? `?provider=${encodeURIComponent(options.providerId)}` : ''
    try {
      const response = await fetch(`/codex-api/provider-models${suffix}`, { signal: AbortSignal.timeout(5000) })
      const data = await response.json()
      if (!response.ok || !Array.isArray(data.data)) throw new Error('模型目录读取失败')
      // String-only providers have unknown capabilities, even when IDs match Codex.
      providerRows = data.data.flatMap((row: unknown) => {
        const model = normalizeModelCapability(row, data.source || options.providerId || 'provider')
        return model ? [model] : []
      })
      if (data.exclusive || options.requireProviderModels) return uniqueModels(providerRows)
    } catch (error) {
      if (options.requireProviderModels) throw error
    }
  }
  const rows: ModelCapability[] = []
  let cursor: string | null = null
  const cursors = new Set<string>()
  for (let page = 0; page < 20; page++) {
    const data = await rpc('model/list', { limit: 100, ...(cursor ? { cursor } : {}) }) as { data?: unknown[]; nextCursor?: string | null }
    if (!Array.isArray(data.data)) throw new Error('模型目录格式无效')
    for (const row of data.data) {
      if (row && typeof row === 'object' && (row as { hidden?: boolean }).hidden === true) continue
      const model = normalizeModelCapability(row, 'codex')
      if (model) rows.push(model)
    }
    cursor = data.nextCursor || null
    if (!cursor) return uniqueModels([...rows, ...providerRows])
    if (cursors.has(cursor)) throw new Error('模型目录分页游标重复')
    cursors.add(cursor)
  }
  throw new Error('模型目录超过 2000 项读取边界')
}

function uniqueModels(rows: ModelCapability[]): ModelCapability[] {
  const seen = new Set<string>()
  return rows.filter(row => {
    if (seen.has(row.id)) return false
    seen.add(row.id)
    return true
  })
}
