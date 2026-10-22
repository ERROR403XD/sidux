/**
 * 管理接口 `/models` 有两种返回形态：自定义连接返回模型能力数组，OpenAI 账号返回上游目录对象。
 * 这里只提取模型名，供 key 路由的模型输入框做候选，其他字段不参与路由。
 */
export function apiProxyModelNames(payload: unknown): string[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : []
  const names: string[] = []
  for (const row of rows) {
    if (typeof row === 'string') {
      const value = row.trim()
      if (value && !names.includes(value)) names.push(value)
      continue
    }
    if (!row || typeof row !== 'object') continue
    const record = row as { id?: unknown; model?: unknown }
    const name = typeof record.id === 'string' ? record.id.trim() : typeof record.model === 'string' ? record.model.trim() : ''
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

/** 输入框候选：按当前输入做包含匹配，输入等于某个模型名时不再重复列出它。 */
export function apiProxyModelSuggestions(models: string[], query: string, limit = 60): string[] {
  const value = query.trim()
  const needle = value.toLowerCase()
  const matched = needle ? models.filter(name => name !== value && name.toLowerCase().includes(needle)) : models
  return matched.slice(0, limit)
}

/** 模型目录读取状态；idle 表示还没有为这个账号触发过读取。 */
export type ApiProxyModelCatalogState = 'idle' | 'loading' | 'ready' | 'failed'

export interface ApiProxyModelMenuState {
  suggestions: string[]
  emptyMessage: string
  visible: boolean
}

const API_PROXY_MODEL_MENU_MESSAGES: Record<ApiProxyModelCatalogState, string> = {
  idle: '',
  loading: '正在读取模型目录…',
  ready: '目录中没有匹配的模型，可自行输入。',
  failed: '无法读取该账号的模型目录，可自行输入。',
}

/**
 * 候选浮层状态：有候选就列候选；没有候选时只在确实读过目录（loading/ready/failed）才提示。
 * idle 表示没有可用账号或还没触发读取，此时完全不弹层，用户只能自行输入。
 */
export function apiProxyModelMenuState(models: string[], query: string, state: ApiProxyModelCatalogState): ApiProxyModelMenuState {
  const suggestions = apiProxyModelSuggestions(models, query)
  if (suggestions.length) return { suggestions, emptyMessage: '', visible: true }
  const emptyMessage = API_PROXY_MODEL_MENU_MESSAGES[state]
  return { suggestions, emptyMessage, visible: !!emptyMessage }
}
