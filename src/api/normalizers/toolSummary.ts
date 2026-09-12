import type { UiMessage } from '../../types/codex'
import { normalizeSubtaskEvent } from '../../subtasks'

// Only summaries of unhandled items; never copy arguments or entire RPC payloads.
const handled = new Set(['agentMessage', 'userMessage', 'reasoning', 'plan', 'commandExecution', 'fileChange', 'imageView', 'imageGeneration', 'image_generation', 'contextCompaction'])
const labels: Record<string, string> = { mcpToolCall: 'MCP 工具', dynamicToolCall: '工具调用', collabAgentToolCall: '子任务工具', subAgentActivity: '子任务进展', webSearch: '网页搜索', contextCompaction: '上下文压缩' }
export function normalizeToolSummary(value: unknown): UiMessage | null {
  const subtask = normalizeSubtaskEvent(value)
  if (subtask) return subtask
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (typeof row.type !== 'string' || !row.type || handled.has(row.type) || typeof row.id !== 'string') return null
  const type = row.type.slice(0, 100)
  const status = typeof row.status === 'string' ? row.status.slice(0, 80) : ''
  const name = typeof row.tool === 'string' ? row.tool.slice(0, 160) : typeof row.name === 'string' ? row.name.slice(0, 160) : ''
  return {
    id: row.id, role: 'system', messageType: type, isUnhandled: true,
    text: [labels[type] || '执行事件', name, status].filter(Boolean).join(' · '),
    rawPayload: `事件类型：${type}\n${status ? `状态：${status}\n` : ''}完整内容请查看 CLI 会话。`,
  }
}
