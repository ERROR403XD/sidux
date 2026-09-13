<template>
  <div class="automations-panel">
    <div class="automations-toolbar">
      <div class="automations-summary">
        <span>{{ t('{count} total', { count: automationRows.length }) }}</span>
        <span>{{ t('{count} active', { count: activeCount }) }}</span>
        <span>{{ t('{count} paused', { count: pausedCount }) }}</span>
      </div>
      <div class="automations-actions">
        <button
          class="automations-create"
          type="button"
          :title="t('Create a new automation')"
          @click="emitCreateAutomation"
        >
          {{ t('New automation') }}
        </button>
        <button class="automations-refresh" type="button" :disabled="isLoading || isMutating" @click="loadAutomations">
          {{ isLoading ? t('Refreshing...') : t('Refresh') }}
        </button>
      </div>
    </div>

    <p v-if="runtime && (runtime.error || runtime.draining || !runtime.ready)" class="automation-runtime-status" :class="{ 'has-error': !runtime.ready }">{{ t('调度器：') }}{{ t(runtime.error || (runtime.draining ? '正在交接，停止领取新任务' : runtime.ready ? '运行中' : '初始化中')) }}</p>
    <p v-for="problem in runtime?.definitions.filter(row => row.error) ?? []" :key="problem.id" class="automations-error">{{ problem.id }}：{{ t(problem.error || '') }}</p>
    <p v-if="loadError" class="automations-error">{{ t(loadError) }}</p>

    <div v-if="isLoading && automationRows.length === 0" class="automations-empty">
      <IconTablerBolt class="automations-empty-icon" />
      <p>{{ t('Loading automations...') }}</p>
    </div>

    <div v-else-if="automationRows.length === 0" class="automations-empty">
      <IconTablerBolt class="automations-empty-icon" />
      <p>{{ t('No automations yet') }}</p>
    </div>

    <div v-else class="automations-layout">
      <section class="automations-list" :aria-label="t('Automations')">
        <div
          v-for="row in automationRows"
          :key="row.rowKey"
          class="automation-row"
          :class="{ 'is-selected': selectedRowKey === row.rowKey }"
          role="button"
          tabindex="0"
          @click="selectAutomationRow(row)"
          @keydown.enter.self.prevent="selectAutomationRow(row)"
          @keydown.space.self.prevent="selectAutomationRow(row)"
        >
          <span class="automation-row-icon" :data-status="row.automation.status">
            <IconTablerPlayerStopFilled v-if="row.automation.status === 'PAUSED'" />
            <IconTablerBolt v-else />
          </span>
          <span class="automation-row-main">
            <span class="automation-row-title" :title="row.automation.name">{{ row.automation.name }}</span>
            <span class="automation-row-meta">{{ row.targetLabel }}</span>
          </span>
          <span class="automation-row-side">
            <span v-if="row.automation.status === 'ACTIVE' && row.automation.nextRunAtMs" class="automation-row-schedule" :title="row.scheduleLabel">{{ t(row.scheduleLabel) }}</span>
          </span>
          <AppSwitch
            class="automation-row-toggle"
            :model-value="row.automation.status === 'ACTIVE'"
            :disabled="isMutating || isLoading"
            :aria-label="row.automation.name"
            @click.stop
            @update:model-value="setAutomationEnabled(row, $event)"
          />
        </div>
      </section>

      <aside v-if="selectedRow" class="automation-detail" :aria-label="t('Automation details')">
        <div class="automation-detail-heading">
          <span class="automation-detail-icon" :data-status="selectedRow.automation.status">
            <IconTablerPlayerStopFilled v-if="selectedRow.automation.status === 'PAUSED'" />
            <IconTablerBolt v-else />
          </span>
          <div class="automation-detail-title-wrap">
            <h2 :title="selectedRow.automation.name">{{ selectedRow.automation.name }}</h2>
          </div>
          <AppButton variant="danger" :disabled="isMutating || isLoading" @click="removeAutomation(selectedRow)">
            {{ t('Remove') }}
          </AppButton>
          <button class="automation-detail-edit" type="button" :disabled="isMutating || isLoading" @click="emitEditAutomation(selectedRow)">
            {{ t('Edit') }}
          </button>
        </div>

        <dl class="automation-detail-grid">
          <div>
            <dt>{{ t('Status') }}</dt>
            <dd>{{ t(statusLabel(selectedRow.automation.status)) }}</dd>
          </div>
          <div>
            <dt>{{ t('Schedule') }}</dt>
            <dd>{{ t(selectedRow.scheduleLabel) }}</dd>
          </div>
          <div>
            <dt>{{ t('Target') }}</dt>
            <dd :title="isVirtualProjectId(selectedRow.targetTitle) ? selectedRow.targetLabel : selectedRow.targetTitle">{{ selectedRow.targetLabel }}</dd>
          </div>
          <div>
            <dt>ID</dt>
            <dd>{{ selectedRow.automation.id }}</dd>
          </div>
          <div><dt>{{ t('账号与保护') }}</dt><dd>{{ t(selectedRow.automation.accountStorageId ? '固定账号' : '跟随全局账号') }} · {{ t(selectedRow.automation.protected ? '受保护' : '普通任务') }}</dd></div>
          <div><dt>{{ t('模型') }}</dt><dd>{{ t(selectedRow.automation.model || '跟随运行时默认') }}</dd></div>
          <div><dt>{{ t('思考强度') }}</dt><dd>{{ t(selectedRow.automation.reasoningEffort || '跟随运行时默认') }}</dd></div>
          <div><dt>{{ t('服务档位') }}</dt><dd>{{ t(selectedRow.automation.serviceTier || '跟随模型默认') }}</dd></div>
        </dl>

        <AutomationRunHistory :key="selectedRow.rowKey" :automation="selectedRow.automation" :target="selectedRow.targetTitle" />
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import { isVirtualProjectId } from '../../projectOrganization'
import { notifyOperation } from '../../composables/useOperationToast'
import { readDailyTimesRule } from '../../automationDailyTimes'
import { formatLocalDateTime } from '../../dateTime'
import AppButton from '../common/AppButton.vue'
import AppSwitch from '../common/AppSwitch.vue'
import AutomationRunHistory from './AutomationRunHistory.vue'
import { getAutomationRuntime, type AutomationRuntimeStatus } from '../../api/automationGateway'
import { useUiLanguage } from '../../composables/useUiLanguage'
const { t } = useUiLanguage()

import { computed, onMounted, ref, watch } from 'vue'
import { deleteProjectAutomation, deleteThreadAutomation, upsertProjectAutomation, upsertThreadAutomation, getProjectAutomationMap, getThreadAutomationMap } from '../../api/codexGateway'
import type { UiProjectGroup, UiThreadAutomation, UiThreadAutomationStatus } from '../../types/codex'
import IconTablerBolt from '../icons/IconTablerBolt.vue'
import IconTablerPlayerStopFilled from '../icons/IconTablerPlayerStopFilled.vue'

const props = defineProps<{
  groups: UiProjectGroup[]
  projectCwdByName: Record<string, string>
  projectDisplayNameById: Record<string, string>
  selectedAutomationId?: string
}>()

const emit = defineEmits<{
  (event: 'select-automation', id: string): void
  (event: 'edit-automation', payload: AutomationEditRequest): void
  (event: 'create-automation'): void
  (event: 'automations-updated', maps: { thread: Record<string, UiThreadAutomation[]>; project: Record<string, UiThreadAutomation[]> }): void
}>()

type AutomationRow = {
  rowKey: string
  automation: UiThreadAutomation
  scope: 'thread' | 'project'
  scopeLabel: string
  targetLabel: string
  targetTitle: string
  scheduleLabel: string
}

type AutomationEditRequest = {
  scope: 'thread' | 'project'
  target: string
  automation: UiThreadAutomation
}

const threadAutomations = ref<Record<string, UiThreadAutomation[]>>({})
const projectAutomations = ref<Record<string, UiThreadAutomation[]>>({})
const runtime = ref<AutomationRuntimeStatus | null>(null)
const isLoading = ref(false)
const isMutating = ref(false)
const loadError = ref('')
const selectedAutomationId = ref(props.selectedAutomationId ?? '')
const selectedRowKey = ref('')
const rowOrder = ref(new Map<string, number>())

const threadTitleById = computed(() => {
  const map = new Map<string, string>()
  for (const group of props.groups) {
    for (const thread of group.threads) {
      map.set(thread.id, thread.title)
    }
  }
  return map
})

const projectLabelByCwd = computed(() => {
  const map = new Map<string, string>()
  for (const group of props.groups) {
    const cwd = props.projectCwdByName[group.projectName]?.trim()
    const label = props.projectDisplayNameById[group.projectName]?.trim() || group.projectName
    if (cwd) map.set(cwd, label)
  }
  return map
})

const automationRows = computed<AutomationRow[]>(() => {
  const rows: AutomationRow[] = []
  for (const [threadId, automations] of Object.entries(threadAutomations.value)) {
    const threadTitle = threadTitleById.value.get(threadId) ?? threadId
    for (const automation of automations) {
      rows.push({
        rowKey: getAutomationRowKey('thread', threadId, automation.id),
        automation,
        scope: 'thread',
        scopeLabel: 'Heartbeat',
        targetLabel: threadTitle,
        targetTitle: threadId,
        scheduleLabel: describeAutomationSchedule(automation),
      })
    }
  }
  for (const [cwd, automations] of Object.entries(projectAutomations.value)) {
    const projectLabel = projectLabelByCwd.value.get(cwd) ?? (isVirtualProjectId(cwd) ? '—' : getPathLeaf(cwd))
    for (const automation of automations) {
      rows.push({
        rowKey: getAutomationRowKey('project', cwd, automation.id),
        automation,
        scope: 'project',
        scopeLabel: 'Project',
        targetLabel: projectLabel,
        targetTitle: cwd,
        scheduleLabel: describeAutomationSchedule(automation),
      })
    }
  }
  return rows.sort((first, second) => {
    const firstPosition = rowOrder.value.get(first.rowKey)
    const secondPosition = rowOrder.value.get(second.rowKey)
    if (firstPosition !== undefined && secondPosition !== undefined) return firstPosition - secondPosition
    if (firstPosition !== undefined) return -1
    if (secondPosition !== undefined) return 1
    const firstStatusRank = first.automation.status === 'ACTIVE' ? 0 : 1
    const secondStatusRank = second.automation.status === 'ACTIVE' ? 0 : 1
    if (firstStatusRank !== secondStatusRank) return firstStatusRank - secondStatusRank
    const firstCreated = first.automation.createdAtMs ?? 0
    const secondCreated = second.automation.createdAtMs ?? 0
    if (firstCreated !== secondCreated) return secondCreated - firstCreated
    const firstUpdated = first.automation.updatedAtMs ?? 0
    const secondUpdated = second.automation.updatedAtMs ?? 0
    if (firstUpdated !== secondUpdated) return secondUpdated - firstUpdated
    return first.automation.name.localeCompare(second.automation.name)
  })
})

const activeCount = computed(() => automationRows.value.filter((row) => row.automation.status === 'ACTIVE').length)
const pausedCount = computed(() => automationRows.value.filter((row) => row.automation.status === 'PAUSED').length)
const selectedRow = computed(() =>
  automationRows.value.find((row) => row.rowKey === selectedRowKey.value)
    ?? automationRows.value.find((row) => row.automation.id === selectedAutomationId.value)
    ?? automationRows.value[0]
    ?? null,
)

watch(
  () => props.selectedAutomationId,
  (id) => {
    if (!id) return
    selectedAutomationId.value = id
    selectedRowKey.value = resolveRowKeyForAutomationId(id)
  },
)

watch(selectedAutomationId, (id) => {
  if (id) emit('select-automation', id)
})

watch(automationRows, (rows) => {
  if (rows.length === 0) {
    selectedAutomationId.value = ''
    selectedRowKey.value = ''
    return
  }
  if (selectedRowKey.value && rows.some((row) => row.rowKey === selectedRowKey.value)) return
  if (selectedAutomationId.value && rows.some((row) => row.automation.id === selectedAutomationId.value)) {
    selectedRowKey.value = resolveRowKeyForAutomationId(selectedAutomationId.value)
    return
  }
  if (!selectedAutomationId.value || !rows.some((row) => row.automation.id === selectedAutomationId.value)) {
    selectedAutomationId.value = rows[0].automation.id
    selectedRowKey.value = rows[0].rowKey
  }
})

onMounted(() => {
  void loadAutomations()
})

defineExpose({
  loadAutomations,
})

async function loadAutomations(): Promise<void> {
  isLoading.value = true
  loadError.value = ''
  try {
    const [threadMap, projectMap, runtimeState] = await Promise.all([
      getThreadAutomationMap(),
      getProjectAutomationMap(),
      getAutomationRuntime(),
    ])
    runtime.value = runtimeState
    threadAutomations.value = threadMap
    projectAutomations.value = projectMap
    if (!isMutating.value) {
      rowOrder.value = new Map()
      rowOrder.value = new Map(automationRows.value.map((row, index) => [row.rowKey, index]))
    }
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : 'Failed to load automations'
  } finally {
    isLoading.value = false
  }
}

async function mutateAutomation(action: () => Promise<unknown>): Promise<void> {
  if (isMutating.value || isLoading.value) return
  isMutating.value = true
  loadError.value = ''
  try {
    await action()
    notifyOperation('自动化已更新', 'success')
    await loadAutomations()
    if (!loadError.value) {
      emit('automations-updated', { thread: threadAutomations.value, project: projectAutomations.value })
    }
  } catch (error) {
    notifyOperation(error instanceof Error ? error.message : 'Failed to save automation')
  } finally {
    isMutating.value = false
  }
}

async function setAutomationEnabled(row: AutomationRow, enabled: boolean): Promise<void> {
  const automation = row.automation
  const input = {
    id: automation.id,
    name: automation.name,
    prompt: automation.prompt,
    rrule: automation.rrule,
    status: enabled ? 'ACTIVE' as const : 'PAUSED' as const,
    timezone: automation.timezone,
    accountStorageId: automation.accountStorageId,
    protected: automation.protected,
    model: automation.model,
    reasoningEffort: automation.reasoningEffort,
    serviceTier: automation.serviceTier,
  }
  await mutateAutomation(() => row.scope === 'project'
    ? upsertProjectAutomation({ ...input, projectName: row.targetTitle })
    : upsertThreadAutomation({ ...input, threadId: row.targetTitle }))
}

async function removeAutomation(row: AutomationRow): Promise<void> {
  await mutateAutomation(() => row.scope === 'project'
    ? deleteProjectAutomation(row.targetTitle, row.automation.id)
    : deleteThreadAutomation(row.targetTitle, row.automation.id))
}

function statusLabel(status: UiThreadAutomationStatus): string {
  return status === 'PAUSED' ? t('Paused') : t('Active')
}

function emitEditAutomation(row: AutomationRow): void {
  emit('edit-automation', {
    scope: row.scope,
    target: row.targetTitle,
    automation: row.automation,
  })
}

function emitCreateAutomation(): void {
  emit('create-automation')
}

function selectAutomationRow(row: AutomationRow): void {
  selectedRowKey.value = row.rowKey
  selectedAutomationId.value = row.automation.id
}

function resolveRowKeyForAutomationId(automationId: string): string {
  return automationRows.value.find((row) => row.automation.id === automationId)?.rowKey ?? ''
}

function getAutomationRowKey(scope: 'thread' | 'project', target: string, automationId: string): string {
  return `${scope}:${target}:${automationId}`
}

function describeAutomationSchedule(automation: UiThreadAutomation): string {
  if (automation.status === 'PAUSED') return t('Paused')
  if (automation.nextRunAtMs) return `下次 ${formatLocalDateTime(automation.nextRunAtMs)}`
  const rrule = automation.rrule.trim()
  const dailyTimes = readDailyTimesRule(rrule)
  if (dailyTimes) return `${t('Daily')} ${dailyTimes.join('、')}`
  if (/FREQ=MINUTELY/i.test(rrule)) {
    const interval = /INTERVAL=(\d+)/i.exec(rrule)?.[1] ?? '1'
    return interval === '1' ? t('Every minute') : t('Every {count} minutes', { count: interval })
  }
  if (/FREQ=HOURLY/i.test(rrule)) {
    const interval = /INTERVAL=(\d+)/i.exec(rrule)?.[1] ?? '1'
    return interval === '1' ? t('Hourly') : t('Every {count} hours', { count: interval })
  }
  if (/FREQ=DAILY/i.test(rrule)) return t('Daily')
  if (/FREQ=WEEKLY/i.test(rrule)) return t('Weekly')
  return t('Custom schedule')
}

function getPathLeaf(path: string): string {
  const normalized = path.replace(/\/+$/, '')
  return normalized.split('/').filter(Boolean).pop() ?? path
}
</script>

<style scoped>
@reference "tailwindcss";

.automations-panel {
  @apply flex min-h-0 flex-1 flex-col gap-3 px-2 pb-3 sm:px-6 sm:pb-6;
}

.automations-toolbar {
  @apply flex shrink-0 items-center justify-between gap-3 border-b border-zinc-200 pb-3;
}

.automations-summary {
  @apply flex min-w-0 flex-wrap items-center gap-2 text-xs font-medium text-zinc-500;
}

.automations-summary span {
  @apply rounded-full bg-zinc-100 px-2 py-1;
}

.automations-actions {
  @apply flex shrink-0 items-center gap-2;
}

.automations-refresh,
.automations-create {
  @apply h-8 shrink-0 rounded-full border border-zinc-200 bg-white px-3 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:opacity-60;
}

.automations-error {
  @apply m-0 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700;
}

.automations-layout {
  @apply grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)];
  grid-template-rows: minmax(112px, 0.35fr) minmax(0, 1fr);
}

.automations-list {
  @apply min-h-0 overflow-y-auto rounded-lg border border-zinc-200 bg-white;
  container-type: inline-size;
}

.automation-row {
  @apply grid w-full grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-zinc-100 px-3 py-3 text-left transition last:border-b-0 hover:bg-zinc-50;
}

.automation-row.is-selected {
  @apply bg-zinc-100;
}

.automation-row-icon,
.automation-detail-icon {
  @apply flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700;
}

.automation-row-icon[data-status='PAUSED'],
.automation-detail-icon[data-status='PAUSED'] {
  @apply bg-zinc-100 text-zinc-500;
}

.automation-row-icon :deep(svg),
.automation-detail-icon :deep(svg) {
  @apply h-4 w-4;
}

.automation-row-main {
  @apply flex min-w-0 flex-col gap-0.5;
}

.automation-row-title {
  @apply truncate text-sm font-medium text-zinc-950;
}

.automation-row-meta {
  @apply truncate text-xs text-zinc-500;
}

.automation-row-side {
  @apply flex min-w-0 flex-col items-end gap-0.5 text-right;
}

.automation-row-schedule {
  @apply max-w-36 truncate text-xs text-zinc-500;
}

.automation-detail-edit {
  @apply h-7 shrink-0 rounded-md border border-zinc-200 bg-white px-2 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50;
}

@container (max-width: 460px) {
  .automation-row {
    grid-template-columns: auto minmax(0, 1fr) auto;
    column-gap: 8px;
    row-gap: 6px;
  }
  .automation-row-side {
    grid-column: 2;
    grid-row: 2;
    min-width: 0;
    align-items: flex-start;
    text-align: left;
  }
  .automation-row-toggle {
    grid-column: 3;
    grid-row: 1 / span 2;
  }
}

.automation-row-toggle {
  gap: 0;
}

.automation-detail {
  @apply flex min-h-0 flex-col gap-4 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-4;
}

.automation-detail > * {
  flex-shrink: 0;
  min-width: 0;
}

@media (min-width: 1024px) {
  .automations-layout {
    grid-template-rows: minmax(0, 1fr);
  }
}

.automation-detail-heading {
  @apply flex min-w-0 items-center gap-3;
}

.automation-detail-title-wrap {
  @apply flex min-w-0 flex-1 flex-col gap-0.5;
}

.automation-detail-title-wrap h2 {
  @apply m-0 truncate text-base font-semibold text-zinc-950;
}

.automation-detail-grid {
  @apply grid grid-cols-1 gap-2 sm:grid-cols-2;
}

.automation-detail-grid div {
  @apply min-w-0 rounded-lg bg-zinc-50 px-3 py-2;
}

.automation-detail-grid dt {
  @apply text-[11px] font-medium uppercase tracking-[0.12em] text-zinc-500;
}

.automation-detail-grid dd {
  @apply m-0 truncate text-sm text-zinc-900;
}

.automations-empty {
  @apply mx-auto flex min-h-72 w-full max-w-xl flex-1 flex-col items-center justify-center gap-2 text-center text-zinc-500;
}

.automations-empty-icon {
  @apply h-8 w-8 text-zinc-400;
}

.automations-empty p {
  @apply m-0 text-base font-medium text-zinc-800;
}

.automations-empty span {
  @apply text-sm;
}

</style>
