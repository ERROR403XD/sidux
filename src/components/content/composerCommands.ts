export type ComposerCommand = {
  id: string; name: string; description: string; group: '命令' | '提示词' | '技能'
  action: 'plan' | 'default' | 'model' | 'skills' | 'prompt' | 'skill' | 'app' | 'mention' | 'init'
  value?: string; search: string
}
export type AppCommandName = 'goal' | 'compact' | 'tasks' | 'new' | 'rename' | 'fork' | 'review' | 'diff' | 'status' | 'copy' | 'resume' | 'apps' | 'plugins' | 'mcp' | 'automations' | 'export' | 'help'
export type AppCommandRequest = { name: AppCommandName; complete: () => void }
export const APP_COMMANDS: { id: AppCommandName; description: string; requiresThread?: boolean; idleOnly?: boolean }[] = [
  { id: 'goal', description: '设置持续目标，查看进展、暂停或继续' },
  { id: 'compact', description: '压缩当前会话上下文，保留关键内容', requiresThread: true, idleOnly: true },
  { id: 'tasks', description: '搜索任务，打开或插入近期对话摘录' },
  { id: 'new', description: '在当前项目开始新会话，保留原会话' },
  { id: 'rename', description: '重命名当前会话', requiresThread: true },
  { id: 'fork', description: '从当前会话创建独立分支', requiresThread: true, idleOnly: true },
  { id: 'review', description: '让 Codex 审查当前未提交的代码变更', requiresThread: true, idleOnly: true },
  { id: 'diff', description: '打开工作区文件差异与审阅面板', requiresThread: true },
  { id: 'status', description: '查看当前模型、上下文用量与运行状态' },
  { id: 'copy', description: '复制最近一条已完成的助手回复', requiresThread: true },
  { id: 'resume', description: '搜索并打开已有会话' },
  { id: 'apps', description: '查看应用连接与可用工具' },
  { id: 'plugins', description: '浏览、管理已安装插件' },
  { id: 'mcp', description: '查看 MCP 服务、工具与连接状态' },
  { id: 'automations', description: '打开自动化任务与执行历史' },
  { id: 'export', description: '导出当前已加载会话内容为 Markdown', requiresThread: true },
  { id: 'help', description: '查看命令目录、用途和输入操作说明' },
]
export type SlashToken = { start: number; end: number; query: string; text: string }

export function findSlashToken(text: string, cursor: number, selectionEnd = cursor): SlashToken | null {
  if (cursor !== selectionEnd) return null
  const before = text.slice(0, cursor)
  const match = /(^|\s)(\/[\p{L}\p{N}_:.-]*)$/u.exec(before)
  if (!match) return null
  // Slashes in fenced or inline code remain ordinary text.
  if ((before.match(/```/gu)?.length ?? 0) % 2) return null
  const line = before.slice(before.lastIndexOf('\n') + 1)
  if ((line.replace(/```/gu, '').match(/`/gu)?.length ?? 0) % 2) return null
  const start = cursor - match[2]!.length
  const tail = /^[^\s]*/u.exec(text.slice(cursor))?.[0] ?? ''
  if (!/^[\p{L}\p{N}_:.-]*$/u.test(tail)) return null
  return { start, end: cursor + tail.length, query: match[2]!.slice(1), text: text.slice(start, cursor + tail.length) }
}

export function buildComposerCommands(
  skills: { name: string; description?: string; path: string }[],
  prompts: { name: string; description?: string; path: string }[],
  translate: (message: string) => string = message => message,
): ComposerCommand[] {
  const raw: Array<Omit<ComposerCommand, 'search'> & { descriptionIsContent?: boolean }> = [
    { id: 'plan', name: '/plan', description: '切换到计划模式，先讨论实施方案', group: '命令', action: 'plan' },
    { id: 'default', name: '/default', description: '切换到默认模式，继续执行工作', group: '命令', action: 'default' },
    { id: 'model', name: '/model', description: '选择本次对话使用的模型', group: '命令', action: 'model' },
    { id: 'skills', name: '/skills', description: '选择技能或保存的提示词', group: '命令', action: 'skills' },
    ...APP_COMMANDS.map(command => ({ id: command.id, name: `/${command.id}`, description: command.description, group: '命令' as const, action: 'app' as const })),
    { id: 'mention', name: '/mention', description: '搜索并附加当前项目中的文件', group: '命令', action: 'mention' },
    { id: 'init', name: '/init', description: '准备项目 AGENTS.md 初始化指令，确认后发送', group: '命令', action: 'init' },
    ...prompts.map((prompt) => ({ id: `prompt:${prompt.path}`, name: `/prompts:${prompt.name}`, description: prompt.description || '插入保存的提示词', descriptionIsContent: !!prompt.description, group: '提示词' as const, action: 'prompt' as const, value: prompt.path })),
    ...skills.map((skill) => ({ id: `skill:${skill.path}`, name: `/${skill.name}`, description: skill.description || '附加此技能', descriptionIsContent: !!skill.description, group: '技能' as const, action: 'skill' as const, value: skill.path })),
  ]
  return raw.map(({ descriptionIsContent, ...row }) => {
    const description = descriptionIsContent ? row.description : translate(row.description)
    return { ...row, description, search: `${row.name} ${row.description} ${description}`.toLocaleLowerCase() }
  })
}
export function filterComposerCommands(commands: ComposerCommand[], query: string): ComposerCommand[] {
  const normalized = query.trim().toLocaleLowerCase()
  return normalized ? commands.filter((command) => command.search.includes(normalized)) : commands
}
export function commandKeyAction(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing' | 'keyCode'>, count: number, selected: number): 'dismiss' | 'next' | 'previous' | 'select' | null {
  if (event.isComposing || event.keyCode === 229 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return null
  if (event.key === 'Escape') return 'dismiss'
  if (!count) return null
  if (event.key === 'ArrowDown') return 'next'
  if (event.key === 'ArrowUp') return 'previous'
  return event.key === 'Enter' && selected >= 0 ? 'select' : null
}
