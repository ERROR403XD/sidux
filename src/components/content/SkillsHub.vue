<template>
  <div class="skills-hub">
    <div v-if="toast" class="skills-hub-toast" :class="toastClass">{{ t(toast.text) }}</div>

    <slot name="before-search" />

    <div class="skills-search-panel">
      <div class="skills-search-header">
        <div class="skills-search-copy">
          <strong>{{ t('Find skills') }}</strong>
        </div>
        <a
          class="skills-directory-link"
          href="https://skills.anyclaw.store/"
          target="_blank"
          rel="noopener noreferrer"
        >
          {{ t('Skills directory') }}
        </a>
      </div>
      <form class="skills-search-form" @submit.prevent="searchSkills">
        <input
          v-model="skillSearchQuery"
          class="skills-search-input"
          type="search"
          :placeholder="t('Search skills...')"
          :aria-label="t('Search skills')"
        />
        <button class="skills-hub-sort" type="submit" :disabled="isSearchingSkills || skillSearchQuery.trim().length < 2">
          {{ isSearchingSkills ? t('Searching...') : t('Search') }}
        </button>
      </form>
      <div v-if="skillSearchError" class="skills-hub-error">
        <span>{{ t(skillSearchError) }}</span>
        <a class="skills-error-feedback" :href="feedbackMailto" @click="prepareSkillsErrorFeedback($event, skillSearchError)">{{ t('Send feedback') }}</a>
      </div>
    </div>

    <div v-if="skillSearchResults.length > 0" class="skills-hub-section">
      <DirectorySectionToggle :title="t('搜索结果')" :count="skillSearchResults.length" :open="isSearchResultsOpen" @toggle="isSearchResultsOpen = !isSearchResultsOpen" />
      <div v-if="isSearchResultsOpen" class="skills-hub-grid">
        <SkillCard
          v-for="skill in skillSearchResults"
          :key="skill.source || `${skill.owner}/${skill.name}`"
          :skill="skill"
          :show-browse-action="false"
          @select="(skill) => openDetail(skill as HubSkill)"
        />
      </div>
    </div>

    <p v-for="problem in discoveryErrors" :key="problem" class="skills-hub-error">{{ t(problem) }}</p>
    <div v-if="!isLoading && !error" class="skills-hub-section skills-installed-section">
      <DirectorySectionToggle :title="t('已安装技能')" :count="filteredInstalled.length" :open="isInstalledOpen" @toggle="isInstalledOpen = !isInstalledOpen" />
      <input
        v-if="isInstalledOpen"
        v-model="installedFilter"
        class="app-input skills-installed-filter"
        type="search"
        :placeholder="t('筛选已安装技能')"
        :aria-label="t('筛选已安装技能')"
      />
      <div v-if="isInstalledOpen" class="skills-hub-grid">
        <SkillCard
          v-for="skill in filteredInstalled"
          :key="skill.path || skill.name"
          :skill="skill"
          :show-status-badge="true"
          :show-owner="false"
          @select="(skill) => openDetail(skill as HubSkill)"
        />
      </div>
      <p v-if="isInstalledOpen && !filteredInstalled.length" class="skills-hub-empty">{{ t(installedFilter ? '没有匹配的技能' : 'No installed skills found.') }}</p>
    </div>

    <div v-if="isLoading || error" class="skills-hub-section">
      <div v-if="isLoading" class="skills-hub-loading">{{ t('Loading skills...') }}</div>
      <div v-else-if="error" class="skills-hub-error">
        <span>{{ t(error) }}</span>
        <a class="skills-error-feedback" :href="feedbackMailto" @click="prepareSkillsErrorFeedback($event, error)">{{ t('Send feedback') }}</a>
      </div>
      <div v-else-if="installedSkills.length === 0" class="skills-hub-empty">{{ t('No installed skills found.') }}</div>
    </div>

    <SkillDetailModal
      :skill="detailSkill"
      :visible="isDetailOpen"
      :is-installing="isDetailInstalling"
      :is-uninstalling="isDetailUninstalling"
      :is-toggling="isTogglingSkill"
      :is-trying="props.tryInFlightKey === skillTryKey(detailSkill)"
      @close="isDetailOpen = false"
      @install="handleInstall"
      @uninstall="handleUninstall"
      @toggle-enabled="handleToggleEnabled"
      @try="handleTrySkill"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import DirectorySectionToggle from './DirectorySectionToggle.vue'
import SkillCard from './SkillCard.vue'
import SkillDetailModal, { type HubSkill } from './SkillDetailModal.vue'
import { useFeedbackDiagnostics } from '../../composables/useFeedbackDiagnostics'
import { useUiLanguage } from '../../composables/useUiLanguage'

const EMPTY_SKILL: HubSkill = { name: '', owner: '', description: '', url: '', installed: false }
type SkillsHubPayload = { installed?: HubSkill[]; errors?: string[]; error?: string }
type SkillsSearchPayload = { results?: HubSkill[]; error?: string }

const installedSkills = ref<HubSkill[]>([])
const discoveryErrors = ref<string[]>([])
const isTogglingSkill = ref(false)
let skillsReadId = 0
let disposed = false
let skillsController: AbortController | null = null
const skillSearchResults = ref<HubSkill[]>([])
const isLoading = ref(false)
const isSearchingSkills = ref(false)
const error = ref('')
const skillSearchQuery = ref('')
const installedFilter = ref('')
const skillSearchError = ref('')
const isInstalledOpen = ref(true)
const isSearchResultsOpen = ref(true)
const isDetailOpen = ref(false)
const detailSkill = ref<HubSkill>(EMPTY_SKILL)
const toast = ref<{ text: string; type: 'success' | 'error' } | null>(null)
const actionSkillKey = ref('')
const isInstallActionInFlight = ref(false)
const isUninstallActionInFlight = ref(false)
let toastTimer: ReturnType<typeof setTimeout> | null = null
const { t } = useUiLanguage()
const { buildFeedbackMailto, feedbackMailtoBase, recordVisibleFailure } = useFeedbackDiagnostics()
const feedbackMailto = feedbackMailtoBase()

const props = defineProps<{
  cwd?: string
  tryInFlightKey?: string
}>()

const emit = defineEmits<{
  'skills-changed': []
  'try-item': [payload: { kind: 'skill'; name: string; displayName: string; skillPath?: string }]
}>()

const toastClass = computed(() => toast.value?.type === 'error' ? 'skills-hub-toast-error' : 'skills-hub-toast-success')
const currentDetailSkillKey = computed(() => skillIdentity(detailSkill.value))
function skillIdentity(skill: HubSkill): string { return skill.path || `${skill.owner}/${skill.name}` }
const isDetailInstalling = computed(() =>
  isInstallActionInFlight.value && actionSkillKey.value === currentDetailSkillKey.value,
)
const isDetailUninstalling = computed(() =>
  isUninstallActionInFlight.value && actionSkillKey.value === currentDetailSkillKey.value,
)
const filteredInstalled = computed(() => {
  const query = installedFilter.value.trim().toLocaleLowerCase()
  return query ? installedSkills.value.filter(skill => [skill.name, skill.description, skill.owner, skill.path].some(value => value?.toLocaleLowerCase().includes(query))) : installedSkills.value
})

function showToast(text: string, type: 'success' | 'error' = 'success'): void {
  toast.value = { text, type }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = null }, 3000)
}

function prepareSkillsErrorFeedback(event: MouseEvent, message: string): void {
  recordVisibleFailure(message)
  const target = event.currentTarget
  if (target instanceof HTMLAnchorElement) {
    target.href = buildFeedbackMailto()
  }
}

function applySkillsPayload(payload: SkillsHubPayload): void {
  installedSkills.value = payload.installed ?? []
  discoveryErrors.value = payload.errors ?? []
  if (isDetailOpen.value && detailSkill.value.path) {
    const latest = installedSkills.value.find(skill => skill.path === detailSkill.value.path)
    if (latest) detailSkill.value = latest
    else isDetailOpen.value = false
  }
  if (skillSearchResults.value.length > 0) {
    const installedByName = new Map(installedSkills.value.filter(skill => skill.scope === 'user' && !skill.pluginId).map((skill) => [skill.name, skill]))
    skillSearchResults.value = skillSearchResults.value.map((skill) => {
      const installed = installedByName.get(skill.name)
      return installed ? registrySearchSkillWithLocalState(skill, installed) : { ...skill, installed: false, path: undefined, enabled: undefined }
    })
  }
}

function registrySearchSkillWithLocalState(registrySkill: HubSkill, installed: HubSkill): HubSkill {
  return {
    ...registrySkill,
    installed: true,
    path: installed.path,
    enabled: installed.enabled,
    scope: installed.scope,
    pluginId: installed.pluginId,
    canUninstall: installed.canUninstall,
  }
}

function localSearchSkill(installed: HubSkill, registrySkill: HubSkill): HubSkill {
  return {
    ...installed,
    installed: true,
    source: registrySkill.source,
    publishedAt: registrySkill.publishedAt,
  }
}

async function fetchSkills(force = false): Promise<void> {
  const id = ++skillsReadId
  skillsController?.abort()
  skillsController = new AbortController()
  isLoading.value = true
  error.value = ''
  try {
    const params = new URLSearchParams({ forceReload: String(force) })
    if (props.cwd) params.set('cwd', props.cwd)
    const resp = await fetch(`/codex-api/skills-hub?${params}`, { signal: skillsController.signal })
    const data = await resp.json() as SkillsHubPayload
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`)
    if (!disposed && id === skillsReadId) applySkillsPayload(data)
  } catch (e) {
    if (!disposed && id === skillsReadId) error.value = e instanceof Error ? e.message : 'Failed to load skills'
  } finally {
    if (id === skillsReadId) isLoading.value = false
  }
}
defineExpose({ refresh: fetchSkills })

function openDetail(skill: HubSkill): void {
  const installedSkill = skill.installed ? installedSkills.value.find((candidate) => candidate.path === skill.path) : undefined
  detailSkill.value = installedSkill ? localSearchSkill(installedSkill, skill) : skill
  isDetailOpen.value = true
}

async function searchSkills(): Promise<void> {
  const query = skillSearchQuery.value.trim()
  if (query.length < 2) return
  isSearchingSkills.value = true
  skillSearchError.value = ''
  try {
    const params = new URLSearchParams({ q: query })
    const resp = await fetch(`/codex-api/skills-hub/search?${params}`)
    const data = (await resp.json()) as SkillsSearchPayload
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`)
    const installedByName = new Map(installedSkills.value.filter(skill => skill.scope === 'user' && !skill.pluginId).map((skill) => [skill.name, skill]))
    skillSearchResults.value = (data.results ?? []).map((skill) => {
      const installed = installedByName.get(skill.name)
      return installed ? registrySearchSkillWithLocalState(skill, installed) : { ...skill, installed: false, path: undefined, enabled: undefined }
    })
    isSearchResultsOpen.value = true
    if (skillSearchResults.value.length === 0) {
      showToast(t('No matching skills found.'), 'error')
    }
  } catch (e) {
    skillSearchError.value = e instanceof Error ? e.message : 'Failed to search skills'
  } finally {
    isSearchingSkills.value = false
  }
}

async function handleInstall(skill: HubSkill): Promise<void> {
  actionSkillKey.value = skillIdentity(skill)
  isInstallActionInFlight.value = true
  try {
    const resp = await fetch('/codex-api/skills-hub/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: skill.owner, name: skill.name, source: skill.source }),
    })
    const data = (await resp.json()) as { ok?: boolean; error?: string; path?: string }
    if (!data.ok) throw new Error(data.error || 'Install failed')
    if (!data.path) throw new Error('Install completed but no local skill path was returned')
    await fetchSkills(true)
    const installed = installedSkills.value.find((candidate) => candidate.path === data.path)
    if (!installed?.path) {
      throw new Error('Install completed but the local skill was not found after refresh')
    }
    detailSkill.value = localSearchSkill(installed, skill)
    showToast(`${skill.displayName || skill.name} skill installed`)
    isDetailOpen.value = false
    emit('skills-changed')
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Failed to install skill', 'error')
  } finally {
    isInstallActionInFlight.value = false
  }
}

async function handleUninstall(skill: HubSkill): Promise<void> {
  if (skill.canUninstall !== true) return
  actionSkillKey.value = skillIdentity(skill)
  isUninstallActionInFlight.value = true
  try {
    const resp = await fetch('/codex-api/skills-hub/uninstall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: skill.name, path: skill.path }),
    })
    const data = (await resp.json()) as { ok?: boolean; error?: string }
    if (!data.ok) throw new Error(data.error || 'Uninstall failed')
    await fetchSkills(true)
    showToast(`${skill.displayName || skill.name} skill uninstalled`)
    isDetailOpen.value = false
    emit('skills-changed')
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Failed to uninstall skill', 'error')
  } finally {
    isUninstallActionInFlight.value = false
  }
}

async function handleToggleEnabled(skill: HubSkill, enabled: boolean): Promise<void> {
  if (isTogglingSkill.value || !skill.path) return
  isTogglingSkill.value = true
  try {
    const resp = await fetch('/codex-api/rpc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'skills/config/write', params: { path: skill.path, enabled } }),
    })
    const data = await resp.json() as { error?: { message?: string } }
    if (!resp.ok || data.error) throw new Error(data.error?.message || '技能设置保存失败')
    await fetchSkills(true)
    if (error.value) throw new Error(`设置已保存，读取有效状态失败：${error.value}`)
    emit('skills-changed')
    showToast(`${skill.displayName || skill.name} 设置已保存`)
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Failed to update skill', 'error')
  } finally {
    isTogglingSkill.value = false
  }
}

function handleTrySkill(skill: HubSkill): void {
  if (!skill.installed || skill.enabled !== true) return
  if (props.tryInFlightKey) return
  emit('try-item', {
    kind: 'skill',
    name: skill.name,
    displayName: skill.displayName || skill.name,
    skillPath: skill.path,
  })
  isDetailOpen.value = false
}

function skillTryKey(skill: HubSkill): string {
  return `skill:${skill.name}:${skill.path ?? ''}`
}

const visibleSkillErrors = [
  skillSearchError,
  error,
]

onBeforeUnmount(() => {
  disposed = true
  skillsReadId += 1
  skillsController?.abort()
  if (toastTimer) clearTimeout(toastTimer)
})

onMounted(() => {
  void fetchSkills()
})

watch(visibleSkillErrors, (values, oldValues) => {
  values.forEach((value, index) => {
    if (value === oldValues[index]) return
    const message = value.trim()
    if (message) {
      recordVisibleFailure(message)
    }
  })
})
</script>

<style scoped>
@reference "tailwindcss";

.skills-hub {
  @apply flex flex-col gap-3 sm:gap-4 p-3 sm:p-6 max-w-4xl mx-auto w-full overflow-y-auto h-full;
}

.skills-hub-header {
  @apply flex flex-col gap-1;
}

.skills-hub-title {
  @apply text-xl sm:text-2xl font-semibold text-zinc-900 m-0;
}

.skills-hub-subtitle {
  @apply text-sm text-zinc-500 m-0;
}

.skills-hub-sort {
  @apply shrink-0 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-600 transition hover:bg-zinc-50 hover:border-zinc-300 cursor-pointer;
}









.skills-search-panel {
  @apply rounded-xl border border-zinc-200 bg-white p-3 flex flex-col gap-2;
}

.skills-search-header {
  @apply flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between;
}

.skills-search-copy {
  @apply flex flex-col gap-0.5 text-sm text-zinc-700;
}

.skills-search-copy span {
  @apply text-xs text-zinc-500;
}

.skills-directory-link {
  @apply inline-flex shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:border-zinc-300 hover:bg-white hover:text-zinc-900;
}

.skills-search-form {
  @apply flex flex-col gap-2 sm:flex-row;
}

.skills-search-input {
  @apply min-w-0 flex-1 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800 outline-none placeholder-zinc-400 transition focus:border-zinc-300 focus:bg-white;
}

.skills-hub-toast {
  @apply rounded-lg px-3 py-2 text-sm font-medium;
}

.skills-hub-toast-success {
  @apply border border-emerald-200 bg-emerald-50 text-emerald-700;
}

.skills-hub-toast-error {
  @apply border border-rose-200 bg-rose-50 text-rose-700;
}

.skills-hub-section {
  @apply flex flex-col gap-2;
}

.skills-hub-section-toggle {
  @apply flex items-center gap-1.5 border-0 bg-transparent p-0 text-sm font-medium text-zinc-600 transition hover:text-zinc-900 cursor-pointer;
}

.skills-hub-section-title {
  @apply text-sm font-medium;
}

.skills-hub-section-chevron {
  @apply w-3.5 h-3.5 transition-transform;
}

.skills-hub-section-chevron.is-open {
  @apply rotate-90;
}

.skills-hub-grid {
  @apply grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3;
}

.skills-hub-loading {
  @apply text-sm text-zinc-400 py-8 text-center;
}

.skills-hub-error {
  @apply flex items-start justify-between gap-3 text-sm text-rose-600 p-4 text-left rounded-lg border border-rose-200 bg-rose-50;
}

.skills-error-feedback {
  @apply shrink-0 rounded-full border border-rose-200 bg-white px-2.5 py-1 text-xs font-semibold text-rose-700 transition hover:bg-rose-100 focus:outline-none focus:ring-2 focus:ring-rose-300;
}

.skills-hub-empty {
  @apply text-sm text-zinc-400 py-8 text-center;
}
</style>
