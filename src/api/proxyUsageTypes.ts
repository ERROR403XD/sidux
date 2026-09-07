export type UsageOutcome = 'completed' | 'failed' | 'interrupted' | 'rejected'
export type TokenUsage = { input: number | null; output: number | null; total: number | null; cached: number | null; reasoning: number | null }
export type UsageCounters = {
  requests: number; completed: number; failed: number; interrupted: number; rejected: number
  input: number; output: number; total: number; cached: number; reasoning: number
  unknown: number; inputUnknown: number; outputUnknown: number; catalogs: number
}
export type KeyUsageSummary = { cumulative: UsageCounters; today: UsageCounters; week: UsageCounters }
export type ProxyUsageSummary = {
  startedAt: string; windowCoverageFrom: string; error: string | null; timeZone: string
  keys: Record<string, KeyUsageSummary>
}
export function emptyUsage(): UsageCounters {
  return { requests: 0, completed: 0, failed: 0, interrupted: 0, rejected: 0, input: 0, output: 0,
    total: 0, cached: 0, reasoning: 0, unknown: 0, inputUnknown: 0, outputUnknown: 0, catalogs: 0 }
}
