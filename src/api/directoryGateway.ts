import { type DirectoryMcpSnapshot, readDirectoryPages, type InstalledDirectoryApp, normalizeInstalledApps } from '../directory'
import { asRecord, readString, readBoolean } from './normalizers/gatewayPayload'
import { callRpc } from './rpcGateway'

export type DirectoryPluginSummary = {
  id: string
  name: string
  displayName: string
  description: string
  longDescription: string
  developerName: string
  category: string
  marketplaceName: string
  marketplaceDisplayName: string
  marketplacePath: string | null
  remoteMarketplaceName: string | null
  sourceType: string
  sourceUrl: string
  installed: boolean
  enabled: boolean
  availability: string
  disabledReason: string
  installPolicy: string
  authPolicy: string
  logoUrl: string
  logoPath: string
  composerIconUrl: string
  composerIconPath: string
  brandColor: string
  capabilities: string[]
  defaultPrompt: string[]
  screenshotUrls: string[]
  screenshots: string[]
  websiteUrl: string
  privacyPolicyUrl: string
  termsOfServiceUrl: string
}

export type DirectoryPluginDetail = {
  summary: DirectoryPluginSummary
  description: string
  apps: DirectoryPluginAppSummary[]
  skills: DirectoryPluginSkillSummary[]
  mcpServers: string[]
}

export type DirectoryPluginAppSummary = {
  id: string
  name: string
  description: string
  installUrl: string
  needsAuth: boolean
}

export type DirectoryPluginSkillSummary = {
  name: string
  description: string
  path: string
  enabled: boolean
  displayName: string
  shortDescription: string
}

export type DirectoryPluginInstallResult = {
  authPolicy: string
  appsNeedingAuth: DirectoryPluginAppSummary[]
}

export type DirectoryAppInfo = {
  runtimeOnly?: boolean
  id: string
  name: string
  description: string
  logoUrl: string
  logoUrlDark: string
  distributionChannel: string
  installUrl: string
  isAccessible: boolean
  isEnabled: boolean
  pluginDisplayNames: string[]
  category: string
  developer: string
  website: string
  privacyPolicy: string
  termsOfService: string
  catalogRank: number
}

export type DirectoryMcpServerStatus = DirectoryMcpSnapshot

export type DirectoryMcpLoginResult = {
  authorizationUrl: string
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : []
}

function normalizeDirectoryPluginApp(value: unknown): DirectoryPluginAppSummary | null {
  const record = asRecord(value)
  if (!record) return null
  const id = readString(record.id)
  const name = readString(record.name)
  if (!id || !name) return null
  return {
    id,
    name,
    description: readString(record.description) ?? '',
    installUrl: readString(record.installUrl ?? record.install_url) ?? '',
    needsAuth: readBoolean(record.needsAuth ?? record.needs_auth) ?? false,
  }
}

function normalizeDirectoryPluginSkill(value: unknown): DirectoryPluginSkillSummary | null {
  const record = asRecord(value)
  if (!record) return null
  const name = readString(record.name)
  const path = readString(record.path)
  if (!name || !path) return null
  const iface = asRecord(record.interface)
  return {
    name,
    path,
    description: readString(record.description) ?? '',
    enabled: readBoolean(record.enabled) ?? true,
    displayName: readString(iface?.displayName ?? iface?.display_name) ?? name,
    shortDescription: readString(record.shortDescription ?? record.short_description) ?? '',
  }
}

function normalizeDirectoryPluginSummary(
  value: unknown,
  marketplace: { name?: string; displayName?: string; path?: string | null } = {},
): DirectoryPluginSummary | null {
  const record = asRecord(value)
  if (!record) return null
  const id = readString(record.id)
  const name = readString(record.name)
  if (!id || !name) return null
  const iface = asRecord(record.interface)
  const source = asRecord(record.source)
  const sourceType = readString(source?.type) ?? ''
  const sourcePath = readString(source?.path)
  const sourceUrl = readString(source?.url) ?? ''
  const remoteMarketplaceName = sourceType === 'remote' ? marketplace.name ?? null : null
  const marketplacePath = marketplace.path ?? (sourceType === 'local' ? sourcePath : null)
  const displayName = readString(iface?.displayName ?? iface?.display_name) ?? name
  const shortDescription = readString(iface?.shortDescription ?? iface?.short_description)
  const longDescription = readString(iface?.longDescription ?? iface?.long_description) ?? ''

  return {
    id,
    name,
    displayName,
    description: shortDescription ?? longDescription,
    longDescription,
    developerName: readString(iface?.developerName ?? iface?.developer_name) ?? '',
    category: readString(iface?.category) ?? '',
    marketplaceName: marketplace.name ?? '',
    marketplaceDisplayName: marketplace.displayName ?? marketplace.name ?? '',
    marketplacePath,
    remoteMarketplaceName,
    sourceType,
    sourceUrl,
    installed: readBoolean(record.installed) ?? false,
    enabled: readBoolean(record.enabled) ?? false,
    availability: readString(record.availability) ?? '',
    disabledReason: readString(record.disabledReason) ?? '',
    installPolicy: readString(record.installPolicy ?? record.install_policy) ?? '',
    authPolicy: readString(record.authPolicy ?? record.auth_policy) ?? '',
    logoUrl: readString(iface?.logoUrl ?? iface?.logo_url) ?? '',
    logoPath: readString(iface?.logo) ?? '',
    composerIconUrl: readString(iface?.composerIconUrl ?? iface?.composer_icon_url) ?? '',
    composerIconPath: readString(iface?.composerIcon ?? iface?.composer_icon) ?? '',
    brandColor: readString(iface?.brandColor ?? iface?.brand_color) ?? '',
    capabilities: readStringArray(iface?.capabilities),
    defaultPrompt: readStringArray(iface?.defaultPrompt ?? iface?.default_prompt),
    screenshotUrls: readStringArray(iface?.screenshotUrls ?? iface?.screenshot_urls),
    screenshots: readStringArray(iface?.screenshots),
    websiteUrl: readString(iface?.websiteUrl ?? iface?.website_url) ?? '',
    privacyPolicyUrl: readString(iface?.privacyPolicyUrl ?? iface?.privacy_policy_url) ?? '',
    termsOfServiceUrl: readString(iface?.termsOfServiceUrl ?? iface?.terms_of_service_url) ?? '',
  }
}

function normalizeDirectoryApp(value: unknown, catalogRank = 0): DirectoryAppInfo | null {
  const record = asRecord(value)
  if (!record) return null
  const id = readString(record.id)
  const name = readString(record.name)
  if (!id || !name) return null
  const branding = asRecord(record.branding)
  const metadata = asRecord(record.appMetadata ?? record.app_metadata)
  return {
    id,
    name,
    description: readString(record.description) ?? readString(metadata?.seoDescription ?? metadata?.seo_description) ?? '',
    logoUrl: readString(record.logoUrl ?? record.logo_url) ?? '',
    logoUrlDark: readString(record.logoUrlDark ?? record.logo_url_dark) ?? '',
    distributionChannel: readString(record.distributionChannel ?? record.distribution_channel) ?? '',
    installUrl: readString(record.installUrl ?? record.install_url) ?? '',
    isAccessible: readBoolean(record.isAccessible ?? record.is_accessible) ?? false,
    isEnabled: readBoolean(record.isEnabled ?? record.is_enabled) ?? true,
    pluginDisplayNames: readStringArray(record.pluginDisplayNames ?? record.plugin_display_names),
    category: readString(branding?.category) ?? '',
    developer: readString(branding?.developer) ?? readString(metadata?.developer) ?? '',
    website: readString(branding?.website) ?? '',
    privacyPolicy: readString(branding?.privacyPolicy ?? branding?.privacy_policy) ?? '',
    termsOfService: readString(branding?.termsOfService ?? branding?.terms_of_service) ?? '',
    catalogRank,
  }
}

type PluginPageCache = { rows: DirectoryPluginSummary[]; warnings: string[]; expiresAt: number }

const pluginPageCache = new Map<string, PluginPageCache>()

const pluginPageFlights = new Map<string, Promise<PluginPageCache>>()

export async function listDirectoryPlugins(cwds?: string[], forceRefetch = false, onWarnings?: (messages: string[]) => void): Promise<DirectoryPluginSummary[]> {
  const key = JSON.stringify([...(cwds || [])].sort())
  const cached = pluginPageCache.get(key)
  if (cached && !forceRefetch && Date.now() < cached.expiresAt) {
    onWarnings?.(cached.warnings)
    return cached.rows
  }
  let work = pluginPageFlights.get(key)
  if (!work) {
    work = (async () => {
      let warnings: string[] = []
      const rows = await fetchDirectoryPlugins(cwds, forceRefetch, value => { warnings = value })
      const next = new Date()
      next.setHours(2, 0, 0, 0)
      if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1)
      const result = { rows, warnings, expiresAt: next.getTime() }
      if (pluginPageCache.size >= 12) pluginPageCache.delete(pluginPageCache.keys().next().value!)
      pluginPageCache.set(key, result)
      return result
    })().finally(() => pluginPageFlights.delete(key))
    pluginPageFlights.set(key, work)
  }
  const result = await work
  onWarnings?.(result.warnings)
  return result.rows
}

async function fetchDirectoryPlugins(cwds?: string[], forceRefetch = false, onWarnings?: (messages: string[]) => void): Promise<DirectoryPluginSummary[]> {
  const params: Record<string, unknown> = {}
  if (cwds && cwds.length > 0) params.cwds = cwds
  if (forceRefetch) params.forceRefetch = true
  const payload = await callRpc<{ marketplaces?: unknown[]; marketplaceLoadErrors?: Array<{ message?: string }> }>('plugin/list', params)
  const warnings = (payload.marketplaceLoadErrors || []).map(error => error.message || '插件市场加载失败')
  const plugins: DirectoryPluginSummary[] = []
  for (const marketplaceValue of payload.marketplaces ?? []) {
    const marketplace = asRecord(marketplaceValue)
    if (!marketplace) continue
    const iface = asRecord(marketplace.interface)
    const meta = {
      name: readString(marketplace.name) ?? '',
      displayName: readString(iface?.displayName ?? iface?.display_name) ?? '',
      path: readString(marketplace.path),
    }
    const rows = Array.isArray(marketplace.plugins) ? marketplace.plugins : []
    for (const row of rows) {
      const plugin = normalizeDirectoryPluginSummary(row, meta)
      if (plugin) plugins.push(plugin)
    }
  }
  if (warnings.length && !plugins.length) throw new Error(warnings.join('；'))
  onWarnings?.(warnings)
  return plugins
}

export async function readDirectoryPlugin(plugin: DirectoryPluginSummary): Promise<DirectoryPluginDetail> {
  const params: Record<string, unknown> = { pluginName: plugin.name }
  if (plugin.marketplacePath) params.marketplacePath = plugin.marketplacePath
  if (plugin.remoteMarketplaceName) params.remoteMarketplaceName = plugin.remoteMarketplaceName
  const payload = await callRpc<{ plugin?: unknown }>('plugin/read', params)
  const detailRecord = asRecord(payload.plugin)
  if (!detailRecord) throw new Error('Plugin detail response is empty')
  const summary = normalizeDirectoryPluginSummary(detailRecord.summary, {
    name: readString(detailRecord.marketplaceName) ?? plugin.marketplaceName,
    displayName: plugin.marketplaceDisplayName,
    path: readString(detailRecord.marketplacePath) ?? plugin.marketplacePath,
  }) ?? plugin
  return {
    summary,
    description: readString(detailRecord.description) ?? summary.longDescription,
    apps: Array.isArray(detailRecord.apps)
      ? detailRecord.apps.map(normalizeDirectoryPluginApp).filter((row): row is DirectoryPluginAppSummary => row !== null)
      : [],
    skills: Array.isArray(detailRecord.skills)
      ? detailRecord.skills.map(normalizeDirectoryPluginSkill).filter((row): row is DirectoryPluginSkillSummary => row !== null)
      : [],
    mcpServers: readStringArray(detailRecord.mcpServers ?? detailRecord.mcp_servers),
  }
}

export async function installDirectoryPlugin(plugin: DirectoryPluginSummary): Promise<DirectoryPluginInstallResult> {
  const params: Record<string, unknown> = { pluginName: plugin.name }
  if (plugin.marketplacePath) params.marketplacePath = plugin.marketplacePath
  if (plugin.remoteMarketplaceName) params.remoteMarketplaceName = plugin.remoteMarketplaceName
  const payload = await callRpc<{ authPolicy?: string; auth_policy?: string; appsNeedingAuth?: unknown[]; apps_needing_auth?: unknown[] }>('plugin/install', params)
  const apps = payload.appsNeedingAuth ?? payload.apps_needing_auth ?? []
  return {
    authPolicy: readString(payload.authPolicy ?? payload.auth_policy) ?? '',
    appsNeedingAuth: apps.map(normalizeDirectoryPluginApp).filter((row): row is DirectoryPluginAppSummary => row !== null),
  }
}

export async function uninstallDirectoryPlugin(pluginId: string): Promise<void> {
  await callRpc('plugin/uninstall', { pluginId })
}

export async function setDirectoryPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
  await callRpc('config/batchWrite', {
    edits: [{ keyPath: `plugins.${pluginId}.enabled`, value: enabled, mergeStrategy: 'upsert' }],
    filePath: null,
    expectedVersion: null,
    reloadUserConfig: true,
  })
}

export async function listDirectoryApps(threadId?: string, forceRefetch = false): Promise<DirectoryAppInfo[]> {
  const rows = await readDirectoryPages(async cursor => {
    const params = { limit: 100, ...(cursor ? { cursor } : {}), ...(threadId ? { threadId } : {}), ...(forceRefetch && !cursor ? { forceRefetch: true } : {}) }
    const payload = await callRpc<{ data: unknown[]; nextCursor?: string | null }>('app/list', params)
    if (payload.data?.length > 100) throw new Error('App 分页响应超过上限')
    return payload
  })
  return [...new Map(rows.map((item, index) => normalizeDirectoryApp(item, index)).filter((app): app is DirectoryAppInfo => app !== null).map(app => [app.id, app])).values()]
}

export async function listInstalledDirectoryApps(threadId?: string, forceRefresh = false): Promise<InstalledDirectoryApp[]> {
  return normalizeInstalledApps(await callRpc('app/installed', { ...(threadId ? { threadId } : {}), ...(forceRefresh ? { forceRefresh: true } : {}) }))
}

export function directoryAppsFromRuntime(apps: InstalledDirectoryApp[]): DirectoryAppInfo[] {
  return apps.map((app, index) => ({
    ...normalizeDirectoryApp({ id: app.id, name: app.name || app.id, isEnabled: app.enabled, isAccessible: false }, index)!,
    runtimeOnly: true,
  }))
}

export async function setDirectoryAppEnabled(appId: string, enabled: boolean): Promise<void> {
  await callRpc('config/batchWrite', {
    edits: [{ keyPath: `apps.${appId}.enabled`, value: enabled, mergeStrategy: 'upsert' }],
    filePath: null,
    expectedVersion: null,
    reloadUserConfig: true,
  })
}

export async function listDirectoryMcpServers(threadId?: string, full = false): Promise<DirectoryMcpServerStatus[]> {
  const query = new URLSearchParams({ full: String(full) })
  if (threadId) query.set('threadId', threadId)
  const response = await fetch(`/codex-api/directory/mcps?${query}`)
  const payload = await response.json() as { data?: DirectoryMcpServerStatus[]; error?: string }
  if (!response.ok || !Array.isArray(payload.data)) throw new Error(payload.error || 'MCP 状态读取失败')
  return payload.data
}

export async function reloadDirectoryMcpServers(): Promise<void> {
  await callRpc('config/mcpServer/reload', {})
}

export async function startDirectoryMcpLogin(name: string): Promise<DirectoryMcpLoginResult> {
  const payload = await callRpc<{ authorizationUrl?: string; authorization_url?: string }>('mcpServer/oauth/login', { name })
  return {
    authorizationUrl: readString(payload.authorizationUrl ?? payload.authorization_url) ?? '',
  }
}

export type FirstLaunchPluginsCardPreference = { dismissed: boolean }

export async function getFirstLaunchPluginsCardPreference(): Promise<FirstLaunchPluginsCardPreference> {
  try {
    const response = await fetch('/codex-api/preferences/first-launch-plugins-card')
    if (!response.ok) return { dismissed: false }
    const envelope = (await response.json()) as { data?: FirstLaunchPluginsCardPreference }
    return { dismissed: envelope.data?.dismissed === true }
  } catch {
    return { dismissed: false }
  }
}

export async function persistFirstLaunchPluginsCardPreference(dismissed: boolean): Promise<void> {
  try {
    await fetch('/codex-api/preferences/first-launch-plugins-card', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dismissed }),
    })
  } catch {
    // Best-effort persist
  }
}
