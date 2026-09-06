<template>
  <AppDialog :open="true" :title="`/${request.name} · ${title}`" @close="close">
    <div class="thread-command-dialog" :aria-busy="working || loading">
      <p v-if="error" class="thread-command-error" role="alert">{{ error }}</p>
      <p v-if="feedback" class="thread-command-feedback" role="status">{{ feedback }}</p>
      <p v-if="loading">读取中…</p>
      <template v-if="request.name === 'goal'">
        <p>目标会保存在会话中，由 Codex 持续推进；可随时暂停或清除。保存为运行中后会自动开始。</p>
        <p v-if="goal" class="thread-goal-status">{{ goalLabels[goal.status] }} · 已用 {{ goal.tokensUsed.toLocaleString() }} tokens · {{ Math.round(goal.timeUsedSeconds / 60) }} 分钟</p>
        <label>目标<textarea v-model="objective" data-autofocus rows="5" maxlength="8000" :disabled="working || loading" placeholder="说明希望完成什么，以及如何验收" /></label>
        <label>Token 预算（默认 M，可填 M/B）<input v-model="budget" maxlength="50" spellcheck="false" :disabled="working || loading" placeholder="如 1、1.5M 或 0.01B；留空不设预算" /></label>
        <p class="thread-command-hint">M = 100 万 tokens；B = 10 亿 tokens。不写单位时按 M 计算。</p>
        <p v-if="goal && objective.trim() !== goal.objective" class="thread-command-hint">修改目标内容会重置该目标的用量统计。</p>
        <div class="thread-command-actions">
          <button type="button" :disabled="working || loading || !supported || !objective.trim()" @click="saveGoal">{{ goal ? '保存目标' : '保存并开始' }}</button>
          <button v-if="goal" type="button" :disabled="working || loading || !supported" @click="changeGoalStatus(goal.status === 'active' ? 'paused' : 'active')">{{ goal.status === 'active' ? '暂停目标' : '继续目标' }}</button>
          <button v-if="goal" type="button" :disabled="working || loading || !supported" @click="clearGoal">清除目标</button>
        </div>
        <p class="thread-command-hint">暂停或清除停止目标的后续推进；当前已开始的回合仍可继续，需立即停止时使用会话停止按钮。</p>
      </template>
      <template v-else-if="request.name === 'help'">
        <p>输入 / 后继续搜索；↑↓ 选择，Enter 确认，Esc 收起。未选择命令时按原方式输入和发送文字。</p>
        <dl class="thread-command-help"><template v-for="command in helpCommands" :key="command.id"><dt>{{ command.name }}</dt><dd>{{ command.description }}</dd></template></dl>
        <p class="thread-command-hint">命令有明确的适用条件。终端退出、桌面专属等操作不放入 WebUI 目录；可用技能及保存的提示词会自动补入。</p>
      </template>
      <template v-else-if="request.name === 'status'">
        <dl class="thread-command-status"><dt>会话</dt><dd>{{ threadName || '新会话' }}</dd><dt>模型</dt><dd>{{ model || '未选择' }}</dd><dt>推理强度</dt><dd>{{ effort || '默认' }}</dd><dt>运行状态</dt><dd>{{ busy ? '当前任务运行中，新消息默认排队' : '空闲' }}</dd><dt>工作目录</dt><dd>{{ cwd || '未选择' }}</dd><dt>上下文</dt><dd>{{ contextSummary }}</dd></dl>
      </template>
      <template v-else>
        <p>{{ descriptor?.description }}</p>
        <label v-if="request.name === 'rename'">会话名称<input v-model="value" data-autofocus maxlength="200" /></label>
        <p v-if="request.name === 'compact'" class="thread-command-hint">开始压缩后请在会话中查看进度。任务运行中时需先等待结束。</p>
        <p v-if="request.name === 'review'" class="thread-command-hint">会在当前会话发起一次代码审查，使用当前运行时模型。</p>
        <p v-if="unavailable" class="thread-command-hint">{{ unavailable }}</p>
        <button type="button" :disabled="working || loading || !!unavailable || !supported || (request.name === 'rename' && !value.trim())" @click="execute">{{ actionLabel }}</button>
      </template>
    </div>
  </AppDialog>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import AppDialog from '../common/AppDialog.vue'
import { APP_COMMANDS, buildComposerCommands, type AppCommandName, type AppCommandRequest } from './composerCommands'
import { getMethodCatalog, subscribeCodexNotifications } from '../../api/codexGateway'
import { compactThread, getThreadGoal, setThreadGoal, clearThreadGoal, validateGoalInput, formatGoalTokenBudget, goalStatusLabels, type ThreadGoal } from '../../api/threadCommands'
const props = defineProps<{
  request: AppCommandRequest; threadId: string; threadName: string; cwd: string; model: string; effort: string; busy: boolean; contextSummary: string
  run: (name: AppCommandName, value?: string) => Promise<void>
  ensureThread: (objective?: string) => Promise<string>
}>()
const emit = defineEmits<{ close: []; 'goal-change': [goal: ThreadGoal | null, threadId: string] }>()
const descriptor = computed(() => APP_COMMANDS.find(command => command.id === props.request.name))
const title = computed(() => ({ goal: '持续目标', help: '命令帮助', status: '会话状态' }[props.request.name as 'goal' | 'help' | 'status'] ?? descriptor.value?.description ?? '会话操作'))
const value = ref(props.threadName), objective = ref(''), budget = ref(''), goal = ref<ThreadGoal | null>(null)
const working = ref(false), loading = ref(false), supported = ref(true), error = ref(''), feedback = ref('')
let disposed = false, consumed = false, threadId = props.threadId, unsubscribe: (() => void) | undefined
let pendingGoalNotification: ThreadGoal | null | undefined
const consume = () => { if (!consumed) { props.request.complete(); consumed = true } }
const goalLabels = goalStatusLabels
const helpCommands = buildComposerCommands([], [])
const unavailable = computed(() => descriptor.value?.requiresThread && !props.threadId ? '请先进入一个会话。' : descriptor.value?.idleOnly && props.busy ? '当前任务运行中，请等待结束后再操作。' : '')
const actionLabel = computed(() => ({ compact: '开始压缩', review: '开始审查', rename: '保存名称', fork: '创建分支', copy: '复制回复', export: '导出 Markdown' }[props.request.name as 'compact' | 'review' | 'rename' | 'fork' | 'copy' | 'export'] ?? '打开'))
function close() { if (!working.value) emit('close') }
async function action(fn: () => Promise<void>) {
  if (working.value || loading.value) return
  working.value = true; error.value = ''; feedback.value = ''
  let succeeded = false
  try { await fn(); succeeded = true } catch (cause) { if (!disposed) error.value = cause instanceof Error ? cause.message : '操作失败' }
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
    if (!threadId) { consume(); threadId = await props.ensureThread(patch.objective) }
    const next = await setThreadGoal(threadId, { ...patch, status: goal.value?.status === 'paused' ? 'paused' : 'active' })
    if (disposed) return
    goal.value = next; consume();
    if (props.threadId !== threadId) await props.run('goal', threadId)
    feedback.value = '目标已保存。运行状态和进度会随会话更新。'
  })
}
async function changeGoalStatus(status: 'active' | 'paused') {
  await action(async () => { goal.value = await setThreadGoal(threadId, { status }); consume() })
}
async function clearGoal() {
  await action(async () => { await clearThreadGoal(threadId); goal.value = null; objective.value = ''; budget.value = ''; consume(); feedback.value = '目标已清除，原会话仍保留。' })
}
async function execute() {
  if (unavailable.value || !supported.value) return
  await action(async () => {
    if (props.request.name === 'compact') {
      await compactThread(threadId); consume(); feedback.value = '已请求压缩，请在会话中查看执行进度。'; return
    }
    // Consume before navigation while the originating composer is still mounted.
    const navigation = ['new', 'resume', 'apps', 'plugins', 'mcp', 'automations', 'fork', 'diff'].includes(props.request.name)
    if (navigation) consume()
    await props.run(props.request.name, value.value.trim())
    consume(); emit('close')
  })
}
onMounted(async () => {
  if (['help', 'status'].includes(props.request.name)) { consume(); return }
  if (['goal', 'compact'].includes(props.request.name)) {
    loading.value = true
    try {
      const methods = await getMethodCatalog()
      const required = props.request.name === 'goal' ? ['thread/goal/get', 'thread/goal/set', 'thread/goal/clear'] : ['thread/compact/start']
      supported.value = required.every(method => methods.includes(method))
      if (!supported.value) throw new Error('当前 Codex 运行时不支持此命令，请检查 CLI 版本。')
      if (props.request.name === 'goal' && threadId) {
        const current = await getThreadGoal(threadId)
        if (disposed) return
        goal.value = current; objective.value = current?.objective ?? ''; budget.value = formatGoalTokenBudget(current?.tokenBudget)
      }
    } catch (cause) { if (!disposed) { supported.value = false; error.value = cause instanceof Error ? cause.message : '读取失败' } }
    finally { loading.value = false }
    if (props.request.name === 'goal') unsubscribe = subscribeCodexNotifications(notification => {
      if (!threadId || !['thread/goal/updated', 'thread/goal/cleared'].includes(notification.method)) return
      const params = notification.params as { threadId?: string; goal?: ThreadGoal }
      if (params.threadId !== threadId || disposed) return
      const current = notification.method.endsWith('/cleared') ? null : params.goal ?? goal.value
      if (working.value) pendingGoalNotification = current
      else goal.value = current
    })
  }
})
onBeforeUnmount(() => { disposed = true; unsubscribe?.() })
</script>
