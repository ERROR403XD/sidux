<template>
  <div class="directory-hub">
    <header class="directory-header">
      <h1 class="directory-title">{{ t('应用') }}</h1>
      <AppButton v-if="activeTab !== 'plugins'" :busy="loading" @click="refresh(true)">{{ t('刷新') }}</AppButton>
    </header>
    <nav class="directory-tabs" :aria-label="t('扩展分类')">
      <button v-for="tab in tabs" :key="tab.id" type="button" class="directory-tab" :class="{ 'is-active': activeTab === tab.id }" :aria-label="t(tab.label)" :aria-pressed="activeTab === tab.id" :disabled="busy" @click="selectTab(tab.id)">
        <strong>{{ t(tab.label) }}</strong>
      </button>
    </nav>
    <div class="directory-scope">
      <div class="directory-scope-picker"><span>{{ t('查看范围') }}</span><AppSelect :model-value="props.cwd || ''" :options="scopeOptions" enable-search :search-placeholder="t('搜索项目')" :disabled="busy" @update:model-value="emit('scope-change', $event)" /></div>
      <a v-if="props.threadId" class="directory-back" :href="`#/thread/${props.threadId}`">{{ t('返回会话') }} {{ props.threadId.slice(-8) }}</a>
    </div>
    <p v-if="notice" class="directory-toast" role="status">{{ t(notice) }}</p>
    <p v-if="error" class="directory-error" role="alert">{{ t(error) }}</p>
    <section v-if="activeTab === 'plugins'" class="directory-section">
      <div class="directory-toolbar">
        <input v-model="search" class="directory-search" type="search" :placeholder="t('搜索插件')" :aria-label="t('搜索插件')" />
        <AppSelect v-model="pluginFilter" :options="pluginFilterOptions.map(option => ({ ...option, label: t(option.label) }))" />
        <AppButton class="directory-refresh" :busy="loading" @click="refresh(true)">{{ t('刷新') }}</AppButton>
      </div>
      <p v-if="ready && supportsPlugins && !loading" class="directory-results-count">{{ filteredPlugins.length }} {{ t('个插件') }}<span v-if="installedCount"> {{ t('· 已安装') }} {{ installedCount }} {{ t('个') }}</span></p>
      <p v-if="!supportsPlugins && ready" class="directory-empty">{{ t('当前 Codex CLI 未提供原版插件接口。可继续管理技能和 MCP。') }}</p>
      <p v-else-if="loading && !plugins.length" class="directory-loading">{{ t('读取插件…') }}</p>
      <p v-else-if="!visiblePlugins.length" class="directory-empty">{{ t(search || pluginFilter !== 'all' ? '没有匹配的插件，试试其他关键词或筛选条件。' : '暂无插件。配置原版插件市场后刷新即可查看。') }}</p>
      <div v-if="plugins.length" class="directory-grid">
        <button v-for="plugin in visiblePlugins" :key="plugin.id" type="button" class="directory-card" @click="openPluginDetail(plugin)">
          <div class="directory-card-top">
            <img v-if="pluginIconSrc(plugin)" class="directory-card-icon" :src="pluginIconSrc(plugin)" alt="" loading="lazy" />
            <span v-else class="directory-card-fallback">{{ plugin.displayName.charAt(0) }}</span>
            <div class="directory-card-main"><strong :title="plugin.displayName">{{ plugin.displayName }}</strong><span class="directory-card-meta">{{ plugin.developerName || plugin.marketplaceDisplayName || plugin.marketplaceName }}</span></div>
          </div>
          <p class="directory-card-description">{{ plugin.description || t('查看技能、MCP 与连接要求') }}</p>
          <div class="directory-card-footer"><div class="directory-card-tags"><span v-for="capability in plugin.capabilities" :key="capability" class="directory-chip">{{ capability }}</span></div><span class="directory-plugin-status" :class="{ 'is-installed': plugin.installed }">{{ t(plugin.installed ? (plugin.enabled ? '已启用' : '已停用') : (plugin.installPolicy === 'NOT_AVAILABLE' || plugin.availability === 'DISABLED_BY_ADMIN' ? '受限' : '可安装')) }}</span></div>
        </button>
      </div>
      <div v-if="filteredPlugins.length > 60" class="directory-pagination">
        <AppButton :disabled="pluginPage <= 1" @click="pluginPage -= 1">{{ t('上一页') }}</AppButton>
        <AppSelect :model-value="String(pluginPage)" :options="pluginPageOptions" :aria-label="t('选择页面')" enable-search @update:model-value="pluginPage = Number($event)" />
        <span>{{ filteredPlugins.length }} {{ t('个插件') }}</span>
        <AppButton :disabled="pluginPage >= pluginPageCount" @click="pluginPage += 1">{{ t('下一页') }}</AppButton>
      </div>
    </section>
    <section v-else class="directory-section">
      <SkillsHub
        ref="skillsHubRef"
        :cwd="props.cwd"
        :try-in-flight-key="props.tryInFlightKey"
        @skills-changed="onDirectorySkillsChanged"
        @try-item="(payload) => emit('try-item', payload)"
      >
        <template #before-search>
          <div class="skills-embedded-section">
            <DirectorySectionToggle :title="t('MCP 连接')" :count="visibleMcpServers.length" :open="isMcpSectionOpen" @toggle="isMcpSectionOpen = !isMcpSectionOpen" />
            <div v-if="isMcpSectionOpen" class="skills-embedded-body">
              <div class="directory-mcp-toolbar"><p class="directory-scope-note">{{ t('查看已配置服务、连接状态与可用工具。') }}</p><AppButton v-if="supportsMcpReload" :busy="isReloadingMcps" @click="reloadMcps">{{ t('重载配置') }}</AppButton></div>
              <div v-if="!supportsMcps" class="directory-empty">
                {{ t('MCP status APIs unavailable in this Codex CLI. Update Codex CLI to inspect MCP servers.') }}
              </div>
              <div v-else-if="mcpError" class="directory-error">{{ t(mcpError) }}</div>
              <div v-else-if="isLoadingMcps" class="directory-loading">{{ t('Loading MCP servers...') }}</div>
              <div v-else-if="visibleMcpServers.length === 0" class="directory-empty">{{ t('No MCP servers configured.') }}</div>
              <div v-else class="mcp-skill-grid">
                <article v-for="server in visibleMcpServers" :key="server.name">
                  <button class="mcp-skill-card" type="button" :aria-expanded="expandedMcpNames.has(server.name)" @click="toggleMcpExpanded(server.name)">
                    <div class="mcp-skill-card-top">
                      <div class="mcp-skill-avatar-fallback">{{ server.name.charAt(0) }}</div>
                      <div class="mcp-skill-info">
                        <div class="mcp-skill-header">
                          <span class="mcp-skill-name">{{ server.name }}</span>
                          <span class="mcp-skill-badge" :class="mcpCardBadgeClass(server.authStatus)">{{ t(formatMcpAuthStatus(server.name)) }}</span>
                        </div>
                        <span class="mcp-skill-owner">{{ t(mcpRuntimeLabel(server.runtimeStatus)) }}</span>
                      </div>
                      <span class="mcp-skill-chevron" :class="{ 'is-open': expandedMcpNames.has(server.name) }">›</span>
                    </div>
                    <p class="mcp-skill-meta">{{ server.toolCount }} {{ t('个工具') }}<span v-if="server.resourceCount !== null"> · {{ server.resourceCount }} {{ t('项资源') }}</span></p>
                    <div v-if="expandedMcpNames.has(server.name)" class="directory-mcp-detail">
                      <p v-if="mcpDetailError">{{ t(mcpDetailError) }}</p>
                      <p v-else-if="!server.detailsLoaded">{{ t('读取工具与资源…') }}</p>
                      <p v-if="server.truncated">{{ t('每类仅预览前 200 项') }}</p>
                      <div v-if="server.tools.length > 0">
                        <h3 class="directory-mini-heading">{{ t('Tools') }}</h3>
                        <p class="directory-mini-list">{{ server.tools.map((tool) => tool.title || tool.name).join(', ') }}</p>
                      </div>
                      <div v-if="server.resources.length > 0 || server.resourceTemplates.length > 0">
                        <h3 class="directory-mini-heading">{{ t('Resources') }}</h3>
                        <p class="directory-mini-list">
                          {{ [...server.resources.map((r) => r.title || r.name || r.uri), ...server.resourceTemplates.map((r) => r.title || r.name || r.uriTemplate)].join(', ') }}
                        </p>
                      </div>
                    </div>
                  </button>
                </article>
              </div>
            </div>
          </div>
        </template>
      </SkillsHub>
    </section>

    <AppDialog :open="!!selectedPlugin" :title="selectedPlugin?.displayName || t('插件')" :busy="busy" @close="closeDetail">
      <p v-if="detailLoading">{{ t('读取插件详情…') }}</p>
      <div v-if="detailError" class="directory-error" role="alert">
        <p>{{ t(detailError) }}</p>
        <p v-if="!detail" class="directory-plugin-description">{{ selectedPlugin?.description }}</p>
        <AppButton v-if="selectedPlugin" :disabled="detailLoading || busy" @click="openPluginDetail(selectedPlugin)">{{ t('重试') }}</AppButton>
      </div>
      <template v-if="detail">
        <p class="directory-plugin-description">{{ detail.description || detail.summary.description }}</p>
        <p v-if="unavailable" class="directory-error">{{ detail.summary.disabledReason || t('此插件当前不可安装') }}</p>
        <div v-if="detail.skills.length" class="directory-detail-group"><h3>{{ t('技能') }}</h3><p v-for="skill in detail.skills" :key="skill.path || skill.name"><strong>{{ skill.displayName || skill.name }}</strong> · {{ skill.shortDescription || skill.description }}</p></div>
        <div v-if="detail.mcpServers.length" class="directory-detail-group"><h3>MCP</h3><p v-for="name in detail.mcpServers" :key="name">{{ name }} <AppButton v-if="shouldShowMcpLogin(name)" :busy="mcpLoginServerName === name" @click="loginMcpServer(name)">{{ t('连接') }}</AppButton></p></div>
        <div v-if="detail.apps.length || authApps.length" class="directory-detail-group"><h3>{{ t('服务连接') }}</h3><p v-for="app in connectionApps" :key="app.id">{{ app.name }} <a v-if="app.installUrl" :href="pluginManagementUrl(app.installUrl)" target="_blank" rel="noopener noreferrer">{{ t(app.needsAuth ? '在 ChatGPT 中连接' : '在 ChatGPT 中管理') }}</a><span v-else> · {{ t(app.needsAuth ? '安装后按提示授权' : '由原版插件管理') }}</span></p></div>
        <p class="directory-scope-note">{{ t('安装或更改后，新会话会使用最新配置。') }}</p>
      </template>
      <template #footer>
        <template v-if="selectedPlugin?.installed">
          <AppButton variant="danger" :busy="busy" @click="changePlugin('uninstall')">{{ t('卸载') }}</AppButton>
          <AppSwitch :disabled="busy" :model-value="selectedPlugin.enabled" @change="changePlugin('toggle')">{{ t('启用') }}</AppSwitch>
          <AppButton v-if="selectedPlugin.enabled" :disabled="busy || !!props.tryInFlightKey || !detail" @click="tryPlugin">{{ t('试用') }}</AppButton>
        </template>
        <AppButton v-else :busy="busy" :disabled="!detail || unavailable" @click="changePlugin('install')">{{ t('安装') }}</AppButton>
      </template>
    </AppDialog>
  </div>
</template>
<script setup lang="ts">
import { useTransientNotice } from '../../composables/useTransientNotice'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppButton from '../common/AppButton.vue'
import AppSwitch from '../common/AppSwitch.vue'
import AppDialog from '../common/AppDialog.vue'
import AppSelect from '../common/AppSelect.vue'
import SkillsHub from './SkillsHub.vue'
import DirectorySectionToggle from './DirectorySectionToggle.vue'
import { useUiLanguage } from '../../composables/useUiLanguage'
import { formatDirectoryError, pluginManagementUrl, mcpRuntimeLabel } from '../../directory'
import { subscribeTaskNotifications } from '../../subtasks'
import { getMethodCatalog, listDirectoryPlugins, readDirectoryPlugin, installDirectoryPlugin, uninstallDirectoryPlugin, setDirectoryPluginEnabled, listDirectoryMcpServers, reloadDirectoryMcpServers, startDirectoryMcpLogin, type DirectoryPluginSummary, type DirectoryPluginDetail, type DirectoryPluginAppSummary, type DirectoryMcpServerStatus } from '../../api/codexGateway'

export type DirectoryTryItemPayload = { kind: 'plugin' | 'skill'; name: string; displayName: string; skillPath?: string; prompt?: string; attachedSkills?: Array<{ name: string; path: string }> }
const props = defineProps<{ cwd?: string; threadId?: string; projects?: Array<{ value: string; label: string }>; tryInFlightKey?: string }>()
const emit = defineEmits<{ 'scope-change': [cwd: string]; 'skills-changed': []; 'try-item': [payload: DirectoryTryItemPayload] }>()
const { t } = useUiLanguage()
const route = useRoute()
const router = useRouter()
const tabs = [{ id: 'plugins', label: '插件' }, { id: 'skills', label: '技能 / MCP' }] as const
const activeTab = computed(() => route.query.tab === 'plugins' ? 'plugins' : 'skills')
const scopeOptions = computed(() => [{ value: '', label: t('全局') }, ...(props.projects || [])])
const methods = ref(new Set<string>())
const ready = ref(false)
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const notice = useTransientNotice()
const search = ref('')
const pluginFilter = ref('all')
const pluginFilterOptions = [{ value: 'all', label: '全部插件' }, { value: 'installed', label: '已安装' }, { value: 'available', label: '未安装' }]
const plugins = ref<DirectoryPluginSummary[]>([])
const selectedPlugin = ref<DirectoryPluginSummary | null>(null)
const detail = ref<DirectoryPluginDetail | null>(null)
const detailLoading = ref(false)
const detailError = ref('')
const authApps = ref<DirectoryPluginAppSummary[]>([])
const supportsPlugins = computed(() => ['plugin/list', 'plugin/read', 'plugin/install', 'plugin/uninstall'].every(method => methods.value.has(method)))
const unavailable = computed(() => selectedPlugin.value?.installPolicy === 'NOT_AVAILABLE' || selectedPlugin.value?.availability === 'DISABLED_BY_ADMIN')
const pluginPage = ref(1)
const sortedPlugins = computed(() => [...plugins.value].sort((a, b) => Number(b.installed) - Number(a.installed) || a.displayName.localeCompare(b.displayName)))
const installedCount = computed(() => plugins.value.filter(plugin => plugin.installed).length)
const filteredPlugins = computed(() => {
  const query = search.value.trim().toLowerCase()
  return sortedPlugins.value.filter(plugin => {
    const matchesFilter = pluginFilter.value === 'all' || (pluginFilter.value === 'installed' ? plugin.installed : !plugin.installed)
    return matchesFilter && `${plugin.displayName} ${plugin.description}`.toLowerCase().includes(query)
  })
})
const pluginPageCount = computed(() => Math.max(1, Math.ceil(filteredPlugins.value.length / 60)))
const pluginPageOptions = computed(() => Array.from({ length: pluginPageCount.value }, (_, index) => ({ value: String(index + 1), label: `${index + 1} / ${pluginPageCount.value}` })))
const visiblePlugins = computed(() => filteredPlugins.value.slice((pluginPage.value - 1) * 60, pluginPage.value * 60))
watch([search, pluginFilter, plugins], () => { pluginPage.value = 1 })
const connectionApps = computed(() => [...new Map([...(detail.value?.apps || []), ...authApps.value].map(app => [app.id, app])).values()])
const skillsHubRef = ref<InstanceType<typeof SkillsHub> | null>(null)
const mcpServers = ref<DirectoryMcpServerStatus[]>([])
const visibleMcpServers = computed(() => mcpServers.value)
const supportsMcps = computed(() => methods.value.has('mcpServerStatus/list'))
const supportsMcpReload = computed(() => methods.value.has('config/mcpServer/reload'))
const isMcpSectionOpen = ref(true)
const expandedMcpNames = ref(new Set<string>())
const isLoadingMcps = ref(false)
const isReloadingMcps = ref(false)
const mcpError = ref('')
const mcpDetailError = ref('')
const mcpLoginServerName = ref('')
let disposed = false
let revision = 0
let detailRevision = 0
let refreshFlight: Promise<void> | null = null
let mcpFlight: Promise<void> | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null
function pluginIconSrc(plugin: DirectoryPluginSummary): string {
  if (plugin.logoUrl) return plugin.logoUrl
  return plugin.logoPath ? `/codex-local-image?path=${encodeURIComponent(plugin.logoPath)}` : ''
}
function selectTab(tab: 'plugins' | 'skills'): void {
  void router.replace({ query: { ...route.query, tab } })
}
async function refresh(force = false): Promise<void> {
  if (refreshFlight) {
    await refreshFlight
    if (!force || disposed) return
  }
  const current = revision
  loading.value = true
  error.value = ''
  refreshFlight = (async () => {
    try {
      if (!ready.value) {
        const catalog = await getMethodCatalog()
        if (disposed || current !== revision) return
        methods.value = new Set(catalog)
        ready.value = true
      }
      if (activeTab.value === 'plugins' && supportsPlugins.value) {
        const next = await listDirectoryPlugins(props.cwd ? [props.cwd] : undefined, force, warnings => {
          if (!disposed && current === revision && warnings.length) error.value = `部分插件市场读取失败：${warnings.join('；')}`
        })
        if (!disposed && current === revision) plugins.value = next
      } else if (activeTab.value === 'skills') {
        await Promise.all([loadMcps(), force ? skillsHubRef.value?.refresh(true) : undefined])
      }
    } catch (failure) {
      if (!disposed && current === revision) error.value = formatDirectoryError(failure, '扩展读取失败')
    } finally {
      loading.value = false
      refreshFlight = null
    }
  })()
  await refreshFlight
}
async function loadMcps(full = false): Promise<void> {
  if (!supportsMcps.value || disposed) return
  if (mcpFlight) {
    await mcpFlight
    if (!full || disposed) return
  }
  const current = revision
  isLoadingMcps.value = !mcpServers.value.length
  mcpError.value = ''
  mcpDetailError.value = ''
  mcpFlight = (async () => {
    try {
      const next = await listDirectoryMcpServers(props.threadId || undefined, full)
      if (!disposed && current === revision) mcpServers.value = next
    } catch (failure) {
      if (!disposed && current === revision) {
        const message = formatDirectoryError(failure, 'MCP 状态读取失败')
        if (full) mcpDetailError.value = message
        else mcpError.value = message
      }
    } finally {
      isLoadingMcps.value = false
      mcpFlight = null
    }
  })()
  await mcpFlight
}
function toggleMcpExpanded(name: string): void {
  const next = new Set(expandedMcpNames.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  expandedMcpNames.value = next
  if (next.has(name) && !mcpServers.value.find(server => server.name === name)?.detailsLoaded) void loadMcps(true)
}
function formatMcpAuthStatus(name: string): string {
  const status = mcpServers.value.find(server => server.name === name)?.authStatus
  return ({ oAuth: '已授权', notLoggedIn: '未登录', bearerToken: '令牌认证', unsupported: '无需 OAuth' } as Record<string, string>)[status || ''] || '认证未知'
}
function mcpCardBadgeClass(status: string): string { return status === 'notLoggedIn' ? 'needs-auth' : '' }
function shouldShowMcpLogin(name: string): boolean { return methods.value.has('mcpServer/oauth/login') && mcpServers.value.some(server => server.name === name && server.authStatus === 'notLoggedIn') }
async function loginMcpServer(name: string): Promise<void> {
  mcpLoginServerName.value = name
  try {
    const result = await startDirectoryMcpLogin(name)
    if (!result.authorizationUrl) throw new Error('未返回授权地址')
    window.open(result.authorizationUrl, '_blank', 'noopener,noreferrer')
    notice.value = '已打开授权页面'
  } catch (failure) { error.value = formatDirectoryError(failure, '连接失败') }
  finally { mcpLoginServerName.value = '' }
}
async function reloadMcps(): Promise<void> {
  isReloadingMcps.value = true
  try {
    await reloadDirectoryMcpServers()
    await loadMcps()
    notice.value = 'MCP 配置已重载。'
  } catch (failure) { error.value = formatDirectoryError(failure, 'MCP 重载失败') }
  finally { isReloadingMcps.value = false }
}
async function openPluginDetail(plugin: DirectoryPluginSummary): Promise<void> {
  const current = ++detailRevision
  selectedPlugin.value = plugin
  detail.value = null
  authApps.value = []
  detailError.value = ''
  detailLoading.value = true
  try {
    const next = await readDirectoryPlugin(plugin)
    if (disposed || current !== detailRevision) return
    detail.value = next
    selectedPlugin.value = next.summary
    if (next.mcpServers.length) await loadMcps()
  } catch (failure) {
    if (!disposed && current === detailRevision) detailError.value = formatDirectoryError(failure, '插件读取失败')
  } finally {
    if (current === detailRevision) detailLoading.value = false
  }
}
function closeDetail(): void {
  detailRevision += 1
  selectedPlugin.value = null
}
async function changePlugin(action: 'install' | 'uninstall' | 'toggle'): Promise<void> {
  const plugin = selectedPlugin.value
  if (!plugin || busy.value) return
  busy.value = true
  detailError.value = ''
  try {
    let connections: DirectoryPluginAppSummary[] = []
    if (action === 'install') connections = (await installDirectoryPlugin(plugin)).appsNeedingAuth
    else if (action === 'uninstall') await uninstallDirectoryPlugin(plugin.id)
    else await setDirectoryPluginEnabled(plugin.id, !plugin.enabled)
    await refresh(true)
    if (error.value) throw new Error(`设置已保存，${error.value}`)
    emit('skills-changed')
    const updated = plugins.value.find(item => item.id === plugin.id)
    if (action === 'uninstall') closeDetail()
    else if (updated) await openPluginDetail(updated)
    authApps.value = connections
    notice.value = '插件设置已保存'
  } catch (failure) { detailError.value = formatDirectoryError(failure, '插件操作失败') }
  finally { busy.value = false }
}
function tryPlugin(): void {
  const plugin = selectedPlugin.value
  if (!plugin || !detail.value) return
  emit('try-item', { kind: 'plugin', name: plugin.name, displayName: plugin.displayName, prompt: plugin.defaultPrompt[0], attachedSkills: detail.value.skills.filter(skill => skill.enabled).map(skill => ({ name: skill.name, path: skill.path })) })
  closeDetail()
}
function onDirectorySkillsChanged(): void { emit('skills-changed') }
const signatures = new Map<string, string>()
const unsubscribe = subscribeTaskNotifications(notification => {
  if (activeTab.value === 'plugins' || !['skills/changed', 'mcpServer/startupStatus/updated', 'mcpServer/oauthLogin/completed'].includes(notification.method)) return
  const signature = JSON.stringify(notification.params)
  if (signatures.get(notification.method) === signature) return
  signatures.set(notification.method, signature)
  if (refreshTimer) return
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    if (!disposed) void refresh(true)
  }, 250)
})
watch(() => [props.cwd, props.threadId, activeTab.value], () => {
  revision += 1
  closeDetail()
  plugins.value = []
  mcpServers.value = []
  expandedMcpNames.value = new Set()
  void refresh()
})
onMounted(() => { void refresh() })
onBeforeUnmount(() => {
  disposed = true
  revision += 1
  detailRevision += 1
  unsubscribe()
  if (refreshTimer) clearTimeout(refreshTimer)
})
</script>
<style scoped>
.directory-hub { display: flex; flex-direction: column; gap: 20px; height: 100%; overflow-y: auto; color: var(--ui-text); }
.directory-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.directory-back { color: var(--ui-muted); font-size: 12px; text-decoration: none; }
.directory-back:hover { color: var(--ui-text); text-decoration: underline; }
.directory-title { margin: 10px 0 6px; font-size: 24px; line-height: 1.3; font-weight: 650; }
.directory-subtitle { margin: 0; color: var(--ui-muted); font-size: 13px; line-height: 1.6; }
.directory-tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; padding: 6px; border: 1px solid var(--ui-divider); border-radius: var(--ui-radius-dialog); background: var(--ui-hover); }
.directory-tab { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 13px 16px; border: 1px solid transparent; border-radius: var(--ui-radius-popover); background: transparent; color: var(--ui-muted); text-align: center; cursor: pointer; transition: background .15s; }
.directory-tab strong { font-size: 14px; font-weight: 600; }
.directory-tab span { font-size: 12px; }
.directory-tab.is-active { border-color: var(--ui-divider); background: var(--ui-surface); color: var(--ui-text); box-shadow: 0 1px 3px #00000008; }
.directory-tab:focus-visible, .directory-card:focus-visible, .mcp-skill-card:focus-visible { outline: 2px solid var(--ui-focus); outline-offset: 2px; }
.directory-scope { max-width: none; margin: 0; gap: 10px 20px; }
.directory-scope-picker { display: flex; align-items: center; gap: 12px; min-width: 0; font-size: 12px; color: var(--ui-muted); }
.directory-scope-picker > span { flex-shrink: 0; }
.directory-scope-picker :deep(.app-select) { width: 240px; max-width: 100%; min-width: 0; }
.directory-scope > p { flex: 1 1 260px; line-height: 1.6; }
.directory-section { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.directory-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.directory-toolbar > .app-select { flex: 0 0 145px; }
.directory-refresh { margin-left: auto; flex-shrink: 0; }
.directory-search { min-width: 0; flex: 1 1 180px; width: auto; height: 40px; padding: 9px 12px; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-control); background: var(--ui-field); color: var(--ui-text); font-size: 13px; }
.directory-search:focus-visible { outline: 2px solid var(--ui-focus); outline-offset: 1px; }
.directory-results-count { margin: 0; color: var(--ui-muted); font-size: 12px; }
.directory-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 270px), 1fr)); gap: 14px; }
.directory-card { display: flex; flex-direction: column; gap: 14px; min-width: 0; padding: 18px; border: 1px solid var(--ui-divider); border-radius: var(--ui-radius-dialog); background: var(--ui-surface); color: var(--ui-text); text-align: left; cursor: pointer; transition: border-color .15s, box-shadow .15s; }
.directory-card:hover { border-color: var(--ui-border); box-shadow: 0 3px 12px #00000008; }
.directory-card-top { display: flex; align-items: center; gap: 12px; min-width: 0; }
.directory-card-icon, .directory-card-fallback { display: flex; align-items: center; justify-content: center; width: 42px; height: 42px; flex-shrink: 0; border-radius: 12px; background: var(--ui-hover); color: var(--ui-muted); object-fit: contain; font-size: 18px; text-transform: uppercase; }
.directory-card-main { min-width: 0; flex: 1; }
.directory-card-main strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 600; }
.directory-card-meta { display: block; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ui-muted); font-size: 11px; }
.directory-card-description { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; min-height: 40px; margin: 0; color: var(--ui-muted); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.directory-card-footer { display: flex; align-items: flex-end; justify-content: space-between; gap: 8px; margin-top: auto; }
.directory-card-tags { display: flex; flex-wrap: wrap; gap: 5px; }
.directory-chip, .directory-count { padding: 3px 7px; border-radius: 6px; background: var(--ui-hover); color: var(--ui-muted); font-size: 10px; }
.directory-plugin-status { flex-shrink: 0; color: var(--ui-muted); font-size: 11px; }
.directory-plugin-status.is-installed { color: var(--ui-focus); }
.directory-pagination { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 12px; padding: 12px 0; color: var(--ui-muted); font-size: 12px; }
.directory-empty, .directory-loading { padding: 36px 20px; margin: 0; border: 1px dashed var(--ui-border); border-radius: var(--ui-radius-dialog); color: var(--ui-muted); text-align: center; font-size: 13px; }
.directory-toast { padding: 12px; margin: 0; border: 1px solid var(--ui-divider); border-radius: var(--ui-radius-control); color: var(--ui-text); background: var(--ui-hover); font-size: 13px; }
.directory-error { padding: 12px; border: 1px solid var(--ui-danger-border); border-radius: var(--ui-radius-control); color: var(--ui-danger); font-size: 13px; overflow-wrap: anywhere; }
.directory-plugin-description { white-space: pre-line; line-height: 1.7; overflow-wrap: anywhere; }
.directory-detail-group { padding: 12px 0; border-top: 1px solid var(--ui-divider); font-size: 13px; }
.directory-detail-group h3 { margin: 0 0 8px; font-size: 14px; }
.directory-detail-group p { margin: 8px 0; overflow-wrap: anywhere; }
.directory-detail-group a { color: var(--ui-focus); }
.skills-embedded-section { display: flex; flex-direction: column; gap: 14px; padding: 18px; border: 1px solid var(--ui-divider); border-radius: var(--ui-radius-dialog); background: var(--ui-surface); }
.skills-embedded-toggle { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 0; border: 0; background: transparent; color: var(--ui-text); cursor: pointer; }
.skills-embedded-title { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; }
.skills-embedded-chevron, .mcp-skill-chevron { display: inline-block; font-size: 20px; line-height: 1; color: var(--ui-muted); transition: transform .15s; }
.skills-embedded-chevron.is-open, .mcp-skill-chevron.is-open { transform: rotate(90deg); }
.skills-embedded-body { display: flex; flex-direction: column; gap: 14px; }
.directory-mcp-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.mcp-skill-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 12px; }
.mcp-skill-card { display: flex; flex-direction: column; gap: 12px; width: 100%; height: 100%; padding: 14px; border: 1px solid var(--ui-divider); border-radius: var(--ui-radius-popover); background: var(--ui-surface); color: var(--ui-text); text-align: left; cursor: pointer; }
.mcp-skill-card:hover { border-color: var(--ui-border); }
.mcp-skill-card-top { display: flex; align-items: center; gap: 10px; }
.mcp-skill-avatar-fallback { display: flex; align-items: center; justify-content: center; flex-shrink: 0; width: 34px; height: 34px; border-radius: 10px; background: var(--ui-hover); color: var(--ui-muted); text-transform: uppercase; }
.mcp-skill-info { min-width: 0; flex: 1; }
.mcp-skill-header { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.mcp-skill-name { overflow-wrap: anywhere; font-size: 13px; font-weight: 600; }
.mcp-skill-owner, .mcp-skill-meta { margin: 0; color: var(--ui-muted); font-size: 12px; }
.mcp-skill-badge { padding: 2px 6px; border-radius: 5px; background: var(--ui-hover); color: var(--ui-muted); font-size: 10px; }
.mcp-skill-badge-warning { color: var(--ui-danger); }
.directory-mcp-detail { width: 100%; border-top: 1px solid var(--ui-divider); font-size: 12px; }
.directory-mini-heading { margin: 12px 0 6px; font-size: 12px; }
.directory-mini-list { margin: 0; color: var(--ui-muted); line-height: 1.7; }
.directory-section :deep(.skills-hub) { height: auto; padding: 0; max-width: none; margin: 0; overflow: visible; gap: 18px; }
.directory-section :deep(.skills-search-panel), .directory-section :deep(.skills-hub-section) { padding: 18px; border: 1px solid var(--ui-divider); border-radius: var(--ui-radius-dialog); background: var(--ui-surface); }
.directory-section :deep(.skills-hub-grid) { grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); }
@media (max-width: 600px) {
  .directory-hub { gap: 16px; }
  .directory-title { font-size: 20px; }
  .directory-tab { gap: 6px; padding: 12px 10px; }
  .directory-tab span { font-size: 11px; }
  .directory-scope-picker { width: 100%; }
  .directory-scope-picker :deep(.app-select) { width: auto; flex: 1; }
  .directory-toolbar > .app-select { flex-basis: 115px; }
  .skills-embedded-section, .directory-section :deep(.skills-search-panel), .directory-section :deep(.skills-hub-section) { padding: 14px; }
  .directory-mcp-toolbar { align-items: flex-start; }
  .directory-mcp-toolbar > .app-button { flex-shrink: 0; }
}
</style>
