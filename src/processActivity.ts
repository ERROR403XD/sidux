export type HookRun = {
  id: string
  threadId: string
  turnId: string | null
  eventName: string
  executionMode: string
  handlerType: string
  source: string
  sourcePath: string
  scope: string
  startedAt: number
  completedAt: number | null
  durationMs: number | null
  status: string
  statusMessage: string
  entries: Array<{ kind: string; text: string }>
  truncated: boolean
  currentRuntime: boolean
}
export type HookSnapshot = { runs: HookRun[]; observedSince: number; limited: boolean; error: string }
export type HookDefinition = {
  key: string; eventName: string; handlerType: string; source: string; sourcePath: string
  enabled: boolean; trustStatus: string; matcher: string; command: string; statusMessage: string
}
export type HookConfiguration = { hooks: HookDefinition[]; warnings: string[]; limited: boolean }
export type BackgroundTerminal = {
  processId: string; itemId: string; command: string; cwd: string
  osPid: number | null; cpuPercent: number | null; rssKb: number | null
}
export type CommandOutput = {
  itemId: string; text: string; status: string; exitCode: number | null; truncated: boolean
  source: 'observed' | 'history' | 'toolResult' | 'unavailable'
}
export const OUTPUT_LIMIT = 32768
export const hookRunKey = (run: HookRun): string => JSON.stringify([run.threadId, run.turnId, run.id, run.startedAt])
const record = (value: unknown): Record<string, any> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null
const str = (value: unknown, limit = 1000): string => typeof value === 'string' ? value.slice(0, limit) : ''
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null

export function readHookRun(value: unknown, threadId: string, turnId: unknown): HookRun | null {
  const row = record(value)
  if (!row || !str(row.id) || !threadId || num(row.startedAt) === null || !Array.isArray(row.entries)) return null
  let remaining = 16000
  let truncated = row.entries.length > 20 || row.truncated === true
  const entries = row.entries.slice(0, 20).flatMap((entry: unknown) => {
    const item = record(entry)
    if (!item || typeof item.text !== 'string') return []
    const text = item.text.slice(0, Math.min(remaining, 4000))
    remaining -= text.length
    truncated ||= text.length < item.text.length
    return text ? [{ kind: str(item.kind, 80), text }] : []
  })
  return {
    id: row.id, threadId, turnId: typeof turnId === 'string' ? turnId : null, eventName: str(row.eventName, 80),
    executionMode: str(row.executionMode, 80), handlerType: str(row.handlerType, 80), source: str(row.source, 80),
    sourcePath: str(row.sourcePath, 2000), scope: str(row.scope, 80), startedAt: row.startedAt,
    completedAt: num(row.completedAt), durationMs: num(row.durationMs), status: str(row.status, 80),
    statusMessage: str(row.statusMessage), entries, truncated, currentRuntime: true,
  }
}

export function hookStatusLabel(run: HookRun): string {
  if (run.status === 'running' && !run.currentRuntime) return '状态待确认'
  return ({ running: '运行中', completed: '已完成', failed: '失败', blocked: '已阻止', stopped: '已停止' } as Record<string, string>)[run.status] || '未知状态'
}

export function readHookConfiguration(value: unknown, cwd: string): HookConfiguration {
  const data = record(value)?.data
  if (!Array.isArray(data)) throw new Error('Hooks 配置响应无效')
  const row = data.find(item => record(item)?.cwd === cwd)
  if (!row || !Array.isArray(row.hooks) || !Array.isArray(row.errors) || !Array.isArray(row.warnings)) throw new Error('Hooks 未返回当前目录的配置')
  return {
    hooks: row.hooks.slice(0, 500).map((item: any) => ({
      key: str(item.key, 2000), eventName: str(item.eventName, 80), handlerType: str(item.handlerType, 80),
      source: str(item.source, 80), sourcePath: str(item.sourcePath, 2000), enabled: item.enabled === true,
      trustStatus: str(item.trustStatus, 80), matcher: str(item.matcher),
      command: item.handlerType === 'mcpTool' ? [str(item.server), str(item.tool)].join(' / ') : str(item.command, 4000),
      statusMessage: str(item.statusMessage),
    })),
    warnings: [...row.errors.map((error: any) => [str(error.path), str(error.message)].filter(Boolean).join(': ')), ...row.warnings.map((warning: unknown) => str(warning))].slice(0, 50),
    limited: row.hooks.length > 500 || row.errors.length + row.warnings.length > 50,
  }
}

export function readBackgroundTerminal(value: unknown): BackgroundTerminal {
  const row = record(value)
  if (!row || typeof row.processId !== 'string' || !row.processId || typeof row.itemId !== 'string' || !row.itemId
    || typeof row.command !== 'string' || typeof row.cwd !== 'string') throw new Error('后台终端响应无效')
  return { processId: row.processId, itemId: row.itemId, command: str(row.command, 8000), cwd: str(row.cwd, 2000),
    osPid: num(row.osPid), cpuPercent: num(row.cpuPercent), rssKb: num(row.rssKb) }
}

export function readCommandOutput(value: unknown, source: CommandOutput['source']): CommandOutput | null {
  const row = record(value)
  if (!row || row.type !== 'commandExecution' || typeof row.id !== 'string') return null
  const text = typeof row.aggregatedOutput === 'string' ? row.aggregatedOutput : ''
  return { itemId: row.id, text: text.slice(-OUTPUT_LIMIT), status: str(row.status, 80), exitCode: num(row.exitCode), truncated: text.length > OUTPUT_LIMIT, source }
}
