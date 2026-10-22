export type ConversationChoice = { model: string; provider: string; effort: string; tier: string }
export type ConversationPreferences = {
  defaults: ConversationChoice | null
  remember: boolean
  threads: Record<string, { source: 'web'; saved: ConversationChoice }>
}
export type ConversationPreferencePatch = Partial<ConversationPreferences> & { migrate?: ConversationPreferences }

export function normalizeConversationChoice(value: unknown): ConversationChoice | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
  if (!text(row.model)) return null
  return { model: text(row.model), provider: text(row.provider), effort: text(row.effort), tier: text(row.tier) }
}

export function normalizeConversationPreferences(value: unknown): ConversationPreferences {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const threads = row.threads && typeof row.threads === 'object' ? row.threads : {}
  return {
    defaults: normalizeConversationChoice(row.defaults),
    remember: row.remember !== false,
    threads: Object.fromEntries(Object.entries(threads).flatMap(([id, value]) => {
      const entry = value as { source?: unknown; saved?: unknown } | null
      const saved = normalizeConversationChoice(entry?.saved)
      return id && entry?.source === 'web' && saved ? [[id, { source: 'web' as const, saved }]] : []
    })),
  }
}
