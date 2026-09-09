<template>
  <div class="directory-hub">
    <header class="directory-header">
      <div><h2 class="directory-title">插件 / 技能 / MCP</h2><p class="directory-subtitle">管理 Codex 原版插件、可用技能与工具连接。</p></div>
      <AppButton :busy="loading" @click="refresh(true)">刷新</AppButton>
    </header>
    <div class="directory-scope">
      <label>查看范围</label>
      <AppSelect :model-value="props.cwd || ''" :options="scopeOptions" enable-search :disabled="busy" @update:model-value="emit('scope-change', $event)" />
      <span v-if="props.threadId" class="directory-scope-note">会话 {{ props.threadId.slice(-8) }} · <a :href="`#/thread/${props.threadId}`">返回会话</a></span>
      <p class="directory-scope-note">技能按项目读取；安装与启停保存到用户设置。MCP 显示{{ props.threadId ? '此会话' : '全局' }}状态。</p>
    </div>
    <nav class="directory-tabs" aria-label="扩展分类">
      <button v-for="tab in tabs" :key="tab.id" type="button" class="directory-tab" :class="{ 'is-active': activeTab === tab.id }" :aria-pressed="activeTab === tab.id" :disabled="busy" @click="selectTab(tab.id)">{{ tab.label }}</button>
    </nav>
    <p v-if="notice" class="directory-toast" role="status">{{ notice }}</p>
    <p v-if="error" class="directory-error" role="alert">{{ error }}</p>
    <section v-if="activeTab === 'plugins'" class="directory-section">
      <input v-model="search" class="directory-search" type="search" placeholder="搜索插件" aria-label="搜索插件" />
      <p v-if="!supportsPlugins && ready" class="directory-empty">当前 Codex CLI 未提供原版插件接口。可继续管理技能和 MCP。</p>
      <p v-else-if="loading" class="directory-loading">读取插件…</p>
      <p v-else-if="!visiblePlugins.length" class="directory-empty">暂无插件。配置原版插件市场后刷新即可查看。</p>
      <div class="directory-grid">
        <button v-for="plugin in visiblePlugins" :key="plugin.id" type="button" class="directory-card" @click="openPluginDetail(plugin)">
          <div class="directory-card-top">
            <img v-if="pluginIconSrc(plugin)" class="directory-card-icon" :src="pluginIconSrc(plugin)" alt="" loading="lazy" />
            <span v-else class="directory-card-fallback">{{ plugin.displayName.charAt(0) }}</span>
            <div class="directory-card-main"><strong>{{ plugin.displayName }}</strong><span class="directory-card-meta">{{ plugin.developerName || plugin.marketplaceDisplayName || plugin.marketplaceName }}</span></div>
            <span class="directory-chip">{{ plugin.installed ? (plugin.enabled ? '已启用' : '已停用') : '可安装' }}</span>
          </div>
          <p class="directory-card-description">{{ plugin.description || '查看技能、MCP 与连接要求' }}</p>
          <div class="directory-card-tags"><span v-for="capability in plugin.capabilities" :key="capability" class="directory-chip">{{ capability }}</span></div>
        </button>
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
        <template #before-installed>
          <div class="skills-embedded-section">
            <button class="skills-embedded-toggle" type="button" @click="isMcpSectionOpen = !isMcpSectionOpen">
              <span class="skills-embedded-title">MCPs({{ visibleMcpServers.length }})</span>
              <span class="skills-embedded-chevron" :class="{ 'is-open': isMcpSectionOpen }">›</span>
            </button>
            <div v-if="isMcpSectionOpen" class="skills-embedded-body">
              <AppButton v-if="supportsMcpReload" :busy="isReloadingMcps" @click="reloadMcps">重载 MCP 配置</AppButton>
              <div v-if="!supportsMcps" class="directory-empty">
                {{ t('MCP status APIs unavailable in this Codex CLI. Update Codex CLI to inspect MCP servers.') }}
              </div>
              <div v-else-if="mcpError" class="directory-error">{{ t(mcpError) }}</div>
              <div v-else-if="isLoadingMcps" class="directory-loading">{{ t('Loading MCP servers...') }}</div>
              <div v-else-if="visibleMcpServers.length === 0" class="directory-empty">{{ t('No MCP servers configured.') }}</div>
              <div v-else class="mcp-skill-grid">
                <article v-for="server in visibleMcpServers" :key="server.name">
                  <button class="mcp-skill-card skill-card" type="button" @click="toggleMcpExpanded(server.name)">
                    <div class="mcp-skill-card-top">
                      <div class="mcp-skill-avatar-fallback">{{ server.name.charAt(0) }}</div>
                      <div class="mcp-skill-info">
                        <div class="mcp-skill-header">
                          <span class="mcp-skill-name">{{ server.name }}</span>
                          <span class="mcp-skill-badge" :class="mcpCardBadgeClass(server.authStatus)">{{ formatMcpAuthStatus(server.name) }}</span>
                        </div>
                        <span class="mcp-skill-owner">{{ mcpRuntimeLabel(server.runtimeStatus) }}</span>
                      </div>
                      <span class="mcp-skill-chevron" :class="{ 'is-open': expandedMcpNames.has(server.name) }">›</span>
                    </div>
                    <p class="mcp-skill-meta">{{ server.toolCount }} tools<span v-if="server.resourceCount !== null"> · {{ server.resourceCount }} resources</span></p>
                    <div v-if="expandedMcpNames.has(server.name)" class="directory-mcp-detail">
                      <p v-if="mcpDetailError">{{ mcpDetailError }}</p>
                      <p v-else-if="!server.detailsLoaded">读取工具与资源…</p>
                      <p v-if="server.truncated">每类仅预览前 200 项</p>
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

    <AppDialog :open="!!selectedPlugin" :title="selectedPlugin?.displayName || '插件'" :busy="busy" @close="closeDetail">
      <p v-if="detailLoading">读取插件详情…</p>
      <p v-if="detailError" class="directory-error">{{ detailError }}</p>
      <template v-if="detail">
        <p class="directory-plugin-description">{{ detail.description || detail.summary.description }}</p>
        <p v-if="unavailable" class="directory-error">{{ detail.summary.disabledReason || '此插件当前不可安装' }}</p>
        <div v-if="detail.skills.length" class="directory-detail-group"><h3>技能</h3><p v-for="skill in detail.skills" :key="skill.path || skill.name"><strong>{{ skill.displayName || skill.name }}</strong> · {{ skill.shortDescription || skill.description }}</p></div>
        <div v-if="detail.mcpServers.length" class="directory-detail-group"><h3>MCP</h3><p v-for="name in detail.mcpServers" :key="name">{{ name }} <AppButton v-if="shouldShowMcpLogin(name)" :busy="mcpLoginServerName === name" @click="loginMcpServer(name)">连接</AppButton></p></div>
        <div v-if="detail.apps.length || authApps.length" class="directory-detail-group"><h3>服务连接</h3><p v-for="app in connectionApps" :key="app.id">{{ app.name }} <a v-if="app.installUrl" :href="app.installUrl" target="_blank" rel="noopener noreferrer">{{ app.needsAuth ? '授权连接' : '管理连接' }}</a><span v-else> · {{ app.needsAuth ? '安装后按提示授权' : '由原版插件管理' }}</span></p></div>
        <p class="directory-scope-note">安装或更改后，新会话会使用最新配置。</p>
      </template>
      <template #footer>
        <template v-if="selectedPlugin?.installed">
          <AppButton variant="danger" :busy="busy" @click="changePlugin('uninstall')">卸载</AppButton>
          <AppButton :busy="busy" @click="changePlugin('toggle')">{{ selectedPlugin.enabled ? '停用' : '启用' }}</AppButton>
          <AppButton v-if="selectedPlugin.enabled" :disabled="busy || !!props.tryInFlightKey || !detail" @click="tryPlugin">试用</AppButton>
        </template>
        <AppButton v-else :busy="busy" :disabled="!detail || unavailable" @click="changePlugin('install')">安装</AppButton>
      </template>
    </AppDialog>
  </div>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppButton from '../common/AppButton.vue'
import AppDialog from '../common/AppDialog.vue'
import AppSelect from '../common/AppSelect.vue'
import SkillsHub from './SkillsHub.vue'
import { useUiLanguage } from '../../composables/useUiLanguage'
import { formatDirectoryError, mcpRuntimeLabel } from '../../directory'
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
const scopeOptions = computed(() => [{ value: '', label: '全局' }, ...(props.projects || [])])
const methods = ref(new Set<string>())
const ready = ref(false)
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const search = ref('')
const plugins = ref<DirectoryPluginSummary[]>([])
const selectedPlugin = ref<DirectoryPluginSummary | null>(null)
const detail = ref<DirectoryPluginDetail | null>(null)
const detailLoading = ref(false)
const detailError = ref('')
const authApps = ref<DirectoryPluginAppSummary[]>([])
const supportsPlugins = computed(() => ['plugin/list', 'plugin/read', 'plugin/install', 'plugin/uninstall'].every(method => methods.value.has(method)))
const unavailable = computed(() => selectedPlugin.value?.installPolicy === 'NOT_AVAILABLE' || selectedPlugin.value?.availability === 'DISABLED_BY_ADMIN')
const visiblePlugins = computed(() => plugins.value.filter(plugin => `${plugin.displayName} ${plugin.description}`.toLowerCase().includes(search.value.toLowerCase())).sort((a, b) => Number(b.installed) - Number(a.installed) || a.displayName.localeCompare(b.displayName)))
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
          if (!disposed && current === revision && warnings.length) notice.value = `部分插件市场读取失败：${warnings.join('；')}`
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
    notice.value = '完成授权后刷新连接状态。'
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
    notice.value = '插件设置已保存。新会话会使用最新配置。'
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
  if (!['skills/changed', 'mcpServer/startupStatus/updated', 'mcpServer/oauthLogin/completed'].includes(notification.method)) return
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
  void refresh(true)
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
@reference "tailwindcss";

.directory-hub {
  @apply flex h-full w-full flex-col gap-3 overflow-y-auto p-3 sm:p-6;
}

.directory-header {
  @apply mx-auto flex w-full max-w-5xl items-start justify-between gap-3;
}

.directory-header-actions {
  @apply flex items-center gap-2;
}

.directory-title {
  @apply m-0 text-xl font-semibold text-zinc-900 sm:text-2xl;
}

.directory-subtitle {
  @apply m-0 mt-1 text-sm text-zinc-500;
}

.directory-refresh,
.directory-action,
.directory-action-link,
.directory-modal-close {
  @apply shrink-0 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 no-underline transition hover:border-zinc-300 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50;
}

.directory-action.primary {
  @apply border-zinc-900 bg-zinc-900 text-white hover:bg-black;
}

.directory-action.danger {
  @apply border-rose-600 bg-rose-600 text-white hover:bg-rose-700;
}

.directory-tabs {
  @apply mx-auto grid w-full max-w-5xl grid-cols-4 rounded-lg border border-zinc-200 bg-zinc-100 p-1;
}

.directory-tab {
  @apply rounded-md border-0 bg-transparent px-2 py-1.5 text-sm font-medium text-zinc-500 transition hover:text-zinc-800;
}

.directory-tab.is-active {
  @apply bg-white text-zinc-900 shadow-sm;
}

.directory-section {
  @apply mx-auto flex w-full max-w-5xl flex-col gap-3;
}

.directory-section-group {
  @apply flex flex-col gap-3;
}

.skills-embedded-section {
  @apply flex flex-col gap-2;
}

.skills-embedded-toggle {
  @apply flex items-center gap-1.5 border-0 bg-transparent p-0 text-sm font-medium text-zinc-600 transition hover:text-zinc-900 cursor-pointer;
}

.skills-embedded-title {
  @apply text-sm font-medium;
}

.skills-embedded-chevron {
  @apply inline-block text-base leading-none transition-transform;
}

.skills-embedded-chevron.is-open {
  @apply rotate-90;
}

.skills-embedded-body {
  @apply flex flex-col gap-3;
}

.mcp-skill-grid {
  @apply grid grid-cols-1 gap-3 md:grid-cols-2;
}

.mcp-skill-card {
  @apply flex w-full flex-col gap-1.5 rounded-xl border border-zinc-200 bg-white p-3 text-left transition hover:border-zinc-300 hover:shadow-sm cursor-pointer;
}

.mcp-skill-card-top {
  @apply flex items-start gap-2.5;
}

.mcp-skill-avatar-fallback {
  @apply w-8 h-8 rounded-full shrink-0 bg-zinc-200 text-zinc-500 flex items-center justify-center text-xs font-medium uppercase;
}

.mcp-skill-info {
  @apply flex flex-col gap-0.5 min-w-0 flex-1;
}

.mcp-skill-header {
  @apply flex items-center gap-2;
}

.mcp-skill-name {
  @apply text-sm font-medium text-zinc-900 truncate;
}

.mcp-skill-owner {
  @apply text-xs text-zinc-400;
}

.mcp-skill-meta {
  @apply m-0 text-xs text-zinc-500;
}

.mcp-skill-chevron {
  @apply inline-block text-base leading-none text-zinc-400 transition-transform;
}

.mcp-skill-chevron.is-open {
  @apply rotate-90;
}

.mcp-skill-badge {
  @apply shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium leading-none border;
}

.mcp-skill-badge-ok {
  @apply border-emerald-200 bg-emerald-50 text-emerald-700;
}

.mcp-skill-badge-warning {
  @apply border-amber-200 bg-amber-50 text-amber-700;
}

.mcp-skill-badge-muted {
  @apply border-zinc-200 bg-zinc-100 text-zinc-500;
}

.directory-section-actions {
  @apply flex justify-end;
}

.directory-toolbar {
  @apply flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between;
}

.directory-search {
  @apply min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 outline-none transition placeholder:text-zinc-400 focus:border-zinc-400;
}

.directory-sort-group {
  @apply inline-flex rounded-lg border border-zinc-200 bg-zinc-100 p-1;
}

.directory-sort-button {
  @apply rounded-md border-0 bg-transparent px-2.5 py-1 text-xs font-medium text-zinc-500 transition hover:text-zinc-800;
}

.directory-sort-button.is-active {
  @apply bg-white text-zinc-900 shadow-sm;
}

.directory-grid {
  @apply grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3;
}

.directory-list {
  @apply flex flex-col gap-3;
}

.directory-card {
  @apply flex min-h-36 flex-col gap-2 rounded-xl border border-zinc-200 bg-white p-3 text-left transition hover:border-zinc-300 hover:shadow-sm;
}

button.directory-card {
  @apply cursor-pointer;
}

.directory-card.is-disabled {
  @apply opacity-60;
}

.directory-card-wide {
  @apply min-h-0;
}

.directory-card-top {
  @apply flex min-w-0 items-start gap-3;
}

.directory-card-icon,
.directory-card-fallback {
  @apply flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zinc-100 object-cover text-sm font-semibold uppercase text-zinc-500;
}

.directory-card-main {
  @apply min-w-0 flex-1;
}

.directory-card-title-row {
  @apply flex min-w-0 items-center gap-2;
}

.directory-card-title {
  @apply truncate text-sm font-semibold text-zinc-900;
}

.directory-card-meta {
  @apply mt-0.5 block truncate text-xs text-zinc-400;
}

.directory-card-description {
  @apply m-0 line-clamp-3 text-xs leading-relaxed text-zinc-500;
}

.directory-badge {
  @apply shrink-0 rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium leading-none text-emerald-700;
}

.directory-badge.is-muted {
  @apply border-zinc-200 bg-zinc-100 text-zinc-500;
}

.directory-chip-row {
  @apply flex flex-wrap gap-1.5;
}

.directory-chip {
  @apply rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500;
}

.directory-card-actions {
  @apply mt-auto flex items-center gap-2 pt-1;
}

.directory-loading,
.directory-empty,
.directory-error {
  @apply rounded-xl border border-zinc-200 bg-white p-4 text-sm text-zinc-500;
}

.directory-empty-copy {
  @apply flex flex-col gap-3;
}

.directory-empty-text {
  @apply m-0;
}

.directory-error,
.directory-toast.is-error {
  @apply border-rose-200 bg-rose-50 text-rose-700;
}

.directory-auth-status.is-error {
  @apply border-rose-200 bg-rose-50 text-rose-700;
}

.directory-toast {
  @apply mx-auto w-full max-w-5xl rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700;
}

.directory-card-toggle {
  @apply flex w-full items-center justify-between gap-3 border-0 bg-transparent p-0 text-left;
}

.directory-mcp-detail {
  @apply flex flex-col gap-3 border-t border-zinc-100 pt-3;
}

.directory-mini-heading,
.directory-detail-heading {
  @apply m-0 text-xs font-semibold text-zinc-700;
}

.directory-mini-list {
  @apply m-0 text-xs leading-relaxed text-zinc-500;
}

.directory-modal-overlay {
  @apply fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center;
}

.directory-modal {
  @apply flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl sm:max-h-[82vh] sm:rounded-2xl;
}

.directory-modal-header,
.directory-modal-footer {
  @apply flex shrink-0 items-center justify-between gap-3 p-4 sm:p-5;
}

.directory-modal-header {
  @apply border-b border-zinc-100;
}

.directory-modal-footer {
  @apply justify-end border-t border-zinc-100;
}

.directory-modal-title {
  @apply m-0 truncate text-lg font-semibold text-zinc-900;
}

.directory-modal-body {
  @apply flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 sm:p-5;
}

.directory-detail-description {
  @apply m-0 text-sm leading-relaxed text-zinc-600;
}

.directory-detail-grid {
  @apply grid grid-cols-1 gap-3 sm:grid-cols-2;
}

.directory-detail-block,
.directory-auth-panel {
  @apply rounded-xl border border-zinc-200 bg-zinc-50 p-3;
}

.directory-include-row {
  @apply mt-2 flex items-center justify-between gap-3 text-xs text-zinc-600;
}

.directory-auth-status {
  @apply ml-2 inline-flex rounded-md border px-1.5 py-0.5 text-[10px] font-medium leading-none;
}

.directory-auth-status.is-ok {
  @apply border-emerald-200 bg-emerald-50 text-emerald-700;
}

.directory-auth-status.is-warning {
  @apply border-amber-200 bg-amber-50 text-amber-700;
}

.directory-auth-status.is-muted {
  @apply border-zinc-200 bg-white text-zinc-500;
}

.directory-include-row button {
  @apply border-0 bg-transparent p-0 text-xs font-medium text-blue-600 hover:underline;
}

.directory-screenshots {
  @apply grid grid-cols-1 gap-3 sm:grid-cols-2;
}

.directory-screenshots img {
  @apply max-h-56 w-full rounded-xl border border-zinc-200 object-cover;
}












:global(:root.dark) .directory-title,
:global(:root.dark) .directory-card-title,
:global(:root.dark) .directory-modal-title,
:global(:root.dark) .directory-mini-heading,
:global(:root.dark) .directory-detail-heading {
  @apply text-zinc-100;
}

:global(:root.dark) .directory-subtitle,
:global(:root.dark) .directory-card-meta,
:global(:root.dark) .directory-card-description,
:global(:root.dark) .directory-mini-list,
:global(:root.dark) .directory-detail-description {
  @apply text-zinc-400;
}

:global(:root.dark) .skills-embedded-toggle,
:global(:root.dark) .skills-embedded-title {
  @apply text-zinc-300 hover:text-zinc-100;
}

:global(:root.dark) .mcp-skill-card {
  @apply border-zinc-700 bg-zinc-900 hover:border-zinc-600;
}

:global(.dark) .mcp-skill-card {
  @apply border-zinc-700 bg-zinc-900 hover:border-zinc-600;
}

:global(:root.dark) .mcp-skill-avatar-fallback {
  @apply bg-zinc-700 text-zinc-300;
}

:global(.dark) .mcp-skill-avatar-fallback {
  @apply bg-zinc-700 text-zinc-300;
}

:global(:root.dark) .mcp-skill-name {
  @apply text-zinc-100;
}

:global(.dark) .mcp-skill-name {
  @apply text-zinc-100;
}

:global(:root.dark) .mcp-skill-owner {
  @apply text-zinc-400;
}

:global(.dark) .mcp-skill-owner {
  @apply text-zinc-400;
}

:global(:root.dark) .mcp-skill-meta {
  @apply text-zinc-300;
}

:global(.dark) .mcp-skill-meta {
  @apply text-zinc-300;
}

:global(:root.dark) .mcp-skill-chevron {
  @apply text-zinc-500;
}

:global(.dark) .mcp-skill-chevron {
  @apply text-zinc-500;
}

@media (prefers-color-scheme: dark) {
  .mcp-skill-card {
    @apply border-zinc-700 bg-zinc-900 hover:border-zinc-600;
  }

  .mcp-skill-avatar-fallback {
    @apply bg-zinc-700 text-zinc-300;
  }

  .mcp-skill-name {
    @apply text-zinc-100;
  }

  .mcp-skill-owner {
    @apply text-zinc-400;
  }

  .mcp-skill-meta {
    @apply text-zinc-300;
  }

  .mcp-skill-chevron {
    @apply text-zinc-500;
  }
}

:global(:root.dark) .directory-tabs,
:global(:root.dark) .directory-search,
:global(:root.dark) .directory-card,
:global(:root.dark) .directory-loading,
:global(:root.dark) .directory-empty,
:global(:root.dark) .directory-modal,
:global(:root.dark) .directory-refresh,
:global(:root.dark) .directory-action,
:global(:root.dark) .directory-action-link,
:global(:root.dark) .directory-modal-close {
  @apply border-zinc-700 bg-zinc-900;
}

:global(:root.dark) .directory-search {
  @apply text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-500;
}

:global(:root.dark) .directory-tab.is-active,
:global(:root.dark) .directory-sort-button.is-active,
:global(:root.dark) .directory-detail-block,
:global(:root.dark) .directory-auth-panel,
:global(:root.dark) .directory-chip {
  @apply border-zinc-700 bg-zinc-800 text-zinc-100;
}

:global(:root.dark) .directory-sort-group {
  @apply border-zinc-700 bg-zinc-950;
}

:global(:root.dark) .directory-auth-status.is-muted {
  @apply border-zinc-700 bg-zinc-900 text-zinc-400;
}






:global(:root.dark) .directory-auth-status.is-error,
:global(:root.dark) .directory-error,
:global(:root.dark) .directory-toast.is-error {
  @apply border-rose-900/60 bg-rose-950/60 text-rose-300;
}

</style>
