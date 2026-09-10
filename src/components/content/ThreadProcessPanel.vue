<template>
  <AppButton @click="show('hooks')">Hooks</AppButton>
  <AppButton @click="show('terminals')">{{ t('Codex 后台终端') }}</AppButton>
  <AppDialog :open="mode !== null" :title="t(mode === 'hooks' ? 'Hooks' : 'Codex 后台终端')" :busy="stopping" panel-class="thread-process-dialog" @close="close">
    <div class="process-heading"><small>{{ cwd }}</small><AppButton :disabled="loading || stopping" @click="load()">{{ t('刷新') }}</AppButton></div>
    <p v-if="loading" role="status">{{ t('读取中…') }}</p>
    <p v-if="error" class="process-error" role="alert">{{ t(error) }}</p>
    <template v-if="mode === 'hooks'">
      <p class="process-note">{{ t('观察记录始于') }} {{ formatLocalDateTime(hooks.observedSince) }}{{ t('；仅包含已收到的事件。') }}</p>
      <p v-if="hooks.error" class="process-error" role="alert">{{ t(hooks.error) }}</p>
      <p v-if="hooks.limited" class="process-note">{{ t('仅保留最近记录。') }}</p>
      <p v-if="!loading && !error && !hooks.runs.length">{{ t('尚未观察到本会话的 Hooks 执行。') }}</p>
      <HookRunCard v-for="run in hooks.runs" :key="hookRunKey(run)" :run="run" />
      <details class="process-config"><summary>{{ t('当前目录的 Hooks 配置（') }}{{ configuration?.hooks.length ?? '—' }}）</summary>
        <p v-if="configError" class="process-error" role="alert">{{ t(configError) }}</p>
        <p v-for="warning in configuration?.warnings" :key="warning" class="process-error">{{ t(warning) }}</p>
        <p v-if="configuration && !configuration.hooks.length">{{ t('当前目录没有 Hooks 配置。') }}</p>
        <p class="process-note">{{ t('需审阅的配置请在 Codex CLI 的 /hooks 中处理。') }}</p>
        <details v-for="definition in configuration?.hooks" :key="definition.key" class="process-card">
          <summary><span>{{ definition.statusMessage || definition.eventName }}</span><span>{{ t(definition.enabled ? '已启用' : '已禁用') }} · {{ t(trustLabel(definition.trustStatus)) }}</span></summary>
          <p>{{ definition.eventName }} · {{ definition.handlerType }} · {{ definition.source }}</p>
          <small>{{ definition.sourcePath }}</small><p v-if="definition.matcher">{{ t('匹配：') }}{{ definition.matcher }}</p><pre v-if="definition.command">{{ definition.command }}</pre>
        </details>
        <p v-if="configuration?.limited">{{ t('配置列表已截断。') }}</p>
      </details>
    </template>
    <template v-if="mode === 'terminals'">
      <p class="process-note">{{ t('Codex 启动的后台进程。') }}</p>
      <p v-if="terminalReadAt" class="process-note">{{ t('上次读取') }} {{ formatLocalDateTime(terminalReadAt) }}</p>
      <p v-if="!loading && !error && !terminals.length">{{ t('当前没有 Codex 后台终端。') }}</p>
      <p v-if="notice" role="status">{{ t(notice) }}</p>
      <article v-for="terminal in terminals" :key="terminal.processId" class="process-card background-terminal">
        <div class="process-heading"><strong>{{ t('后台运行 ·') }} {{ terminal.processId }}</strong><div class="process-actions"><AppButton @click="selectOutput(terminal)">{{ t('查看输出') }}</AppButton><AppButton v-if="canTerminate" variant="danger" :disabled="stopping || loading || !!error" @click="confirming = terminal">{{ t('停止') }}</AppButton></div></div>
        <pre>{{ terminal.command }}</pre><small>{{ terminal.cwd }}</small>
        <small class="process-id">{{ t(terminalMetrics(terminal)) }}</small>
        <section v-if="confirming?.processId === terminal.processId" class="process-confirm" :aria-label="t('确认停止进程')">
          <p><strong>{{ t('停止进程') }} {{ confirming.processId }}？</strong></p>
          <p>{{ t('命令项') }} {{ confirming.itemId }}</p>
          <div class="process-actions"><AppButton :disabled="stopping" @click="confirming = null">{{ t('取消') }}</AppButton><AppButton variant="danger" :busy="stopping" @click="terminate">{{ t('停止此进程') }}</AppButton></div>
        </section>
      </article>
      <section v-if="selected" class="process-card terminal-output" :aria-label="t('进程输出')">
        <div class="process-heading"><strong>{{ t('输出 ·') }} {{ selected.processId }}</strong><AppButton :disabled="outputLoading" @click="selectOutput(selected)">{{ t('重新读取输出') }}</AppButton></div>
        <p v-if="terminalReadAt && !terminals.some(row => row.processId === selected?.processId)">{{ t('已不在后台列表。') }}</p>
        <p v-if="outputLoading">{{ t('读取输出中…') }}</p><p v-if="outputError" class="process-error" role="alert">{{ t(outputError) }}</p>
        <template v-if="output">
          <p v-if="output.source === 'unavailable'">{{ t('当前观察记录及最近 10 回合中没有这条命令的输出。') }}</p>
          <template v-else><small>{{ t(output.source === 'toolResult' ? '工具返回片段' : output.source === 'history' ? '会话历史' : '已观察的输出') }} · {{ t(commandStatusLabel(output.status)) }}<template v-if="output.exitCode !== null"> {{ t('· 退出码') }} {{ output.exitCode }}</template></small><pre>{{ output.text || t('尚未收到输出。') }}</pre><small v-if="output.truncated">{{ t('只显示已记录的片段或尾部，最多 32k 字符。') }}</small></template>
        </template>
      </section>
    </template>
  </AppDialog>
</template>

<script setup lang="ts">
import { t } from '../../composables/useUiLanguage'

import { onBeforeUnmount, onMounted, ref } from 'vue'
import AppButton from '../common/AppButton.vue'
import AppDialog from '../common/AppDialog.vue'
import HookRunCard from './HookRunCard.vue'
import { fetchRpcMethodCatalog } from '../../api/codexRpcClient'
import { formatDirectoryError } from '../../directory'
import { formatLocalDateTime } from '../../dateTime'
import { subscribeTaskNotifications } from '../../subtasks'
import { hookRunKey, OUTPUT_LIMIT, readCommandOutput, type BackgroundTerminal, type CommandOutput, type HookConfiguration, type HookSnapshot } from '../../processActivity'

const props = defineProps<{ threadId: string; cwd: string }>()
const mode = ref<'hooks' | 'terminals' | null>(null)
const loading = ref(false)
const error = ref('')
const hooks = ref<HookSnapshot>({ runs: [], observedSince: Date.now(), limited: false, error: '' })
const configuration = ref<HookConfiguration | null>(null)
const configError = ref('')
const terminals = ref<BackgroundTerminal[]>([])
const terminalReadAt = ref(0)
const canTerminate = ref(false)
const confirming = ref<BackgroundTerminal | null>(null)
const stopping = ref(false)
const notice = ref('')
const selected = ref<BackgroundTerminal | null>(null)
const output = ref<CommandOutput | null>(null)
const outputLoading = ref(false)
const outputError = ref('')
let controller: AbortController | null = null
let outputController: AbortController | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let methods: Set<string> | null = null
let pendingRefresh = false
let pendingConfigRefresh = false
let disposed = false
let outputRevision = 0

const trustLabel = (status: string) => ({ trusted: '已信任', managed: '策略管理', untrusted: '待审阅', modified: '配置已变更' } as Record<string, string>)[status] || '信任状态未知'
const commandStatusLabel = (status: string) => ({ inProgress: '执行中', completed: '已结束', failed: '失败', declined: '已拒绝', interrupted: '已中断' } as Record<string, string>)[status] || '状态待确认'
const terminalMetrics = (row: BackgroundTerminal) => [row.osPid !== null ? `PID ${row.osPid}` : '', row.cpuPercent !== null ? `CPU ${row.cpuPercent.toFixed(1)}%` : '', row.rssKb !== null ? `内存 ${(row.rssKb / 1024).toFixed(1)} MB` : ''].filter(Boolean).join(' · ')

async function read<T>(path: string, query: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/codex-api/process-activity/' + path + '?' + new URLSearchParams({ threadId: props.threadId, ...query }), { signal })
  const payload = await response.json()
  if (!response.ok || payload.data === undefined) throw new Error(payload.error || '进程状态读取失败')
  return payload.data
}

async function load(refreshConfig = true) {
  if (!mode.value || disposed) return
  if (loading.value) {
    pendingRefresh = true
    pendingConfigRefresh ||= refreshConfig
    return
  }
  const request = new AbortController()
  controller = request
  loading.value = true
  error.value = ''
  const current = mode.value
  try {
    if (!methods) methods = new Set(await fetchRpcMethodCatalog())
    if (request.signal.aborted || controller !== request) return
    if (current === 'hooks') {
      const results = await Promise.allSettled([
        read<HookSnapshot>('hooks', {}, request.signal),
        !refreshConfig && configuration.value ? Promise.resolve(configuration.value) : methods.has('hooks/list') ? read<HookConfiguration>('hook-config', { cwd: props.cwd }, request.signal) : Promise.reject(new Error('当前 CLI 不支持 Hooks 配置查询')),
      ])
      if (request.signal.aborted || controller !== request) return
      const [history, config] = results
      if (history.status === 'fulfilled') hooks.value = history.value
      else error.value = formatDirectoryError(history.reason, 'Hooks 记录读取失败')
      configuration.value = config.status === 'fulfilled' ? config.value : null
      configError.value = config.status === 'rejected' ? formatDirectoryError(config.reason, 'Hooks 配置读取失败') : ''
    } else {
      if (!methods.has('thread/backgroundTerminals/list')) throw new Error('当前 CLI 不支持后台终端查询')
      const rows = await read<BackgroundTerminal[]>('terminals', {}, request.signal)
      if (request.signal.aborted || controller !== request) return
      terminals.value = rows
      terminalReadAt.value = Date.now()
      canTerminate.value = methods.has('thread/backgroundTerminals/terminate')
      if (confirming.value && !rows.some(row => row.processId === confirming.value?.processId && row.itemId === confirming.value.itemId)) confirming.value = null
    }
  } catch (cause) {
    if (!request.signal.aborted && controller === request) error.value = formatDirectoryError(cause, '进程状态读取失败')
  } finally {
    if (controller === request) {
      loading.value = false
      if (pendingRefresh) {
        pendingRefresh = false
        refreshSoon(pendingConfigRefresh)
      }
    }
  }
}

function refreshSoon(refreshConfig = false) {
  if (!mode.value || disposed) return
  pendingConfigRefresh ||= refreshConfig
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    const configRefresh = pendingConfigRefresh
    pendingConfigRefresh = false
    void load(configRefresh)
  }, 200)
}

function close() {
  if (stopping.value) return
  mode.value = null
  controller?.abort()
  controller = null
  outputController?.abort()
  outputController = null
  if (timer) clearTimeout(timer)
  timer = null
  loading.value = false
  outputLoading.value = false
  pendingRefresh = false
  pendingConfigRefresh = false
  confirming.value = null
}

function show(next: 'hooks' | 'terminals') {
  close()
  mode.value = next
  notice.value = ''
  void load()
}

async function selectOutput(row: BackgroundTerminal) {
  outputController?.abort()
  const request = new AbortController()
  outputController = request
  const revision = ++outputRevision
  selected.value = row
  output.value = null
  outputError.value = ''
  outputLoading.value = true
  try {
    const result = await read<CommandOutput>('output', { itemId: row.itemId }, request.signal)
    if (!request.signal.aborted && outputController === request && revision === outputRevision) output.value = result
  } catch (cause) {
    if (!request.signal.aborted && outputController === request) outputError.value = formatDirectoryError(cause, '输出读取失败')
  } finally {
    if (outputController === request) outputLoading.value = false
  }
}

async function terminate() {
  const row = confirming.value
  if (!row || stopping.value) return
  stopping.value = true
  notice.value = ''
  try {
    const response = await fetch('/codex-api/process-activity/terminate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: props.threadId, processId: row.processId, itemId: row.itemId }) })
    const payload = await response.json()
    if (!response.ok || !payload.data) throw new Error(payload.error || '停止结果无法确认')
    if (!disposed) notice.value = payload.data.absent ? '进程已不在后台列表。' : payload.data.terminated ? '已收到原生停止确认。' : '原生接口未停止该进程，请检查当前状态。'
  } catch (cause) {
    if (!disposed) notice.value = formatDirectoryError(cause, '停止结果无法确认') + '；请核对当前列表。'
  } finally {
    stopping.value = false
    confirming.value = null
    if (!disposed) {
      await load()
      if (selected.value?.itemId === row.itemId) await selectOutput(selected.value)
    }
  }
}

const unsubscribe = subscribeTaskNotifications(({ method, params }) => {
  if (!mode.value || disposed) return
  if (['codexapp/reconnected', 'codexapp/runtime/stopped'].includes(method)) {
    if (method === 'codexapp/runtime/stopped' && output.value?.status === 'inProgress') output.value.status = 'unknown'
    refreshSoon(true)
    return
  }
  const value = params as Record<string, any> | null
  if (value?.threadId !== props.threadId) return
  if (mode.value === 'hooks') {
    if (['hook/started', 'hook/completed'].includes(method)) refreshSoon()
    return
  }
  if (method === 'item/commandExecution/outputDelta' && value.itemId === selected.value?.itemId && typeof value.delta === 'string') {
    if (output.value && !['inProgress', 'unknown'].includes(output.value.status)) return
    outputRevision++
    const text = (output.value?.text || '') + value.delta
    output.value = { itemId: value.itemId, text: text.slice(-OUTPUT_LIMIT), status: 'inProgress', exitCode: null,
      truncated: output.value?.truncated || !output.value || text.length > OUTPUT_LIMIT, source: 'observed' }
  }
  if ((['item/started', 'item/completed'].includes(method) && value.item?.type === 'commandExecution')
    || ['item/commandExecution/terminalInteraction', 'turn/completed'].includes(method)) {
    if (method === 'item/completed' && value.item?.id === selected.value?.itemId) {
      outputRevision++
      output.value = readCommandOutput(value.item, 'observed')
    }
    refreshSoon()
  }
})
const onFocus = () => refreshSoon(true)
onMounted(() => window.addEventListener('focus', onFocus))
onBeforeUnmount(() => {
  disposed = true
  stopping.value = false
  close()
  unsubscribe()
  window.removeEventListener('focus', onFocus)
})
</script>
