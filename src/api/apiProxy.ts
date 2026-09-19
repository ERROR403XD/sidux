export type ApiProxyKey = {
  accountStorageId?: string | null; protected?: boolean
  forceRoute?: ApiProxyKeyForceRoute; aggregateRoute?: ApiProxyKeyAggregateRoute
  id: string; name: string; suffix: string; enabled: boolean; expiresAt: string | null; revokedAt: string | null; lastUsedAt: string | null
}
/** 模型强制路由：开启后用固定模型名改写所有经过此 key 的请求。 */
export type ApiProxyKeyForceRoute = { enabled: boolean; model: string }
/** 聚合路由：模型清单并集，每个模型指向一个账号（null 表示全局账号）。 */
export type ApiProxyKeyAggregateRoute = { enabled: boolean; entries: ApiProxyKeyRouteEntry[] }
export type ApiProxyKeyRouteEntry = { model: string; accountStorageId: string | null }
export function isApiProxyKeyInvalid(key: Pick<ApiProxyKey, 'revokedAt' | 'expiresAt'>, now = Date.now()): boolean {
  if (key.revokedAt) return true
  const expiresAt = key.expiresAt ? Date.parse(key.expiresAt) : NaN
  return Number.isFinite(expiresAt) && expiresAt <= now
}
export function visibleApiProxyKeys<T extends Pick<ApiProxyKey, 'revokedAt' | 'expiresAt'>>(keys: T[], showInvalid: boolean, now = Date.now()): T[] {
  return keys.filter(key => isApiProxyKeyInvalid(key, now) === showInvalid)
}
export type ApiProxySettings = {
  enabled: boolean; accountStorageId: string | null; globalConcurrency: number; keyConcurrency: number; drainTimeoutSeconds: number
}
export type ApiProxyStatus = {
  retryAt?: string | null
  usage?: import('./proxyUsageTypes').ProxyUsageSummary
  settings: ApiProxySettings; installed: boolean; ready: boolean; componentVersion: string; selectedStorageId: string | null; lastError: string | null
  keys: ApiProxyKey[]
  accounts: { activeStorageId: string | null; accounts: { storageId: string; kind?: 'custom'; supportedEndpoints?: string[]; bridgedEndpoints?: string[]; alias?: string; email: string | null; accountId: string; authStatus: string }[] }
  activity: { draining: boolean; activeRequests: number; connections: number; idleWebSockets: number;
    entries: { id: string; keyId: string; transport: string; model: string | null; startedAt: string; status: string }[];
    recent: { id: string; keyId: string; transport: string; model: string | null; startedAt: string; status: string }[] }
}
export async function apiProxyRequest<T>(path: string, input?: unknown): Promise<T> {
  const response = await fetch(`/codex-api/api-proxy${path}`, {
    method: input === undefined ? 'GET' : 'POST',
    headers: input === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: input === undefined ? undefined : JSON.stringify(input),
  })
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error?.message || 'API 出口请求失败。')
  return (payload.data ?? payload) as T
}
