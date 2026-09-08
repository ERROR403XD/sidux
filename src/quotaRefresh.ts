export function quotaRefreshInterval(snapshot: { primary?: { usedPercent: number } | null; secondary?: { usedPercent: number } | null } | null | undefined): number {
  const used = Math.max(0, ...[snapshot?.primary, snapshot?.secondary].flatMap(window => window && Number.isFinite(window.usedPercent) ? [window.usedPercent] : []))
  return (used >= 99 ? 5 : used >= 90 ? 15 : used >= 75 ? 30 : 60) * 1000
}

export async function boundedQuotaRead<T>(read: Promise<T>, timeoutMs = 25_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([read, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('额度读取超时，仍等待原请求结束')), timeoutMs) })])
  } finally { if (timer) clearTimeout(timer) }
}
const record = (value: unknown): Record<string, any> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null
const available = (value: Record<string, any>) => Object.fromEntries(Object.entries(value).filter(([, field]) => field != null))

// Null fields in rolling notifications mean unavailable, not a cleared window.
export function mergeQuotaUpdate(previous: unknown, payload: unknown): Record<string, unknown> | null {
  const root = record(payload)
  const byId = record(root?.rateLimitsByLimitId ?? root?.rate_limits_by_limit_id)
  const next = record(byId?.codex ?? root?.rateLimits ?? root?.rate_limits)
  const old = record(previous)
  if (!next || ((next.limitId ?? next.limit_id) && (next.limitId ?? next.limit_id) !== 'codex')) return old
  const result = { ...old, ...available(next) }
  for (const key of ['primary', 'secondary', 'credits']) {
    const patch = record(next[key])
    if (!patch) continue
    result[key] = { ...record(old?.[key]), ...available(patch) }
    if (key !== 'credits') {
      const minutes = patch.windowMinutes ?? patch.windowDurationMins ?? patch.window_minutes
      if (minutes != null) result[key] = { ...result[key], windowMinutes: minutes, windowDurationMins: minutes }
    }
  }
  return result
}

export function quotaRetryDelay(error: unknown, failures: number, now = Date.now()): number {
  const value = record(error)
  const data = record(value?.data)
  const headers = record(data?.headers ?? value?.headers)
  const message = error instanceof Error ? error.message : String(error)
  const retryAfter = headers?.['retry-after'] ?? headers?.['Retry-After'] ?? data?.retryAfter ?? data?.retry_after_seconds ?? value?.retryAfter ?? /retry-after\s*[:=]\s*(\d+)/i.exec(message)?.[1]
  if (retryAfter != null) {
    const seconds = Number(retryAfter)
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(String(retryAfter)) - now
    if (Number.isFinite(delay) && delay >= 0) return Math.max(1000, delay)
  }
  const limited = value?.status === 429 || data?.status === 429 || value?.code === 429 || /429|rate.?limit|too many requests/i.test(message)
  return Math.min(300_000, (limited ? 5000 : 30_000) * 2 ** Math.min(6, Math.max(0, failures - 1)))
}
