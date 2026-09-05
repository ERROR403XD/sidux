export type ComposerCommand = {
  id: string; name: string; description: string; group: '命令' | '提示词' | '技能'
  action: 'plan' | 'default' | 'model' | 'skills' | 'prompt' | 'skill'
  value?: string; search: string
}
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
): ComposerCommand[] {
  const raw: Omit<ComposerCommand, 'search'>[] = [
    { id: 'plan', name: '/plan', description: '切换到计划模式，先讨论实施方案', group: '命令', action: 'plan' },
    { id: 'default', name: '/default', description: '切换到默认模式，继续执行工作', group: '命令', action: 'default' },
    { id: 'model', name: '/model', description: '选择本次对话使用的模型', group: '命令', action: 'model' },
    { id: 'skills', name: '/skills', description: '选择技能或保存的提示词', group: '命令', action: 'skills' },
    ...prompts.map((prompt) => ({ id: `prompt:${prompt.path}`, name: `/prompts:${prompt.name}`, description: prompt.description || '插入保存的提示词', group: '提示词' as const, action: 'prompt' as const, value: prompt.path })),
    ...skills.map((skill) => ({ id: `skill:${skill.path}`, name: `/${skill.name}`, description: skill.description || '附加此技能', group: '技能' as const, action: 'skill' as const, value: skill.path })),
  ]
  return raw.map((row) => ({ ...row, search: `${row.name} ${row.description}`.toLocaleLowerCase() }))
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
