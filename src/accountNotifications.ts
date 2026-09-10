export type AccountNoticeRule = { resetIncrease?: boolean; resetIncreaseMessage?: string; resetExpiry?: boolean; resetExpiryLeadTimes?: string; resetExpiryMessage?: string; fiveHour: boolean; weekly: boolean; fiveHourMessage: string; weeklyMessage: string }
export type NotificationSettings = { enabled: boolean; url: string; body: string; timezone: string; quietEnabled: boolean; quietStart: string; quietEnd: string }
export type QuietHoursSettings = Pick<NotificationSettings, 'timezone' | 'quietEnabled' | 'quietStart' | 'quietEnd'>
export const defaultQuietHours: QuietHoursSettings = { timezone: 'Asia/Shanghai', quietEnabled: false, quietStart: '22:00', quietEnd: '08:00' }
export function validateQuietHours(value: QuietHoursSettings): QuietHoursSettings {
  if (typeof value.quietEnabled !== 'boolean') throw new Error('通知设置格式错误。')
  new Intl.DateTimeFormat('en', { timeZone: value.timezone })
  for (const time of [value.quietStart, value.quietEnd]) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('免打扰时间请填写HH:mm。')
  return { timezone: value.timezone, quietEnabled: value.quietEnabled, quietStart: value.quietStart, quietEnd: value.quietEnd }
}
export const defaultNoticeRule: AccountNoticeRule = { resetIncrease: false, resetIncreaseMessage: '{{account}} 的 Banked reset 重置机会增加 {{increase}} 次，当前可用 {{remaining}} 次（原有 {{previous}} 次）。', resetExpiry: false, resetExpiryLeadTimes: '7d, 3d, 12h', resetExpiryMessage: '{{account}} 的重置机会将于 {{expires_at}} 到期，剩余 {{remaining}}（提醒档位 {{lead_time}}）。', fiveHour: false, weekly: false, fiveHourMessage: '{{account}} 的5小时额度已重置，剩余 {{remaining}}%，下次重置 {{reset_at}}', weeklyMessage: '{{account}} 的主额度已重置，剩余 {{remaining}}%，下次重置 {{reset_at}}' }
export const defaultNotificationSettings: NotificationSettings = { enabled: false, url: '', body: '{"message":"{{message}}"}', timezone: 'Asia/Shanghai', quietEnabled: false, quietStart: '22:00', quietEnd: '08:00' }
export function renderNotice(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([a-z_]+)\}\}/g, (match, key) => values[key] ?? match)
}
export function renderNoticeBody(template: string, values: Record<string, string>): string {
  const replace = (value: unknown): unknown => typeof value === 'string' ? renderNotice(value, values) : Array.isArray(value) ? value.map(replace) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, field]) => [key, replace(field)])) : value
  return JSON.stringify(replace(JSON.parse(template)))
}
export function inQuietHours(settings: QuietHoursSettings, now: number): boolean {
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
  if (rule.resetIncrease !== undefined && typeof rule.resetIncrease !== 'boolean') throw new Error('重置机会增加提醒选项无效')
  if (rule.resetIncreaseMessage !== undefined && typeof rule.resetIncreaseMessage !== 'string') throw new Error('重置机会增加提醒内容无效')
  const leads = parseResetExpiryLeadTimes(rule.resetExpiryLeadTimes ?? defaultNoticeRule.resetExpiryLeadTimes!)
  if (rule.resetExpiry !== undefined && typeof rule.resetExpiry !== 'boolean') throw new Error('重置机会到期提醒选项无效')
  if (rule.resetExpiryMessage !== undefined && typeof rule.resetExpiryMessage !== 'string') throw new Error('重置机会到期提醒内容无效')
  return { ...defaultNoticeRule, ...rule, resetExpiryLeadTimes: leads.text, fiveHourMessage: mainQuotaWording(rule.fiveHourMessage), weeklyMessage: mainQuotaWording(rule.weeklyMessage).replaceAll('{{window}}额度', '{{window}}') }
}

export function parseResetExpiryLeadTimes(value: string): { text: string; hours: number[] } {
  if (typeof value !== 'string' || value.length > 512) throw new Error('提前时间格式无效')
  const tokens = value.trim().split(/[,，\s]+/u).filter(Boolean)
  if (!tokens.length || tokens.length > 16) throw new Error('请填写1至16个提前时间，例如7d, 3d, 12h')
  const hours: number[] = []
  for (const token of tokens) {
    const match = /^(?:(\d+)d)?(?:(\d+)h)?$/i.exec(token)
    if (!match || (!match[1] && !match[2])) throw new Error('提前时间请使用天d或小时h，例如1d12h')
    const total = Number(match[1] || 0) * 24 + Number(match[2] || 0)
    if (!Number.isSafeInteger(total) || total < 1 || total > 365 * 24) throw new Error('提前时间须为1小时至365天')
    if (!hours.includes(total)) hours.push(total)
  }
  hours.sort((a, b) => b - a)
  return { text: hours.map(formatReminderHours).join(', '), hours }
}
export function formatReminderHours(hours: number): string {
  const days = Math.floor(hours / 24)
  const rest = hours % 24
  return `${days ? `${days}d` : ''}${rest ? `${rest}h` : ''}`
}
