export type ActivationSettings = { enabled: boolean; accountIds: string[]; times: string[]; timezone: string }
export type ActivationRun = { key: string; accountId: string; scheduledAt: number; finishedAt?: number; status: 'preparing' | 'sending' | 'sent' | 'skipped' | 'unknown'; reason: string }
export type ActivationSnapshot = { settings: ActivationSettings; runs: ActivationRun[]; nextAt: number | null; error: string; model: string }
export type ActivationHistorySlot = { date: string; scheduledAt: number; timezone: string }
export type ActivationHistoryPage = { slots: ActivationHistorySlot[]; page: number; runs: ActivationRun[] }
export function validateActivationSettings(value: unknown): ActivationSettings {
  const row = value as ActivationSettings
  if (!row || typeof row.enabled !== 'boolean' || !Array.isArray(row.accountIds) || !Array.isArray(row.times)) throw new Error('无效的激活设置')
  if (row.accountIds.length > 32 || row.times.length > 24 || row.accountIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 256)) throw new Error('账号或时刻数量无效')
  if (row.times.some(time => typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))) throw new Error('时间格式应为 HH:mm')
  try { new Intl.DateTimeFormat('en', { timeZone: row.timezone }).format() } catch { throw new Error('请选择有效时区') }
  if (typeof row.timezone !== 'string' || !row.timezone) throw new Error('请选择有效时区')
  const settings = { enabled: row.enabled, accountIds: [...new Set(row.accountIds)], times: [...new Set(row.times)].sort(), timezone: row.timezone }
  return settings
}
export function activationClock(timezone: string) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return (at: number) => {
    const fields = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]))
    return { date: `${fields.year}-${fields.month}-${fields.day}`, time: `${fields.hour}:${fields.minute}` }
  }
}
export function nextActivationAt(settings: ActivationSettings, after: number): number | null {
  if (!settings.enabled || !settings.accountIds.length || !settings.times.length) return null
  const clock = activationClock(settings.timezone)
  const times = new Set(settings.times)
  // Bounded to cover DST's missing hour. Called on schedule advancement, never per account.
  for (let at = (Math.floor(after / 60000) + 1) * 60000, end = after + 49 * 3600000; at <= end; at += 60000) {
    if (times.has(clock(at).time)) return at
  }
  return null
}
