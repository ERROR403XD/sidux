<template>
  <div class="api-proxy-panel" data-testid="api-proxy-panel">
    <p class="api-proxy-intro">使用账号池为外部 Codex 客户端提供 API 接入。</p>
    <p v-if="error" role="alert" class="api-proxy-error">{{ error }}</p>
    <p v-if="!status">正在读取出口状态…</p>
    <template v-else>
      <section class="api-proxy-card">
        <div class="api-proxy-heading"><h2>服务与账号</h2><span class="api-proxy-state">{{ stateLabel }}</span></div>
        <p v-if="status.lastError" class="api-proxy-error">{{ status.lastError }}</p>
        <p v-if="status.retryAt" class="api-proxy-muted">下次可重试：{{ date(status.retryAt) }}；保持启用即可等待恢复。</p>
        <label class="api-proxy-check"><input v-model="settings.enabled" type="checkbox" :disabled="busy || !status.installed" />启用 API 出口</label>
        <div class="api-proxy-fields">
          <label>API 使用账号
            <AppSelect v-model="selectedAccount" :options="accountOptions" enable-search :disabled="busy" />
          </label>
          <div><span class="api-proxy-label">WebUI 当前账号</span><p>{{ accountName(status.accounts.activeStorageId) }}</p></div>
          <label>全局并发<input v-model.number="settings.globalConcurrency" class="app-input" type="number" min="1" max="64" :disabled="busy" /></label>
          <label>每把 key 并发<input v-model.number="settings.keyConcurrency" class="app-input" type="number" min="1" max="32" :disabled="busy" /></label>
          <label>等待请求结束的上限（秒）<input v-model.number="settings.drainTimeoutSeconds" class="app-input" type="number" min="1" max="300" :disabled="busy" /></label>
        </div>
        <p class="api-proxy-muted">当前实际 API 账号：{{ status.settings.enabled ? accountName(status.selectedStorageId || status.settings.accountStorageId || status.accounts.activeStorageId) : '未启用' }}</p>
        <p class="api-proxy-muted">切换前停止新接入并等待当前请求结束；等待超时保留原设置。空闲 WebSocket 会正常关闭，客户端随后重连。</p>
        <div class="api-proxy-actions">
          <AppButton :busy="busy" @click="save(false)">保存并等待当前请求结束</AppButton>
          <AppButton variant="danger" :disabled="busy" @click="forceDialog = true">中断活动连接并保存…</AppButton>
        </div>
      </section>
      <section class="api-proxy-card">
        <div class="api-proxy-heading api-proxy-key-heading">
          <h2>API key</h2>
          <div class="api-proxy-actions api-proxy-key-toolbar">
            <AppButton :disabled="busy" @click="openCreate()">创建API key</AppButton>
            <AppButton @click="showInvalid = !showInvalid">{{ showInvalid ? '返回生效 API Key' : '查看失效API key' }}</AppButton>
            <AppButton @click="usageDialog = true">Token统计</AppButton>
            <AppButton :busy="busy" @click="savePolicies">保存配置</AppButton>
          </div>
        </div>
        <p v-if="!status.keys.length">尚未创建 API key。</p>
        <p v-if="status.usage?.error" role="alert" class="api-proxy-error">{{ status.usage.error }}</p>
        <div v-for="key in visibleKeys" :key="key.id" class="api-proxy-key-row">
          <div class="api-proxy-key-copy"><div class="api-proxy-key-title"><strong>{{ key.name }}</strong><span>••••{{ key.suffix }}</span><small>到期：{{ key.expiresAt ? date(key.expiresAt) : '无限' }}</small><span v-if="showInvalid">{{ keyLabel(key) }}</span></div>
            <small>最近使用：{{ date(key.lastUsedAt) }}</small>
            <div v-if="policyDrafts[key.id]" class="api-proxy-inline-policy">
              <AppSelect v-model="policyDrafts[key.id]!.account" :options="keyAccountOptions" enable-search :disabled="busy || !!key.revokedAt" />
              <label class="api-proxy-check"><input v-model="policyDrafts[key.id]!.protected" type="checkbox" :disabled="busy || !!key.revokedAt" />受保护</label>
            </div>

          </div>
          <div class="api-proxy-actions">
            <AppButton :disabled="busy || !!key.revokedAt" @click="renameTarget = key; renameValue = key.name">重命名</AppButton>
            <AppButton :disabled="busy || !!key.revokedAt" @click="updateKey(key, { enabled: !key.enabled })">{{ key.enabled ? '停用' : '启用' }}</AppButton>
            <AppButton :disabled="busy || !!key.revokedAt" @click="openCreate(key)">轮换</AppButton>
            <AppButton variant="danger" :disabled="busy || !!key.revokedAt" @click="revokeTarget = key; interruptKey = false">撤销…</AppButton>
          </div>
        </div>
      </section>
      <section class="api-proxy-card">
        <div class="api-proxy-heading"><h2>Codex 客户端接入</h2><AppButton :disabled="busy || !status.settings.enabled" @click="loadModels">读取模型目录</AppButton></div>
        <label>Base URL<input class="app-input" :value="baseUrl" readonly /></label>
        <label>模型<AppSelect v-model="model" :options="modelOptions" enable-search /></label>
        <pre class="api-proxy-config">{{ clientConfig }}</pre>
        <p class="api-proxy-muted">将创建的 key 放入客户端环境变量 CODEXAPP_API_KEY。客户端不需要服务器账号的 auth.json。Claude Code 和聊天客户端专项适配暂未提供。</p>
        <p class="api-proxy-muted">支持 Responses HTTP/SSE/WebSocket、模型列表、Codex 原生压缩和基础 Chat Completions；HTTP 续接需发送完整 input。</p>
        <p class="api-proxy-muted">当前组件不支持 ultra 推理强度；以本出口返回的模型能力为准。</p>
      </section>
      <section class="api-proxy-card">
        <div class="api-proxy-heading"><h2>活动连接</h2><AppButton :disabled="busy" @click="refresh(false)">刷新</AppButton></div>
        <p>正在处理 {{ status.activity.activeRequests }} · 连接 {{ status.activity.connections }} · 空闲 WebSocket {{ status.activity.idleWebSockets }}</p>
        <div class="api-proxy-table-wrap"><table><thead><tr><th>key</th><th>传输</th><th>模型</th><th>开始时间</th><th>状态</th></tr></thead><tbody>
          <tr v-for="entry in status.activity.entries" :key="entry.id"><td>{{ keyName(entry.keyId) }}</td><td>{{ entry.transport }}</td><td>{{ entry.model || '—' }}</td><td>{{ date(entry.startedAt) }}</td><td>{{ entry.status }}</td></tr>
          <tr v-if="!status.activity.entries.length"><td colspan="5">当前没有活动连接。</td></tr>
        </tbody></table></div>
        <details v-if="status.activity.recent.length"><summary>近期请求（本次运行）</summary><div class="api-proxy-table-wrap"><table><tbody>
          <tr v-for="entry in status.activity.recent.slice(0, 30)" :key="entry.id"><td>{{ keyName(entry.keyId) }}</td><td>{{ entry.transport }}</td><td>{{ entry.model || '—' }}</td><td>{{ date(entry.startedAt) }}</td><td>{{ entry.status }}</td></tr>
        </tbody></table></div></details>
      </section>
      <p class="api-proxy-muted">CLIProxyAPI {{ status.componentVersion }} · 模型目录随组件版本固定 · 请求记录不保存提示词、回复或工具参数。</p>
    </template>
    <AppDialog :open="usageDialog" title="Token统计" panel-class="api-proxy-usage-dialog" @close="usageDialog = false">
      <div class="api-proxy-usage-filters">
        <label>统计周期<AppSelect v-model="usageWindow" :options="usageWindows" /></label>
        <label>API key<AppSelect v-model="usageKey" :options="usageKeyOptions" enable-search /></label>
      </div>
      <p v-if="status?.usage?.error" class="api-proxy-error" role="alert">{{ status.usage.error }}</p>
      <div class="api-proxy-usage-total"><span>总 Token</span><strong>{{ selectedUsage.total.toLocaleString() }}</strong></div>
      <div class="api-proxy-usage-grid">
        <div><span>输入</span><strong>{{ selectedUsage.input.toLocaleString() }}</strong></div>
        <div><span>输出</span><strong>{{ selectedUsage.output.toLocaleString() }}</strong></div>
        <div><span>缓存输入</span><strong>{{ selectedUsage.cached.toLocaleString() }}</strong></div>
        <div><span>推理</span><strong>{{ selectedUsage.reasoning.toLocaleString() }}</strong></div>
      </div>
      <div class="api-proxy-usage-requests"><span>请求 <b>{{ selectedUsage.requests }}</b></span><span>成功 <b>{{ selectedUsage.completed }}</b></span><span>失败 <b>{{ selectedUsage.failed }}</b></span><span>中断 <b>{{ selectedUsage.interrupted }}</b></span><span>拒绝 <b>{{ selectedUsage.rejected }}</b></span><span>用量缺失 <b>{{ selectedUsage.unknown }}</b></span></div>
    </AppDialog>
    <AppDialog :open="createDialog" :title="rotateTarget ? '轮换 API key' : '创建 API key'" :busy="busy" panel-class="api-proxy-key-dialog" @close="closeCreate">
      <p v-if="error" role="alert" class="api-proxy-error">{{ error }}</p>
      <div v-if="!secret" class="api-proxy-key-form">
        <label>名称
          <input v-model="keyNameDraft" class="app-input" data-autofocus maxlength="80" :disabled="busy" />
        </label>
        <label>持续时间（天）
          <input v-model="keyDurationDays" class="app-input" type="number" min="1" step="1" placeholder="无限" :disabled="busy" />
        </label>
        <label>使用账号<AppSelect v-model="keyAccountDraft" :options="keyAccountOptions" enable-search :disabled="busy" /></label>
        <label class="api-proxy-check"><input v-model="keyProtectedDraft" type="checkbox" :disabled="busy" />受保护</label>
        <p v-if="rotateTarget" class="api-proxy-muted">旧 key 将于 24 小时后到期，也可提前撤销。</p>
      </div>
      <template v-else><p>请现在保存完整 key，关闭后不会再次显示。</p><textarea class="app-input api-proxy-secret" :value="secret" readonly rows="3" aria-label="新 API key" /><AppButton @click="copySecret">复制 key</AppButton></template>
      <template #footer><AppButton :disabled="busy" @click="closeCreate">{{ secret ? '已保存，关闭' : '取消' }}</AppButton><AppButton v-if="!secret" :busy="busy" @click="createKey">创建</AppButton></template>
    </AppDialog>
    <AppDialog :open="!!revokeTarget" title="撤销 API key" :busy="busy" size="compact" @close="revokeTarget = null">
      <p>撤销“{{ revokeTarget?.name }}”后无法重新启用。</p><label class="api-proxy-check"><input v-model="interruptKey" type="checkbox" />同时中断这把 key 的活动连接（{{ keyActivityCount }}）</label>
      <template #footer><AppButton :disabled="busy" @click="revokeTarget = null">取消</AppButton><AppButton variant="danger" :busy="busy" @click="revokeKey">撤销</AppButton></template>
    </AppDialog>
    <AppDialog :open="!!policyTarget" title="账号与额度保护" :busy="busy" size="compact" @close="policyTarget = null">
      <p v-if="error" class="api-proxy-error" role="alert">{{ error }}</p>
      <label>使用账号<AppSelect v-model="keyAccountDraft" :options="keyAccountOptions" enable-search :disabled="busy" /></label>
      <label class="api-proxy-check"><input v-model="keyProtectedDraft" type="checkbox" :disabled="busy" />受保护</label>
      <p class="api-proxy-muted">保护值在账号设置中配置，受保护Key共享所选账号的预留额度。保存会断开此Key的旧连接。</p>
      <template #footer><AppButton :disabled="busy" @click="policyTarget = null">取消</AppButton><AppButton :busy="busy" @click="savePolicy">保存</AppButton></template>
    </AppDialog>
    <AppDialog :open="!!renameTarget" title="重命名 API key" :busy="busy" size="compact" @close="renameTarget = null"><input v-model="renameValue" class="app-input" maxlength="80" data-autofocus /><template #footer><AppButton :busy="busy" @click="renameKey">保存</AppButton></template></AppDialog>
    <AppDialog :open="forceDialog" title="中断活动连接并保存" :busy="busy" size="compact" @close="forceDialog = false"><p>将中断 {{ status?.activity.connections || 0 }} 个连接，其中 {{ status?.activity.activeRequests || 0 }} 个请求正在处理。客户端会收到中断，需要重新连接。</p><template #footer><AppButton :disabled="busy" @click="forceDialog = false">取消</AppButton><AppButton variant="danger" :busy="busy" @click="save(true)">中断并保存</AppButton></template></AppDialog>
  </div>
</template>

<script setup lang="ts">
import { accountDisplayName } from '../../accountDisplay'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import AppButton from '../common/AppButton.vue'
import AppDialog from '../common/AppDialog.vue'
import AppSelect from '../common/AppSelect.vue'
import { formatLocalDateTime, displayTimeZone } from '../../dateTime'
import { emptyUsage } from '../../api/proxyUsageTypes'
import { copyTextToClipboard } from '../../utils/clipboard'
import { apiProxyRequest, type ApiProxyKey, type ApiProxySettings, type ApiProxyStatus } from '../../api/apiProxy'

const showInvalid = ref(false)
const usageDialog = ref(false)
const usageKey = ref('all')
const usageKeyOptions = computed(() => [{ value: 'all', label: '全部 API key' }, ...(status.value?.keys || []).map(key => ({ value: key.id, label: `${key.name} · ••••${key.suffix}${key.revokedAt ? ' · 已失效' : ''}` }))])
const selectedUsage = computed(() => {
  if (usageKey.value !== 'all') return usageFor(usageKey.value)
  const total = emptyUsage()
  for (const summary of Object.values(status.value?.usage?.keys || {})) {
    const row = summary[usageWindow.value]
    for (const field of Object.keys(total) as Array<keyof typeof total>) total[field] += row[field] || 0
  }
  return total
})
const policyDrafts = ref<Record<string, { account: string; protected: boolean }>>({})
const visibleKeys = computed(() => (status.value?.keys || []).filter(key => {
  const invalid = !!key.revokedAt || !key.enabled || !!key.expiresAt && Date.parse(key.expiresAt) <= Date.now()
  return showInvalid.value ? invalid : !invalid
}))
async function savePolicies(): Promise<void> {
  await run(async () => {
    for (const key of status.value?.keys || []) {
      const draft = policyDrafts.value[key.id]
      if (!draft || key.revokedAt) continue
      const accountStorageId = draft.account === 'global' ? null : draft.account
      if (accountStorageId === key.accountStorageId && draft.protected === key.protected) continue
      await apiProxyRequest(`/keys/${key.id}`, { accountStorageId, protected: draft.protected })
      key.accountStorageId = accountStorageId
      key.protected = draft.protected
    }
  })
}
const status = ref<ApiProxyStatus | null>(null)
const settings = ref<ApiProxySettings>({ enabled: false, accountStorageId: null, globalConcurrency: 8, keyConcurrency: 4, drainTimeoutSeconds: 60 })
const busy = ref(false)
const error = ref('')
const createDialog = ref(false)
const forceDialog = ref(false)
const secret = ref('')
const keyNameDraft = ref('Codex CLI')
const keyDurationDays = ref('')
const rotateTarget = ref<ApiProxyKey | null>(null)
const revokeTarget = ref<ApiProxyKey | null>(null)
const renameTarget = ref<ApiProxyKey | null>(null)
const renameValue = ref('')
const interruptKey = ref(false)
const policyTarget = ref<ApiProxyKey | null>(null)
const keyAccountDraft = ref('global')
const keyProtectedDraft = ref(false)
const keyAccountOptions = computed(() => [{ value: 'global', label: '全局账号' }, ...accountOptions.value.filter(option => option.value !== 'follow')])
const model = ref('gpt-5.6-luna')
const models = ref<string[]>([])
const usageWindow = ref<'cumulative' | 'today' | 'week'>('cumulative')
const usageWindows = [{ value: 'cumulative', label: '累计' }, { value: 'today', label: '今日' }, { value: 'week', label: '近 7 天' }]
function usageFor(id: string) { return status.value?.usage?.keys[id]?.[usageWindow.value] || emptyUsage() }
let timer: ReturnType<typeof setInterval> | undefined
let refreshing = false
let disposed = false
const selectedAccount = computed({ get: () => settings.value.accountStorageId || 'follow', set: value => { settings.value.accountStorageId = value === 'follow' ? null : value } })
const accountOptions = computed(() => [{ value: 'follow', label: '跟随 WebUI 当前账号' }, ...(status.value?.accounts.accounts || []).map(account => ({ value: account.storageId, label: `${accountDisplayName(account)} · ${accountStatusLabel(account.authStatus)}` }))])
const modelOptions = computed(() => [...new Set([model.value, ...models.value])].map(value => ({ value, label: value })))
const baseUrl = `${window.location.origin}/v1`
const stateLabel = computed(() => !status.value?.installed ? '组件未安装' : status.value.activity.draining ? '等待活动请求结束' : !status.value.settings.enabled ? '未启用' : status.value.retryAt ? '等待恢复' : status.value.ready ? '可用' : status.value.lastError ? '异常' : '已启用')
const keyActivityCount = computed(() => status.value?.activity.entries.filter(entry => entry.keyId === revokeTarget.value?.id).length || 0)
const clientConfig = computed(() => `model_provider = "codexapp_gateway"\nmodel = "${model.value}"\n\n[model_providers.codexapp_gateway]\nname = "CodexApp API"\nbase_url = "${baseUrl}"\nenv_key = "CODEXAPP_API_KEY"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = true`)
function accountStatusLabel(value: string): string { return ({ ready: '可用', stale: '待确认', refreshing: '刷新中', reauth_required: '需重新登录', payment_required: '需处理额度', transient_error: '暂时异常', materialization_dirty: '需修复认证' } as Record<string, string>)[value] || value }
function date(value: string | null): string { return value ? formatLocalDateTime(value, { second: '2-digit' }) : '—' }
function accountName(id: string | null): string { const account = status.value?.accounts.accounts.find(row => row.storageId === id); return account ? accountDisplayName(account) : '未选择' }
function keyName(id: string): string { return status.value?.keys.find(key => key.id === id)?.name || id.slice(0, 8) }
function keyLabel(key: ApiProxyKey): string { return key.revokedAt ? '已撤销' : key.expiresAt && Date.parse(key.expiresAt) <= Date.now() ? '已到期' : key.enabled ? '可用' : '已停用' }
async function refresh(reset = false): Promise<void> {
  if (refreshing || disposed) return
  refreshing = true
  try {
    const next = await apiProxyRequest<ApiProxyStatus>(`/status?timeZone=${encodeURIComponent(displayTimeZone())}`)
    if (disposed) return
    for (const key of next.keys) {
      if (!policyDrafts.value[key.id]) policyDrafts.value[key.id] = { account: key.accountStorageId || 'global', protected: !!key.protected }
    }
    status.value = next
    if (reset) settings.value = { ...next.settings }
  } catch (caught) { error.value = caught instanceof Error ? caught.message : '读取失败。' }
  finally { refreshing = false }
}
async function run(action: () => Promise<void>): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try { await action() } catch (caught) { error.value = caught instanceof Error ? caught.message : '操作失败。' }
  finally { busy.value = false; await refresh(false) }
}
async function save(force: boolean): Promise<void> {
  await run(async () => {
    await apiProxyRequest('/settings', { settings: settings.value, force })
    forceDialog.value = false
    await refresh(true)
  })
}
function openCreate(key?: ApiProxyKey): void {
  rotateTarget.value = key || null
  setPolicyDraft(key)
  keyNameDraft.value = key ? `${key.name}（新）` : 'Codex CLI'
  keyDurationDays.value = ''
  secret.value = ''
  createDialog.value = true
}
function closeCreate(): void {
  createDialog.value = false
  secret.value = ''
  rotateTarget.value = null
}
async function createKey(): Promise<void> {
  await run(async () => {
    const duration = String(keyDurationDays.value).trim()
    const days = Number(duration)
    const expiresAt = duration ? new Date(Date.now() + days * 86_400_000) : null
    if (duration && (!/^\d+$/.test(duration) || !Number.isSafeInteger(days) || days < 1 || !Number.isFinite(expiresAt?.getTime()))) {
      throw new Error('持续时间请填写正整数天数，留空为无限。')
    }
    const created = await apiProxyRequest<{ secret: string }>('/keys', {
      ...keyPolicy(),
      name: keyNameDraft.value,
      expiresAt: expiresAt?.toISOString() ?? null,
    })
    secret.value = created.secret
    if (rotateTarget.value) await apiProxyRequest(`/keys/${rotateTarget.value.id}`, { expiresAt: new Date(Date.now() + 86400_000).toISOString() })
  })
}
function setPolicyDraft(key?: ApiProxyKey): void {
  keyAccountDraft.value = key?.accountStorageId || 'global'
  keyProtectedDraft.value = key?.protected || false
}
function keyPolicy() { return { accountStorageId: keyAccountDraft.value === 'global' ? null : keyAccountDraft.value, protected: keyProtectedDraft.value } }
function openPolicy(key: ApiProxyKey): void {
  setPolicyDraft(key)
  policyTarget.value = key
}
async function savePolicy(): Promise<void> {
  if (!policyTarget.value) return
  await run(async () => {
    await apiProxyRequest(`/keys/${policyTarget.value!.id}`, keyPolicy())
    policyTarget.value = null
  })
}
async function copySecret(): Promise<void> { try { await copyTextToClipboard(secret.value) } catch { error.value = '当前浏览器无法自动复制，请选中 key 手动复制。' } }
async function updateKey(key: ApiProxyKey, input: unknown): Promise<void> { await run(async () => { await apiProxyRequest(`/keys/${key.id}`, input) }) }
async function revokeKey(): Promise<void> { const target = revokeTarget.value; if (!target) return; await run(async () => { await apiProxyRequest(`/keys/${target.id}`, { revoke: true, interrupt: interruptKey.value }); revokeTarget.value = null }) }
async function renameKey(): Promise<void> { const target = renameTarget.value; if (!target) return; await run(async () => { await apiProxyRequest(`/keys/${target.id}`, { name: renameValue.value }); renameTarget.value = null }) }
async function loadModels(): Promise<void> { await run(async () => { const result = await apiProxyRequest<{ id: string }[]>('/models'); models.value = result.map(item => item.id) }) }
onMounted(() => {
  void refresh(true)
  timer = setInterval(() => { if (!document.hidden && !busy.value) void refresh(false) }, 10_000)
})
onUnmounted(() => { disposed = true; if (timer) clearInterval(timer); secret.value = '' })
</script>
