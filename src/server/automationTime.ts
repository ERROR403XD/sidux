const formatters = new Map<string, Intl.DateTimeFormat>()
export function formatAutomationTime(at: number, timezone: string): string {
  let formatter = formatters.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' })
    if (formatters.size >= 64) formatters.delete(formatters.keys().next().value!)
    formatters.set(timezone, formatter)
  }
  const p = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]))
  const offset = p.timeZoneName === 'GMT' ? '+00:00' : p.timeZoneName!.replace('GMT', '')
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ${offset}（${timezone}）`
}
export function automationTimeContext(run: { trigger: string; scheduledAt: number; startedAt: number | null; timezone: string }): string {
  const label = run.trigger === 'manual' ? '手动请求时间' : run.trigger === 'retry' ? '本次重试请求时间' : '计划触发时间'
  return `${label}：${formatAutomationTime(run.scheduledAt, run.timezone)}\n实际开始时间：${formatAutomationTime(run.startedAt ?? run.scheduledAt, run.timezone)}\n以上时间已换算到任务时区，不要再次当作 UTC 换算；“今天、昨天、本周”等相对日期按上述参考时间及任务时区理解。`
}
