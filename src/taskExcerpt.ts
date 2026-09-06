export type TaskExcerpt = { threadId: string; title: string; text: string; truncated: boolean; turnCount: number; hasMoreOlder: boolean }
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' ? value as Record<string, any> : {}
export function extractTaskExcerpt(thread: unknown, hasMoreOlder = false): TaskExcerpt {
  const row = record(thread)
  const turns = Array.isArray(row.turns) ? row.turns.slice(-10) : []
  const fragments: string[] = []
  let remaining = 6000
  let truncated = hasMoreOlder
  outer: for (const turn of [...turns].reverse()) {
    const items = Array.isArray(turn.items) ? turn.items : []
    for (let index = items.length - 1; index >= 0; index--) {
      const item = record(items[index])
      let text = ''
      if (item.type === 'agentMessage' && item.phase !== 'commentary' && typeof item.text === 'string') text = '助手：' + item.text
      if (item.type === 'userMessage' && Array.isArray(item.content)) {
        text = '用户：' + item.content.filter((v: any) => v?.type === 'text' && typeof v.text === 'string').map((v: any) => v.text).join('\n')
      }
      if (!text || text === '用户：') continue
      if (remaining <= 0) { truncated = true; break outer }
      if (text.length > remaining) truncated = true
      fragments.unshift(text.slice(0, remaining))
      remaining -= Math.min(text.length, remaining) + 2
    }
  }
  return { threadId: typeof row.id === 'string' ? row.id : '', title: String(row.name || row.title || row.preview || '未命名任务').slice(0, 120), text: fragments.join('\n\n'), truncated, turnCount: turns.length, hasMoreOlder }
}

export function taskExcerptDraft(excerpt: TaskExcerpt): string {
  const title = excerpt.title.replace(/[\[\]\r\n]/g, ' ')
  const scope = `最近 ${excerpt.turnCount} 回合的用户与助手摘录${excerpt.truncated ? '，内容已截取' : ''}`
  return `参考任务：[${title}](codex://threads/${excerpt.threadId})\n${scope}：\n\n${excerpt.text.split('\n').map(line => '> ' + line).join('\n')}\n`
}
