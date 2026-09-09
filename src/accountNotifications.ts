export type AccountNoticeRule = { fiveHour: boolean; weekly: boolean; fiveHourMessage: string; weeklyMessage: string }
export type NotificationSettings = { enabled: boolean; url: string; body: string; timezone: string; quietEnabled: boolean; quietStart: string; quietEnd: string }
export const defaultNoticeRule: AccountNoticeRule = { fiveHour: false, weekly: false, fiveHourMessage: '{{account}} 的5小时额度已恢复，剩余 {{remaining}}%，下次重置 {{reset_at}}', weeklyMessage: '{{account}} 的主额度已恢复，剩余 {{remaining}}%，下次重置 {{reset_at}}' }
export const defaultNotificationSettings: NotificationSettings = { enabled: false, url: '', body: '{"message":"{{message}}"}', timezone: 'Asia/Shanghai', quietEnabled: false, quietStart: '22:00', quietEnd: '08:00' }
export function renderNotice(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([a-z_]+)\}\}/g, (match, key) => values[key] ?? match)
}
export function renderNoticeBody(template: string, values: Record<string, string>): string {
  const replace = (value: unknown): unknown => typeof value === 'string' ? renderNotice(value, values) : Array.isArray(value) ? value.map(replace) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, field]) => [key, replace(field)])) : value
  return JSON.stringify(replace(JSON.parse(template)))
}
export function inQuietHours(settings: NotificationSettings, now: number): boolean {
  if (!settings.quietEnabled) return false
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: settings.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now)
  return settings.quietStart === settings.quietEnd || (settings.quietStart < settings.quietEnd ? clock >= settings.quietStart && clock < settings.quietEnd : clock >= settings.quietStart || clock < settings.quietEnd)
}
export function validateNotificationSettings(value: NotificationSettings): NotificationSettings {
  if (typeof value.enabled !== 'boolean' || typeof value.quietEnabled !== 'boolean' || typeof value.url !== 'string' || typeof value.body !== 'string') throw new Error('通知设置格式错误。')
  if (value.enabled || value.url) {
    const url = new URL(value.url)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('通知地址须为HTTP或HTTPS。')
  }
  JSON.parse(value.body)
  if (!value.body.includes('{{message}}')) throw new Error('请求体须包含 {{message}} 占位符。')
  new Intl.DateTimeFormat('en', { timeZone: value.timezone })
  for (const time of [value.quietStart, value.quietEnd]) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('免打扰时间请填写HH:mm。')
  return { ...value }
}

export function mainQuotaWording(text: string): string {
  return text.replaceAll('周剩余额度', '主额度剩余').replaceAll('周额度', '主额度').replaceAll('周限额', '主额度').replaceAll('周保护', '主额度保护')
}
export function normalizeNoticeRule(rule: AccountNoticeRule): AccountNoticeRule {
  return { ...rule, fiveHourMessage: mainQuotaWording(rule.fiveHourMessage), weeklyMessage: mainQuotaWording(rule.weeklyMessage).replaceAll('{{window}}额度', '{{window}}') }
}
