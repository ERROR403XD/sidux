<template>
  <AppDialog :open="true" :busy="working" :title="`/${request.name} · ${t(title)}`" @close="close">
    <div class="thread-command-dialog" :aria-busy="working || loading">
      <p v-if="error" class="thread-command-error" role="alert">{{ t(error) }}</p>
      <p v-if="feedback" class="thread-command-feedback" role="status">{{ t(feedback) }}</p>
      <p v-if="loading">{{ t('读取中…') }}</p>
      <template v-if="request.name === 'goal'">
        <p v-if="goal" class="thread-goal-status">{{ t(goalLabels[goal.status]) }} {{ t('· Codex 计量') }} {{ goal.tokensUsed.toLocaleString() }} tokens · {{ Math.round(goal.timeUsedSeconds / 60) }} {{ t('分钟') }}</p>
        <p v-if="goal && goalStatusHint(goal)" class="thread-command-hint" role="status">{{ t(goalStatusHint(goal)) }}</p>
        <p v-if="goalConflict" class="thread-command-error" role="alert">{{ t('目标已在其他位置修改，请重新读取。') }}<AppButton :disabled="working" @click="reloadGoalForm">{{ t('重新读取') }}</AppButton></p>
        <label>{{ t('目标') }}<textarea v-model="objective" data-autofocus rows="5" maxlength="8000" :disabled="working || loading" :placeholder="t('说明希望完成什么，以及如何验收')" /></label>
        <div class="goal-model-fields">
          <div><span class="goal-model-label">{{ t('模型') }}</span><AppSelect v-model="selectedModel" class="goal-model-picker" :options="modelOptions" enable-search :search-placeholder="t('搜索模型')" :disabled="working || loading || !supported" /></div>
          <div><span class="goal-model-label">{{ t('推理强度') }}</span><AppSelect v-model="selectedEffort" class="goal-effort-picker" :options="goalEffortOptions.map(option => ({ ...option, label: selectedCapability?.providerId === 'custom' ? option.label : t(option.label) }))" :disabled="working || loading || !supported || reasoningUnavailable(selectedCapability)" /></div>
        </div>
        <p v-if="settingsProblem" class="thread-command-error">{{ t(settingsProblem) }}</p>
        <label>{{ t('Token 预算') }}<input v-model="budget" maxlength="50" spellcheck="false" :disabled="working || loading" :placeholder="t('100、2k、30M、0.4B；留空不设预算')" /></label>
        <p v-if="goal && objective.trim() !== goal.objective" class="thread-command-hint">{{ t('修改目标内容会重置该目标的用量统计。') }}</p>
        <div class="thread-command-actions">
          <AppButton type="button" :disabled="working || loading || !supported || goalConflict || !!settingsProblem || !objective.trim()" @click="saveGoal">{{ t(goal ? '保存目标' : '保存并开始') }}</AppButton>
          <AppButton v-if="goal" type="button" :disabled="working || loading || !supported || (goal.status !== 'active' && (!!goalResumeProblem(goal) || !!settingsProblem || goalConflict || goalFormDirty))" @click="changeGoalStatus(goal.status === 'active' ? 'paused' : 'active')">{{ t(goal.status === 'active' ? '暂停目标' : '继续目标') }}</AppButton>
          <AppButton v-if="goal" type="button" :disabled="working || loading || !supported || goalConflict" @click="clearGoal">{{ t('清除目标') }}</AppButton>
        </div>
        <p v-if="goal && goal.status !== 'active' && goalFormDirty" class="thread-command-hint">{{ t('请先保存目标或预算的修改。') }}</p>
        <p v-if="goal && goal.status !== 'active' && goalResumeProblem(goal) && goal.status !== 'budgetLimited'" class="thread-command-hint">{{ t(goalResumeProblem(goal)) }}</p>
      </template>
      <template v-else-if="request.name === 'help'">
        <p>{{ t('输入 / 后继续搜索；↑↓ 选择，Enter 确认，Esc 收起。') }}</p>
        <dl class="thread-command-help"><template v-for="command in helpCommands" :key="command.id"><dt>{{ command.name }}</dt><dd>{{ t(command.description) }}</dd></template></dl>
      </template>
      <template v-else-if="request.name === 'status'">
        <dl class="thread-command-status"><dt>{{ t('会话') }}</dt><dd>{{ threadName || t('新会话') }}</dd><dt>{{ t('模型') }}</dt><dd>{{ model || t('未选择') }}</dd><dt>{{ t('推理强度') }}</dt><dd>{{ t(effort || '默认') }}</dd><dt>{{ t('运行状态') }}</dt><dd>{{ t(busy ? '当前任务运行中，新消息默认排队' : '空闲') }}</dd><dt>{{ t('工作目录') }}</dt><dd>{{ cwd || t('未选择') }}</dd><dt>{{ t('上下文') }}</dt><dd>{{ t(contextSummary) }}</dd></dl>
      </template>
      <template v-else>
        <p>{{ t(descriptor?.description || '') }}</p>
        <label v-if="request.name === 'rename'">{{ t('会话名称') }}<input v-model="value" data-autofocus maxlength="200" /></label>
        <template v-if="request.name === 'compact'">
          <p class="thread-command-hint">{{ t('任务结束后可压缩上下文，进度会显示在会话中。') }}</p>
          <p v-if="compactionRequest" class="thread-command-feedback" role="status">{{ t(compactionRequest.status === 'requested' ? '已请求压缩，等待运行时状态。' : compactionLabels[compactionRequest.status]) }}</p>
          <p v-if="compactionRequest?.error" class="thread-command-error">{{ t(compactionRequest.error) }}</p>
          <AppButton v-if="isCompactionPending(compactionRequest)" :disabled="working || loading" @click="checkCompaction">{{ t('检查结果') }}</AppButton>
        </template>
        <p v-if="request.name === 'review'" class="thread-command-hint">{{ t('会在当前会话发起一次代码审查，使用当前运行时模型。') }}</p>
        <p v-if="unavailable" class="thread-command-hint">{{ t(unavailable) }}</p>
        <AppButton type="button" :disabled="working || loading || !!unavailable || !supported || compactWaiting || (request.name === 'rename' && !value.trim())" @click="execute">{{ t(request.name === 'compact' && compactionRequest?.status === 'unknown' ? '再次压缩' : actionLabel) }}</AppButton>
      </template>
    </div>
  </AppDialog>
</template>
<script setup lang="ts">
import { t } from '../../composables/useUiLanguage'

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { notifyOperation } from '../../composables/useOperationToast'
import AppDialog from '../common/AppDialog.vue'
import AppButton from '../common/AppButton.vue'
import AppSelect from '../common/AppSelect.vue'
import { reasoningUnavailable, effortOptions, modelSettingsProblem, type ModelCapability } from '../../modelCapabilities'
import { getGoalModelSettings, applyGoalModelSettings } from '../../api/threadCommands'
import { goalResumeProblem, goalSavePatch, goalStatusHint, readThreadGoal } from '../../threadGoal'
import { compactionLabels } from '../../compaction'
import { checkThreadCompaction, compactionRequests, isCompactionPending } from '../../api/threadCompaction'
import { APP_COMMANDS, buildComposerCommands, type AppCommandName, type AppCommandRequest } from './composerCommands'
import { getMethodCatalog, subscribeCodexNotifications } from '../../api/codexGateway'
import { compactThread, getThreadGoal, setThreadGoal, clearThreadGoal, validateGoalInput, formatGoalTokenBudget, goalStatusLabels, type ThreadGoal } from '../../api/threadCommands'
const props = defineProps<{
  request: AppCommandRequest; threadId: string; threadName: string; cwd: string; model: string; effort: string; busy: boolean; contextSummary: string
  models: ModelCapability[]
  run: (name: AppCommandName, value?: string) => Promise<void>
  ensureThread: (objective?: string) => Promise<string>
}>()
const emit = defineEmits<{ close: []; 'goal-change': [goal: ThreadGoal | null, threadId: string]; 'model-change': [model: string, effort: string] }>()
const descriptor = computed(() => APP_COMMANDS.find(command => command.id === props.request.name))
const title = computed(() => ({ goal: '持续目标', help: '命令帮助', status: '会话状态' }[props.request.name as 'goal' | 'help' | 'status'] ?? descriptor.value?.description ?? '会话操作'))
const value = ref(props.threadName), objective = ref(''), budget = ref(''), goal = ref<ThreadGoal | null>(null)
const working = ref(false), loading = ref(false), supported = ref(true), error = ref(''), feedback = ref('')
let disposed = false, consumed = false, threadId = props.threadId, unsubscribe: (() => void) | undefined
let pendingGoalNotification: ThreadGoal | null | undefined
let goalRevision = 0
const goalBase = ref<ThreadGoal | null>(null)
const goalConflict = computed(() => goalBase.value?.objective !== goal.value?.objective || goalBase.value?.tokenBudget !== goal.value?.tokenBudget)
const goalFormDirty = computed(() => objective.value.trim() !== goal.value?.objective || budget.value.trim() !== formatGoalTokenBudget(goal.value?.tokenBudget))
function fillGoalForm(current: ThreadGoal | null) {
  goal.value = current
  goalBase.value = current
  objective.value = current?.objective ?? ''
  budget.value = formatGoalTokenBudget(current?.tokenBudget)
}
async function reloadGoalForm() {
  await action(async () => {
    const current = await getThreadGoal(threadId)
    fillGoalForm(pendingGoalNotification !== undefined ? pendingGoalNotification : current)
  })
}
async function checkCurrentGoal() {
  const current = await getThreadGoal(threadId)
  goal.value = pendingGoalNotification !== undefined ? pendingGoalNotification : current
  if (goalConflict.value) throw new Error('目标已在其他位置修改，请重新读取。')
}
const consume = () => { if (!consumed) { props.request.complete(); consumed = true } }
const selectedModel = ref(props.model)
const selectedEffort = ref(props.effort)
const modelOptions = computed(() => [...new Set([...props.models.map(model => model.id), selectedModel.value].filter(Boolean))].map(value => ({ value, label: value })))
const selectedCapability = computed(() => props.models.find(model => model.id === selectedModel.value))
watch(selectedCapability, model => { if (reasoningUnavailable(model)) selectedEffort.value = '' })
const goalEffortOptions = computed(() => effortOptions(selectedCapability.value, selectedEffort.value))
const settingsProblem = computed(() => modelSettingsProblem(selectedCapability.value, selectedEffort.value, ''))
async function saveModelSettings(): Promise<void> {
  if (settingsProblem.value) throw new Error(settingsProblem.value)
  const effort = reasoningUnavailable(selectedCapability.value) ? '' : selectedEffort.value || selectedCapability.value?.defaultEffort || ''
  await applyGoalModelSettings(threadId, { model: selectedModel.value, effort })
}
const goalLabels = goalStatusLabels
const compactionRequest = computed(() => compactionRequests.value[threadId])
const compactWaiting = computed(() => props.request.name === 'compact' && isCompactionPending(compactionRequest.value) && compactionRequest.value?.status !== 'unknown')
async function checkCompaction() {
  await action(() => checkThreadCompaction(threadId))
}
const helpCommands = buildComposerCommands([], [])
const unavailable = computed(() => descriptor.value?.requiresThread && !props.threadId ? '请先进入一个会话。' : descriptor.value?.idleOnly && props.busy ? '当前任务运行中。' : '')
const actionLabel = computed(() => ({ compact: '开始压缩', review: '开始审查', rename: '保存名称', fork: '创建分支', copy: '复制回复', export: '导出 Markdown' }[props.request.name as 'compact' | 'review' | 'rename' | 'fork' | 'copy' | 'export'] ?? '打开'))
function close() { if (!working.value) emit('close') }
async function action(fn: () => Promise<void>) {
  if (working.value || loading.value) return
  working.value = true; error.value = ''; feedback.value = ''
  let succeeded = false
  try { await fn(); succeeded = true } catch (cause) { if (!disposed) notifyOperation(cause instanceof Error ? cause.message : '操作失败') }
  finally {
    working.value = false
    if (pendingGoalNotification !== undefined) { goal.value = pendingGoalNotification; pendingGoalNotification = undefined }
    if (succeeded && props.request.name === 'goal' && threadId) emit('goal-change', goal.value, threadId)
  }
}
async function saveGoal() {
  await action(async () => {
    const patch = validateGoalInput(objective.value, budget.value)
    if (!supported.value) return
    if (threadId) await checkCurrentGoal()
    const nativePatch = goalSavePatch(goal.value, patch)
    if (!threadId) { consume(); threadId = await props.ensureThread(patch.objective) }
    await saveModelSettings()
    const next = await setThreadGoal(threadId, nativePatch)
    if (disposed) return
    fillGoalForm(next)
    consume()
    if (props.threadId !== threadId) await props.run('goal', threadId)
    emit('model-change', selectedModel.value, selectedEffort.value || selectedCapability.value?.defaultEffort || '')
    notifyOperation('目标已保存', 'success')
  })
}
async function changeGoalStatus(status: 'active' | 'paused') {
  await action(async () => {
    if (status === 'active') {
      await checkCurrentGoal()
      if (!goal.value) throw new Error('持续目标已被清除，请重新读取。')
      const problem = goalResumeProblem(goal.value)
      if (problem) throw new Error(problem)
      if (goalFormDirty.value) throw new Error('请先保存目标或预算的修改。')
      await saveModelSettings()
    }
    goal.value = await setThreadGoal(threadId, { status })
    notifyOperation(status === 'active' ? '目标已继续' : '目标已暂停', 'success')
    if (status === 'active') emit('model-change', selectedModel.value, selectedEffort.value || selectedCapability.value?.defaultEffort || '')
    consume()
  })
}
async function clearGoal() {
  await action(async () => {
    await checkCurrentGoal()
    await clearThreadGoal(threadId)
    fillGoalForm(null)
    consume()
    notifyOperation('目标已清除', 'success')
  })
}
async function execute() {
  if (unavailable.value || !supported.value) return
  await action(async () => {
    if (props.request.name === 'compact') {
      await compactThread(threadId, compactionRequest.value?.status === 'unknown')
      consume()
      return
    }
    // Consume before navigation while the originating composer is still mounted.
    const navigation = ['new', 'resume', 'apps', 'plugins', 'mcp', 'automations', 'fork', 'diff'].includes(props.request.name)
    if (navigation) consume()
    await props.run(props.request.name, value.value.trim())
    consume(); emit('close')
  })
}
onMounted(async () => {
    if (props.request.name === 'goal') unsubscribe = subscribeCodexNotifications(notification => {
      if (!threadId || !['thread/goal/updated', 'thread/goal/cleared'].includes(notification.method)) return
      const params = notification.params as { threadId?: string; goal?: ThreadGoal }
      if (params.threadId !== threadId || disposed) return
      goalRevision += 1
      let current: ThreadGoal | null
      try { current = notification.method.endsWith('/cleared') ? null : readThreadGoal(params.goal, threadId) } catch { error.value = '持续目标通知不完整，请重新打开。'; return }
      if (working.value) pendingGoalNotification = current
      else goal.value = current
    })
  if (['help', 'status'].includes(props.request.name)) { consume(); return }
  if (['goal', 'compact'].includes(props.request.name)) {
    loading.value = true
    try {
      const methods = await getMethodCatalog()
      const required = props.request.name === 'goal' ? ['thread/goal/get', 'thread/goal/set', 'thread/goal/clear', 'thread/settings/update'] : ['thread/compact/start']
      supported.value = required.every(method => methods.includes(method))
      if (!supported.value) throw new Error('当前 Codex 运行时不支持此命令，请检查 CLI 版本。')
      if (props.request.name === 'goal' && threadId) {
        const startedRevision = goalRevision
        const [current, settings] = await Promise.all([getThreadGoal(threadId), getGoalModelSettings(threadId)])
        if (disposed) return
        selectedModel.value = settings.model || props.model
        selectedEffort.value = settings.effort
        fillGoalForm(startedRevision === goalRevision ? current : goal.value)
      }
    } catch (cause) { if (!disposed) { supported.value = false; error.value = cause instanceof Error ? cause.message : '读取失败' } }
    finally { loading.value = false }

  }
})
onBeforeUnmount(() => { disposed = true; unsubscribe?.() })
</script>
