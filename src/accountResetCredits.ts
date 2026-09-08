export type ResetCredit = { id: string; expiresAt: number | null; status: string; resetType: string }
export type ResetCredits = { availableCount: number; credits: ResetCredit[] | null }
export function normalizeResetCredits(value: unknown): ResetCredits | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (typeof raw.availableCount !== 'number' || !Number.isFinite(raw.availableCount)) return null
  const credits = Array.isArray(raw.credits) ? raw.credits.flatMap((item: any) => {
    if (!item || typeof item.id !== 'string' || typeof item.status !== 'string') return []
    return [{ id: item.id, expiresAt: typeof item.expiresAt === 'number' && Number.isFinite(item.expiresAt) ? item.expiresAt : null, status: item.status, resetType: String(item.resetType || 'unknown') }]
  }) : null
  return { availableCount: Math.max(0, Math.trunc(raw.availableCount)), credits }
}
export function availableResetCredits(summary: ResetCredits | null | undefined, now = Date.now()): ResetCredit[] {
  return (summary?.credits || []).filter(credit => credit.status === 'available' && (credit.expiresAt === null || credit.expiresAt * 1000 > now))
    .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) || a.id.localeCompare(b.id))
}
