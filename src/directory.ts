type Row = Record<string, unknown>
const row = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const text = (value: unknown, limit = 240): string => typeof value === 'string' ? value.slice(0, limit) : ''

export function formatDirectoryError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback
  if (/read remote plugin details|remote plugin catalog request/i.test(message) && /status 404\b/i.test(message)) {
    return '官方插件详情暂不可用（404），请稍后重试。'
  }
  const htmlIndex = message.search(/<(?:!doctype|html|head|body|script)\b/i)
  if (htmlIndex >= 0 && /failed to list apps/i.test(message) && /status 403\b/i.test(message)) return '应用目录暂时无法读取（上游 HTTP 403）。'
  const brief = (htmlIndex >= 0 ? message.slice(0, htmlIndex) : message).replace(/\s+/g, ' ').trim()
  return brief.slice(0, 500) || fallback
}

// The legacy URLs still returned by plugin/read redirect to the generic catalog.
// These exact replacements were verified against https://chatgpt.com/plugins.
// Preserve new URLs and other providers instead of guessing their plugin IDs.
export function pluginManagementUrl(installUrl: string): string {
  const replacements: Record<string, string> = {
    'https://chatgpt.com/apps/gmail/connector_2128aebfecb84f64a069897515042a44': 'https://chatgpt.com/plugins/plugin_connector_1p_95d39881713c8191931482a62d6edff9',
    'https://chatgpt.com/apps/google-drive/connector_5f3c8c41a1e54ad7a76272c89e2554fa': 'https://chatgpt.com/plugins/plugin_connector_1p_ab21a553bfbc81919ea8fd1858e3ffa7',
  }
  return replacements[installUrl] || installUrl
}

export type InstalledDirectoryApp = { id: string; enabled: boolean; callable: boolean; name: string }
export function normalizeInstalledApps(value: unknown): InstalledDirectoryApp[] {
  const apps = row(value).apps
  if (!Array.isArray(apps)) throw new Error('App 运行状态响应无效')
  return apps.map(item => {
    const app = row(item)
    if (!app.id || typeof app.enabled !== 'boolean' || typeof app.callable !== 'boolean') throw new Error('App 运行状态字段不完整')
    return { id: text(app.id), enabled: app.enabled, callable: app.callable, name: text(app.runtimeName) }
  })
}

export type DirectorySkill = {
  name: string; path: string; description: string; scope: string; enabled?: boolean; pluginId: string
  owner: string; installed: boolean; url: string; canUninstall: boolean
}
export function normalizeDirectorySkills(value: unknown): { installed: DirectorySkill[]; errors: string[] } {
  const data = row(value).data
  if (!Array.isArray(data)) throw new Error('技能列表响应无效')
  const skills = new Map<string, DirectorySkill>()
  const errors: string[] = []
  for (const entry of data) {
    const group = row(entry)
    for (const item of Array.isArray(group.skills) ? group.skills : []) {
      const skill = row(item)
      const path = text(skill.path, 4096)
      const name = text(skill.name)
      if (!path || !name) continue
      const scope = text(skill.scope)
      const pluginId = text(skill.pluginId)
      skills.set(path, {
        name, path, description: text(skill.description, 4000), scope, pluginId,
        enabled: typeof skill.enabled === 'boolean' ? skill.enabled : undefined,
        owner: 'local', installed: true, url: '', canUninstall: scope === 'user' && !pluginId,
      })
    }
    for (const item of Array.isArray(group.errors) ? group.errors : []) {
      const error = row(item)
      errors.push(`${text(error.path, 4096)}: ${text(error.message, 2000)}`)
    }
  }
  return { installed: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)), errors }
}

export type DirectoryMcpSnapshot = {
  name: string; authStatus: string; runtimeStatus: string | null; pluginId: string
  tools: Array<{ name: string; title: string; description: string }>
  resources: Array<{ name: string; title: string; uri: string; description: string }>
  resourceTemplates: Array<{ name: string; title: string; uriTemplate: string; description: string }>
  toolCount: number; resourceCount: number | null; detailsLoaded: boolean; truncated: boolean
}
export function compactMcpStatus(value: unknown, full: boolean): DirectoryMcpSnapshot {
  const server = row(value)
  if (!server.name) throw new Error('MCP 状态响应缺少名称')
  const tools = Object.entries(row(server.tools))
  const resources = Array.isArray(server.resources) ? server.resources : []
  const templates = Array.isArray(server.resourceTemplates) ? server.resourceTemplates : []
  const names = (value: unknown) => ({ name: text(row(value).name), title: text(row(value).title), description: '' })
  return {
    name: text(server.name), authStatus: text(server.authStatus) || 'unknown',
    runtimeStatus: typeof server.runtimeStatus === 'string' ? server.runtimeStatus : null,
    pluginId: text(server.pluginId), toolCount: tools.length,
    resourceCount: full ? resources.length + templates.length : null,
    tools: full ? tools.slice(0, 200).map(([name, tool]) => ({ ...names(tool), name: text(row(tool).name) || name })) : [],
    resources: full ? resources.slice(0, 200).map(item => ({ ...names(item), uri: text(row(item).uri, 1000) })) : [],
    resourceTemplates: full ? templates.slice(0, 200).map(item => ({ ...names(item), uriTemplate: text(row(item).uriTemplate, 1000) })) : [],
    detailsLoaded: full, truncated: full && (tools.length > 200 || resources.length > 200 || templates.length > 200),
  }
}

/** At most 20 pages. Repeated cursors must fail visibly, never loop or claim completeness. */
export async function readDirectoryPages<T>(read: (cursor: string | null) => Promise<{ data: T[]; nextCursor?: string | null }>): Promise<T[]> {
  const results: T[] = []
  const seen = new Set<string>()
  let cursor: string | null = null
  for (let page = 0; page < 20; page += 1) {
    const result = await read(cursor)
    if (!Array.isArray(result.data)) throw new Error('扩展列表响应无效')
    results.push(...result.data)
    cursor = result.nextCursor || null
    if (!cursor) return results
    if (seen.has(cursor)) throw new Error('扩展列表返回重复游标，请刷新重试')
    seen.add(cursor)
  }
  throw new Error('扩展列表超过 20 页，无法确认完整结果')
}

export function mcpRuntimeLabel(status: string | null): string {
  return ({ notStarted: '未启动', starting: '启动中', connected: '已连接', authenticationRequired: '需要认证', failed: '连接失败', cancelled: '已取消', disabled: '已禁用' } as Record<string, string>)[status || ''] || '运行状态未知'
}
