<template>
  <div class="api-proxy-panel" data-testid="api-proxy-panel">
    <p v-if="error" role="alert" class="api-proxy-error">{{ t(error) }}</p>
    <p v-if="!status">{{ t('正在读取出口状态…') }}</p>
    <template v-else>
      <section class="api-proxy-card">
        <div class="api-proxy-heading"><h2>{{ t('服务与账号') }}</h2></div>
        <p v-if="status.lastError" class="api-proxy-error">{{ t(status.lastError) }}</p>
        <p v-if="status.retryAt" class="api-proxy-muted">{{ t('下次可重试：') }}{{ date(status.retryAt) }}{{ t('；保持启用即可等待恢复。') }}</p>
        <AppSwitch class="api-proxy-check" v-model="settings.enabled"  :disabled="busy || !status.installed">{{ t('启用 API 出口') }}</AppSwitch>
        <div class="api-proxy-fields">
          <label>{{ t('API 使用账号') }} <AppSelect v-model="selectedAccount" :options="accountOptions" enable-search :search-placeholder="t('搜索账号')" :disabled="busy" />
          </label>
          <div><span class="api-proxy-label">{{ t('WebUI 当前账号') }}</span><p>{{ accountName(status.accounts.activeStorageId) }}</p></div>
          <label>{{ t('全局并发') }}<input v-model.number="settings.globalConcurrency" class="app-input" type="number" min="1" max="64" :disabled="busy" /></label>
          <label>{{ t('每把 key 并发') }}<input v-model.number="settings.keyConcurrency" class="app-input" type="number" min="1" max="32" :disabled="busy" /></label>
          <label>{{ t('等待请求结束的上限（秒）') }}<input v-model.number="settings.drainTimeoutSeconds" class="app-input" type="number" min="1" max="300" :disabled="busy" /></label>
        </div>
        <p class="api-proxy-muted">{{ t('当前实际 API 账号：') }}{{ status.settings.enabled ? accountName(status.selectedStorageId || status.settings.accountStorageId || status.accounts.activeStorageId) : t('未启用') }}</p>
        <p class="api-proxy-muted">{{ t('切换时等待当前请求结束。') }}</p>
        <div class="api-proxy-actions">
          <AppButton :busy="busy" @click="save(false)">{{ t('保存') }}</AppButton>
          <AppButton variant="danger" :disabled="busy" @click="forceDialog = true">{{ t('中断活动连接并保存…') }}</AppButton>
        </div>
      </section>
      <section class="api-proxy-card">
        <div class="api-proxy-heading api-proxy-key-heading">
          <h2>API key</h2>
          <div class="api-proxy-actions api-proxy-key-toolbar">
            <AppButton :disabled="busy" @click="openCreate()">{{ t('创建API key') }}</AppButton>
            <AppButton @click="showInvalid = !showInvalid">{{ t(showInvalid ? '返回生效 API key' : '查看失效 API key') }}</AppButton>
            <AppButton @click="usageDialog = true">{{ t('Token统计') }}</AppButton>
            <AppButton :busy="busy" @click="savePolicies">{{ t('保存配置') }}</AppButton>
          </div>
        </div>
        <p v-if="!status.keys.length">{{ t('尚未创建 API key。') }}</p>
        <p v-if="status.usage?.error" role="alert" class="api-proxy-error">{{ t(status.usage.error) }}</p>
        <div v-for="key in visibleKeys" :key="key.id" class="api-proxy-key-row">
          <div class="api-proxy-key-copy"><div class="api-proxy-key-title"><strong>{{ key.name }}</strong><span>••••{{ key.suffix }}</span><small>{{ t('到期：') }}{{ t(key.expiresAt ? date(key.expiresAt) : '无限') }}</small><span v-if="showInvalid">{{ t(keyLabel(key)) }}</span></div>
            <small>{{ t('最近使用：') }}{{ date(key.lastUsedAt) }}</small>
            <div v-if="policyDrafts[key.id]" class="api-proxy-inline-policy">
              <AppSelect v-model="policyDrafts[key.id]!.account" :options="keyAccountOptions" enable-search :search-placeholder="t('搜索账号')" :disabled="busy || !!key.revokedAt" />
              <span v-if="isCustomAccount(policyDrafts[key.id]!.account)" class="api-proxy-muted">{{ customEndpoints(policyDrafts[key.id]!.account).join(' · ') }}</span>
              <AppSwitch v-if="!isCustomAccount(policyDrafts[key.id]!.account)" class="api-proxy-check" v-model="policyDrafts[key.id]!.protected"  :disabled="busy || !!key.revokedAt">{{ t('受保护') }}</AppSwitch>
            </div>

          </div>
          <div class="api-proxy-actions">
            <AppButton :disabled="busy || !!key.revokedAt" @click="renameTarget = key; renameValue = key.name">{{ t('重命名') }}</AppButton>
            <AppSwitch :disabled="busy || !!key.revokedAt" :model-value="key.enabled" @change="updateKey(key, { enabled: $event })">{{ t('启用') }}</AppSwitch>
            <AppButton :disabled="busy || !!key.revokedAt" @click="openCreate(key)">{{ t('轮换') }}</AppButton>
            <AppButton variant="danger" :disabled="busy || !!key.revokedAt" @click="revokeTarget = key; interruptKey = false">{{ t('撤销…') }}</AppButton>
          </div>
        </div>
      </section>
      <section class="api-proxy-card">
        <div class="api-proxy-heading"><h2>{{ t('用例') }}</h2></div>
        <label>Base URL<input class="app-input" :value="baseUrl" readonly /></label>
        <pre class="api-proxy-config">{{ clientConfig }}</pre>
        <p class="api-proxy-muted api-proxy-endpoints">{{ t('支持端点：') }}<code>/v1/responses</code>（HTTP / SSE / WebSocket）、<code>/v1/responses/compact</code>、<code>/v1/models</code>、<code>/v1/chat/completions</code>。</p>
      </section>
      <section class="api-proxy-card">
        <div class="api-proxy-heading"><h2>{{ t('活动连接') }}</h2><AppButton :disabled="busy" @click="refresh(false)">{{ t('刷新') }}</AppButton></div>
        <p>{{ t('正在处理') }} {{ status.activity.activeRequests }} {{ t('· 连接') }} {{ status.activity.connections }} {{ t('· 空闲 WebSocket') }} {{ status.activity.idleWebSockets }}</p>
        <div class="api-proxy-table-wrap"><table><thead><tr><th>key</th><th>{{ t('传输') }}</th><th>{{ t('模型') }}</th><th>{{ t('开始时间') }}</th><th>{{ t('状态') }}</th></tr></thead><tbody>
          <tr v-for="entry in status.activity.entries" :key="entry.id"><td>{{ keyName(entry.keyId) }}</td><td>{{ entry.transport }}</td><td>{{ entry.model || '—' }}</td><td>{{ date(entry.startedAt) }}</td><td>{{ entry.status }}</td></tr>
          <tr v-if="!status.activity.entries.length"><td colspan="5">{{ t('当前没有活动连接。') }}</td></tr>
        </tbody></table></div>
        <details v-if="status.activity.recent.length"><summary>{{ t('近期请求（本次运行）') }}</summary><div class="api-proxy-table-wrap"><table><tbody>
          <tr v-for="entry in status.activity.recent.slice(0, 30)" :key="entry.id"><td>{{ keyName(entry.keyId) }}</td><td>{{ entry.transport }}</td><td>{{ entry.model || '—' }}</td><td>{{ date(entry.startedAt) }}</td><td>{{ entry.status }}</td></tr>
        </tbody></table></div></details>
      </section>
      <p class="api-proxy-muted">CLIProxyAPI {{ status.componentVersion }}</p>
    </template>
    <AppDialog :open="usageDialog" :title="t('Token统计')" panel-class="api-proxy-usage-dialog" @close="usageDialog = false">
      <div class="api-proxy-usage-filters">
        <label>{{ t('统计周期') }}<AppSelect v-model="usageWindow" :options="usageWindows.map(option => ({ ...option, label: t(option.label) }))" /></label>
        <label>API key<AppSelect v-model="usageKey" :options="usageKeyOptions" enable-search :search-placeholder="t('搜索 API key')" /></label>
      </div>
      <p v-if="status?.usage?.error" class="api-proxy-error" role="alert">{{ t(status.usage.error) }}</p>
      <div class="api-proxy-usage-total"><span>{{ t('总 Token') }}</span><strong>{{ selectedUsage.total.toLocaleString() }}</strong></div>
      <div class="api-proxy-usage-grid">
        <div><span>{{ t('输入') }}</span><strong>{{ selectedUsage.input.toLocaleString() }}</strong></div>
        <div><span>{{ t('输出') }}</span><strong>{{ selectedUsage.output.toLocaleString() }}</strong></div>
        <div><span>{{ t('缓存输入') }}</span><strong>{{ selectedUsage.cached.toLocaleString() }}</strong></div>
        <div><span>{{ t('推理') }}</span><strong>{{ selectedUsage.reasoning.toLocaleString() }}</strong></div>
      </div>
      <div class="api-proxy-usage-requests"><span>{{ t('请求') }} <b>{{ selectedUsage.requests }}</b></span><span>{{ t('成功') }} <b>{{ selectedUsage.completed }}</b></span><span>{{ t('失败') }} <b>{{ selectedUsage.failed }}</b></span><span>{{ t('中断') }} <b>{{ selectedUsage.interrupted }}</b></span><span>{{ t('拒绝') }} <b>{{ selectedUsage.rejected }}</b></span><span>{{ t('用量缺失') }} <b>{{ selectedUsage.unknown }}</b></span></div>
    </AppDialog>
    <AppDialog :open="createDialog" :title="t(rotateTarget ? '轮换 API key' : '创建 API key')" :busy="busy" panel-class="api-proxy-key-dialog" @close="closeCreate">
      <p v-if="error" role="alert" class="api-proxy-error">{{ t(error) }}</p>
      <div v-if="!secret" class="api-proxy-key-form">
        <label>{{ t('名称') }} <input v-model="keyNameDraft" class="app-input" data-autofocus maxlength="80" :disabled="busy" />
        </label>
        <label>{{ t('持续时间（天）') }} <input v-model="keyDurationDays" class="app-input" type="number" min="1" step="1" :placeholder="t('无限')" :disabled="busy" />
        </label>
        <label>{{ t('使用账号') }}<AppSelect v-model="keyAccountDraft" :options="keyAccountOptions" enable-search :search-placeholder="t('搜索账号')" :disabled="busy" /></label>
        <p v-if="isCustomAccount(keyAccountDraft)" class="api-proxy-muted">{{ customEndpoints(keyAccountDraft).join(' · ') }}</p>
        <AppSwitch v-if="!isCustomAccount(keyAccountDraft)" class="api-proxy-check" v-model="keyProtectedDraft"  :disabled="busy">{{ t('受保护') }}</AppSwitch>
        <p v-if="rotateTarget" class="api-proxy-muted">{{ t('旧 key 将于 24 小时后到期，也可提前撤销。') }}</p>
      </div>
      <template v-else><p>{{ t('请现在保存完整 key，关闭后不会再次显示。') }}</p><textarea class="app-input api-proxy-secret" :value="secret" readonly rows="3" :aria-label="t('新 API key')" /><AppButton @click="copySecret">{{ t('复制 key') }}</AppButton></template>
      <template #footer><AppButton :disabled="busy" @click="closeCreate">{{ t(secret ? '已保存，关闭' : '取消') }}</AppButton><AppButton v-if="!secret" :busy="busy" @click="createKey">{{ t('创建') }}</AppButton></template>
    </AppDialog>
    <AppDialog :open="!!revokeTarget" :title="t('撤销 API key')" :busy="busy" size="compact" @close="revokeTarget = null">
      <p>{{ t('撤销“') }}{{ revokeTarget?.name }}{{ t('”后无法重新启用。') }}</p><AppSwitch class="api-proxy-check" v-model="interruptKey">{{ t('同时中断这把 key 的活动连接（') }}{{ keyActivityCount }}）</AppSwitch>
      <template #footer><AppButton :disabled="busy" @click="revokeTarget = null">{{ t('取消') }}</AppButton><AppButton variant="danger" :busy="busy" @click="revokeKey">{{ t('撤销') }}</AppButton></template>
    </AppDialog>
    <AppDialog :open="!!policyTarget" :title="t('账号与额度保护')" :busy="busy" size="compact" @close="policyTarget = null">
      <p v-if="error" class="api-proxy-error" role="alert">{{ t(error) }}</p>
      <label>{{ t('使用账号') }}<AppSelect v-model="keyAccountDraft" :options="keyAccountOptions" enable-search :search-placeholder="t('搜索账号')" :disabled="busy" /></label>
      <p v-if="isCustomAccount(keyAccountDraft)" class="api-proxy-muted">{{ customEndpoints(keyAccountDraft).join(' · ') }}</p>
        <AppSwitch v-if="!isCustomAccount(keyAccountDraft)" class="api-proxy-check" v-model="keyProtectedDraft"  :disabled="busy">{{ t('受保护') }}</AppSwitch>
      <p class="api-proxy-muted">{{ t('保护值在账号设置中配置，受保护Key共享所选账号的预留额度。保存会断开此Key的旧连接。') }}</p>
      <template #footer><AppButton :disabled="busy" @click="policyTarget = null">{{ t('取消') }}</AppButton><AppButton :busy="busy" @click="savePolicy">{{ t('保存') }}</AppButton></template>
    </AppDialog>
    <AppDialog :open="!!renameTarget" :title="t('重命名 API key')" :busy="busy" size="compact" @close="renameTarget = null"><input v-model="renameValue" class="app-input" maxlength="80" data-autofocus /><template #footer><AppButton :busy="busy" @click="renameKey">{{ t('保存') }}</AppButton></template></AppDialog>
    <AppDialog :open="forceDialog" :title="t('中断活动连接并保存')" :busy="busy" size="compact" @close="forceDialog = false"><p>{{ t('将中断') }} {{ status?.activity.connections || 0 }} {{ t('个连接，其中') }} {{ status?.activity.activeRequests || 0 }} {{ t('个请求正在处理。客户端会收到中断，需要重新连接。') }}</p><template #footer><AppButton :disabled="busy" @click="forceDialog = false">{{ t('取消') }}</AppButton><AppButton variant="danger" :busy="busy" @click="save(true)">{{ t('中断并保存') }}</AppButton></template></AppDialog>
  </div>
</template>

<script setup lang="ts">
import AppSwitch from '../common/AppSwitch.vue'
import { t } from '../../composables/useUiLanguage'

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
const usageKeyOptions = computed(() => [{ value: 'all', label: t('全部 API key') }, ...(status.value?.keys || []).map(key => ({ value: key.id, label: `${key.name} · ••••${key.suffix}${key.revokedAt ? ` · ${t('已失效')}` : ''}` }))])
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
const keyAccountOptions = computed(() => [{ value: 'global', label: t('全局账号') }, ...accountOptions.value.filter(option => option.value !== 'follow')])
const usageWindow = ref<'cumulative' | 'today' | 'week'>('cumulative')
const usageWindows = [{ value: 'cumulative', label: '累计' }, { value: 'today', label: '今日' }, { value: 'week', label: '近 7 天' }]
function usageFor(id: string) { return status.value?.usage?.keys[id]?.[usageWindow.value] || emptyUsage() }
let timer: ReturnType<typeof setInterval> | undefined
let refreshing = false
let disposed = false
const selectedAccount = computed({ get: () => settings.value.accountStorageId || 'follow', set: value => { settings.value.accountStorageId = value === 'follow' ? null : value } })
const accountOptions = computed(() => [{ value: 'follow', label: t('跟随 WebUI 当前账号') }, ...(status.value?.accounts.accounts || []).map(account => ({ value: account.storageId, label: `${accountDisplayName(account)} · ${t(accountStatusLabel(account.authStatus))}` }))])
const baseUrl = `${window.location.origin}/v1`
const keyActivityCount = computed(() => status.value?.activity.entries.filter(entry => entry.keyId === revokeTarget.value?.id).length || 0)
const clientConfig = `model_provider = "codexapp_gateway"\nmodel = "gpt-5.6-luna"\n\n[model_providers.codexapp_gateway]\nname = "CodexApp API"\nbase_url = "${baseUrl}"\nenv_key = "CODEXAPP_API_KEY"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = true`
function customEndpoints(id: string): string[] {
  const resolved = ['global', 'follow'].includes(id) ? settings.value.accountStorageId || status.value?.accounts.activeStorageId : id
  return status.value?.accounts.accounts.find(row => row.storageId === resolved)?.supportedEndpoints || []
}
function isCustomAccount(id: string): boolean {
  const resolved = ['global', 'follow'].includes(id) ? settings.value.accountStorageId || status.value?.accounts.activeStorageId : id
  return status.value?.accounts.accounts.find(row => row.storageId === resolved)?.kind === 'custom'
}
function accountStatusLabel(value: string): string { return ({ ready: '可用', stale: '待确认', refreshing: '刷新中', reauth_required: '需重新登录', payment_required: '需处理额度', transient_error: '暂时异常', materialization_dirty: '需修复认证' } as Record<string, string>)[value] || value }
function date(value: string | null): string { return value ? formatLocalDateTime(value, { second: '2-digit' }) : '—' }
function accountName(id: string | null): string { const account = status.value?.accounts.accounts.find(row => row.storageId === id); return account ? accountDisplayName(account) : t('未选择') }
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
async function copySecret(): Promise<void> { try { await copyTextToClipboard(secret.value) } catch { error.value = '无法自动复制，请选中 key 手动复制。' } }
async function updateKey(key: ApiProxyKey, input: unknown): Promise<void> { await run(async () => { await apiProxyRequest(`/keys/${key.id}`, input) }) }
async function revokeKey(): Promise<void> { const target = revokeTarget.value; if (!target) return; await run(async () => { await apiProxyRequest(`/keys/${target.id}`, { revoke: true, interrupt: interruptKey.value }); revokeTarget.value = null }) }
async function renameKey(): Promise<void> { const target = renameTarget.value; if (!target) return; await run(async () => { await apiProxyRequest(`/keys/${target.id}`, { name: renameValue.value }); renameTarget.value = null }) }
onMounted(() => {
  void refresh(true)
  timer = setInterval(() => { if (!document.hidden && !busy.value) void refresh(false) }, 10_000)
})
onUnmounted(() => { disposed = true; if (timer) clearInterval(timer); secret.value = '' })
</script>
