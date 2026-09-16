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
          <AppButton :variant="hasSettingsChanges ? 'primary' : 'default'" :busy="busy" @click="save(false)">{{ t('保存配置') }}</AppButton>
          <AppButton variant="danger" :disabled="busy" @click="forceDialog = true">{{ t('中断活动连接并保存配置…') }}</AppButton>
        </div>
      </section>
      <section class="api-proxy-card">
        <div class="api-proxy-heading api-proxy-key-heading">
          <h2>API key</h2>
          <div class="api-proxy-actions api-proxy-key-toolbar">
            <AppButton :disabled="busy" @click="openCreate()">{{ t('创建API key') }}</AppButton>
            <AppButton @click="showInvalid = !showInvalid">{{ t(showInvalid ? '返回生效 API key' : '查看失效 API key') }}</AppButton>
            <AppButton @click="usageDialog = true">{{ t('Token统计') }}</AppButton>
            <AppButton :variant="hasPolicyChanges ? 'primary' : 'default'" :busy="savingPolicies" @click="savePolicies">{{ t('保存配置') }}</AppButton>
          </div>
        </div>
        <p v-if="!status.keys.length">{{ t('尚未创建 API key。') }}</p>
        <p v-if="status.usage?.error" role="alert" class="api-proxy-error">{{ t(status.usage.error) }}</p>
        <div v-for="key in visibleKeys" :key="key.id" class="api-proxy-key-row" :data-key-id="key.id">
          <div class="api-proxy-key-copy">
            <div class="api-proxy-key-title">
              <strong>{{ key.name }}</strong><span>••••{{ key.suffix }}</span>
              <small v-if="!key.revokedAt">{{ t('到期：') }}{{ t(key.expiresAt ? date(key.expiresAt) : '无限') }}</small>
              <span v-if="showInvalid || !key.enabled">{{ t(keyLabel(key)) }}</span>
            </div>
            <small class="api-proxy-key-recent">{{ t('最近使用：') }}{{ date(key.lastUsedAt) }}</small>
            <div v-if="!key.revokedAt && policyDrafts[key.id]" class="api-proxy-inline-policy">
              <AppSelect
                class="api-proxy-key-account"
                :model-value="accountValue(policyDrafts[key.id]!)"
                :options="keyAccountOptions(policyDrafts[key.id]!)"
                enable-search
                :search-placeholder="t('搜索账号')"
                :disabled="busy || isKeyBusy(key.id)"
                @update:model-value="setAccountValue(policyDrafts[key.id]!, $event)"
              />
            </div>
          </div>
          <div v-if="!key.revokedAt" class="api-proxy-actions api-proxy-key-controls">
            <ConnectionEndpoints v-if="policyDrafts[key.id]" class="api-proxy-key-endpoints" :endpoints="keyEndpoints(policyDrafts[key.id]!)" :show-tooltips="false" />
            <AppSwitch :disabled="busy || isKeyBusy(key.id)" :model-value="key.enabled" @change="updateKey(key, { enabled: $event })">{{ t('启用') }}</AppSwitch>
            <AppButton :disabled="busy || isKeyBusy(key.id)" @click="openAdvanced(key)">{{ t('高级选项') }}</AppButton>
            <AppButton :disabled="busy || isKeyBusy(key.id)" @click="renameTarget = key; renameValue = key.name">{{ t('重命名') }}</AppButton>
            <AppButton :disabled="busy || isKeyBusy(key.id)" @click="openCreate(key)">{{ t('轮换') }}</AppButton>
            <AppButton variant="danger" :disabled="busy || isKeyBusy(key.id)" @click="revokeTarget = key; interruptKey = false">{{ t('撤销…') }}</AppButton>
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
        <label>{{ t('使用账号') }}<AppSelect class="api-proxy-key-account" :model-value="accountValue(createDraft)" :options="keyAccountOptions(createDraft)" enable-search :search-placeholder="t('搜索账号')" :disabled="busy" @update:model-value="setAccountValue(createDraft, $event)" /></label>
        <div class="api-proxy-actions api-proxy-advanced-open">
          <AppButton :disabled="busy" @click="openAdvanced()">{{ t('高级选项') }}</AppButton>
          <span v-if="advancedSummary(createDraft)" class="api-proxy-muted">{{ advancedSummary(createDraft) }}</span>
        </div>
        <p v-if="rotateTarget" class="api-proxy-muted">{{ t('旧 key 将于 24 小时后到期，也可提前撤销。') }}</p>
      </div>
      <template v-else><p>{{ t('请现在保存完整 key，关闭后不会再次显示。') }}</p><textarea class="app-input api-proxy-secret" :value="secret" readonly rows="3" :aria-label="t('新 API key')" /><AppButton @click="copySecret">{{ t('复制 key') }}</AppButton></template>
      <template #footer><AppButton :disabled="busy" @click="closeCreate">{{ t(secret ? '已保存，关闭' : '取消') }}</AppButton><AppButton v-if="!secret" :busy="busy" @click="createKey">{{ t('创建') }}</AppButton></template>
    </AppDialog>
    <AppDialog :open="!!revokeTarget" :title="t('撤销 API key')" :busy="busy" size="compact" @close="revokeTarget = null">
      <p>{{ t('撤销“') }}{{ revokeTarget?.name }}{{ t('”后无法重新启用。') }}</p><AppSwitch class="api-proxy-check" v-model="interruptKey">{{ t('同时中断这把 key 的活动连接（') }}{{ keyActivityCount }}）</AppSwitch>
      <template #footer><AppButton :disabled="busy" @click="revokeTarget = null">{{ t('取消') }}</AppButton><AppButton variant="danger" :busy="busy" @click="revokeKey">{{ t('撤销') }}</AppButton></template>
    </AppDialog>
    <AppDialog :open="advancedOpen" :title="t('高级选项')" :busy="busy" panel-class="api-proxy-advanced-dialog" @close="closeAdvanced()">
      <template v-if="advancedDraft">
        <AppSwitch class="api-proxy-check" v-model="advancedDraft.protected" :disabled="busy">{{ t('受保护') }}</AppSwitch>
        <p class="api-proxy-muted">{{ t('受保护表示允许这把 key 使用被保护的 OpenAI 账号额度。') }}</p>
        <div class="api-proxy-advanced-group">
          <AppSwitch class="api-proxy-check" v-model="advancedDraft.forceEnabled" :disabled="busy">{{ t('模型强制路由') }}</AppSwitch>
          <label v-if="advancedDraft.forceEnabled">{{ t('强制使用模型') }}<input v-model="advancedDraft.forceModel" class="app-input" maxlength="200" :placeholder="t('模型名')" :disabled="busy" /></label>
        </div>
        <div class="api-proxy-advanced-group">
          <AppSwitch class="api-proxy-check" v-model="advancedDraft.aggregateEnabled" :disabled="busy">{{ t('聚合路由') }}</AppSwitch>
          <p class="api-proxy-muted">{{ t('聚合路由按模型把请求分派到不同账号；开关打开后此 key 的模型列表就是下面清单的并集。') }}</p>
          <template v-if="advancedDraft.aggregateEnabled">
            <div v-for="(row, index) in advancedDraft.entries" :key="index" class="api-proxy-route-row">
              <input v-model="row.model" class="app-input" maxlength="200" :placeholder="t('模型名')" :aria-label="t('模型名')" :disabled="busy" />
              <AppSelect v-model="row.account" class="api-proxy-route-account" :options="routeAccountOptions" enable-search :search-placeholder="t('搜索账号')" :placeholder="t('选择账号')" :disabled="busy" />
              <AppButton variant="danger" :disabled="busy" @click="removeRouteRow(index)">{{ t('移除') }}</AppButton>
            </div>
            <AppButton :disabled="busy" @click="addRouteRow()">{{ t('添加一项') }}</AppButton>
          </template>
        </div>
      </template>
      <template #footer><AppButton :disabled="busy" @click="closeAdvanced()">{{ t('取消') }}</AppButton><AppButton variant="primary" :busy="busy" @click="confirmAdvanced()">{{ t('确认') }}</AppButton></template>
    </AppDialog>
    <AppDialog :open="!!renameTarget" :title="t('重命名 API key')" :busy="busy" size="compact" @close="renameTarget = null"><input v-model="renameValue" class="app-input" maxlength="80" data-autofocus /><template #footer><AppButton :busy="busy" @click="renameKey">{{ t('保存') }}</AppButton></template></AppDialog>
    <AppDialog :open="forceDialog" :title="t('中断活动连接并保存配置')" :busy="busy" size="compact" @close="forceDialog = false"><p>{{ t('将中断') }} {{ status?.activity.connections || 0 }} {{ t('个连接，其中') }} {{ status?.activity.activeRequests || 0 }} {{ t('个请求正在处理。客户端会收到中断，需要重新连接。') }}</p><template #footer><AppButton :disabled="busy" @click="forceDialog = false">{{ t('取消') }}</AppButton><AppButton variant="danger" :busy="busy" @click="save(true)">{{ t('中断并保存配置') }}</AppButton></template></AppDialog>
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
import ConnectionEndpoints from '../accounts/ConnectionEndpoints.vue'
import { formatLocalDateTime, displayTimeZone } from '../../dateTime'
import { emptyUsage } from '../../api/proxyUsageTypes'
import { copyTextToClipboard } from '../../utils/clipboard'
import { apiProxyRequest, visibleApiProxyKeys, type ApiProxyKey, type ApiProxySettings, type ApiProxyStatus } from '../../api/apiProxy'
import type { CustomEndpoint } from '../../customConnections'
import { notifyOperation } from '../../composables/useOperationToast'

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
type KeyRouteRow = { model: string; account: string }
type KeyPolicyDraft = {
  account: string
  protected: boolean
  forceEnabled: boolean
  forceModel: string
  aggregateEnabled: boolean
  entries: KeyRouteRow[]
}
const endpointOrder: CustomEndpoint[] = ['/v1/models', '/v1/responses', '/v1/chat/completions']
const policyDrafts = ref<Record<string, KeyPolicyDraft>>({})
const visibleKeys = computed(() => visibleApiProxyKeys(status.value?.keys || [], showInvalid.value))
const hasPolicyChanges = computed(() => pendingPolicyUpdates().length > 0)
function draftFromKey(key: ApiProxyKey): KeyPolicyDraft {
  return {
    account: key.accountStorageId || 'global',
    protected: !!key.protected,
    forceEnabled: !!key.forceRoute?.enabled,
    forceModel: key.forceRoute?.model || '',
    aggregateEnabled: !!key.aggregateRoute?.enabled,
    entries: (key.aggregateRoute?.entries || []).map(entry => ({ model: entry.model, account: entry.accountStorageId || 'global' })),
  }
}
function copyDraft(source: KeyPolicyDraft): KeyPolicyDraft {
  return { ...source, entries: source.entries.map(row => ({ ...row })) }
}
/** 聚合模式打开时主账号下拉框显示“聚合账号”，底层账号仍然保留作为清单外模型的兜底。 */
function accountValue(draft: KeyPolicyDraft): string { return draft.aggregateEnabled ? 'aggregate' : draft.account }
function setAccountValue(draft: KeyPolicyDraft, value: string): void {
  if (value === 'aggregate') { draft.aggregateEnabled = true; return }
  draft.aggregateEnabled = false
  draft.account = value
}
function routePayload(draft: KeyPolicyDraft): { accountStorageId: string | null; protected: boolean; forceRoute: { enabled: boolean; model: string }; aggregateRoute: { enabled: boolean; entries: Array<{ model: string; accountStorageId: string | null }> } } {
  return {
    accountStorageId: draft.account === 'global' || !draft.account ? null : draft.account,
    protected: draft.protected,
    forceRoute: { enabled: draft.forceEnabled, model: draft.forceModel.trim() },
    aggregateRoute: { enabled: draft.aggregateEnabled, entries: draft.entries.map(row => ({ model: row.model.trim(), accountStorageId: row.account === 'global' || !row.account ? null : row.account })) },
  }
}
function savedRouteSignature(key: ApiProxyKey): string {
  return JSON.stringify({
    forceRoute: { enabled: !!key.forceRoute?.enabled, model: key.forceRoute?.model || '' },
    aggregateRoute: { enabled: !!key.aggregateRoute?.enabled, entries: (key.aggregateRoute?.entries || []).map(entry => ({ model: entry.model, accountStorageId: entry.accountStorageId ?? null })) },
  })
}
function pendingPolicyUpdates(): Array<{ key: ApiProxyKey; payload: ReturnType<typeof routePayload> }> {
  const rows: Array<{ key: ApiProxyKey; payload: ReturnType<typeof routePayload> }> = []
  for (const key of status.value?.keys || []) {
    const draft = policyDrafts.value[key.id]
    if (!draft || key.revokedAt) continue
    const payload = routePayload(draft)
    if (payload.accountStorageId === (key.accountStorageId ?? null) && payload.protected === !!key.protected
      && JSON.stringify({ forceRoute: payload.forceRoute, aggregateRoute: payload.aggregateRoute }) === savedRouteSignature(key)) continue
    rows.push({ key, payload })
  }
  return rows
}
async function savePolicies(): Promise<void> {
  const rows = pendingPolicyUpdates()
  if (!rows.length) return
  savingPolicies.value = true
  try {
    await runKeys(rows.map(row => row.key.id), async () => {
      for (const row of rows) {
        await apiProxyRequest(`/keys/${row.key.id}`, row.payload)
      }
    })
  } finally { savingPolicies.value = false }
}
const status = ref<ApiProxyStatus | null>(null)
const settings = ref<ApiProxySettings>({ enabled: false, accountStorageId: null, globalConcurrency: 8, keyConcurrency: 4, drainTimeoutSeconds: 60 })
const busy = ref(false)
const busyKeyIds = ref<string[]>([])
const savingPolicies = ref(false)
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
const createDraft = ref<KeyPolicyDraft>(emptyDraft())
const advancedOpen = ref(false)
const advancedKey = ref<ApiProxyKey | null>(null)
const advancedDraft = ref<KeyPolicyDraft | null>(null)
function emptyDraft(): KeyPolicyDraft { return { account: 'global', protected: false, forceEnabled: false, forceModel: '', aggregateEnabled: false, entries: [] } }
function keyAccountOptions(draft: KeyPolicyDraft) {
  const options = [{ value: 'global', label: t('全局账号') }, ...accountOptions.value.filter(option => option.value !== 'follow')]
  // 聚合清单可用（每项都有模型和账号）时主账号下拉框才提供“聚合账号”；
  // 保留清单后切到普通账号仍能再切回聚合，避免“切走就回不去”。
  return aggregateTableReady(draft) ? [{ value: 'aggregate', label: t('聚合账号') }, ...options] : options
}
function aggregateTableReady(draft: KeyPolicyDraft): boolean {
  return draft.entries.length > 0 && draft.entries.every(row => !!row.model.trim() && !!row.account)
}
const routeAccountOptions = computed(() => [{ value: 'global', label: t('全局账号') }, ...accountOptions.value.filter(option => option.value !== 'follow')])
const usageWindow = ref<'cumulative' | 'today' | 'week'>('cumulative')
const usageWindows = [{ value: 'cumulative', label: '累计' }, { value: 'today', label: '今日' }, { value: 'week', label: '近 7 天' }]
function usageFor(id: string) { return status.value?.usage?.keys[id]?.[usageWindow.value] || emptyUsage() }
let timer: ReturnType<typeof setInterval> | undefined
let refreshing = false
let disposed = false
const selectedAccount = computed({ get: () => settings.value.accountStorageId || 'follow', set: value => { settings.value.accountStorageId = value === 'follow' ? null : value } })
const hasSettingsChanges = computed(() => {
  if (!status.value) return false
  return JSON.stringify(settings.value) !== JSON.stringify(status.value.settings)
})
const accountOptions = computed(() => [{ value: 'follow', label: t('跟随 WebUI 当前账号') }, ...(status.value?.accounts.accounts || []).map(account => ({ value: account.storageId, label: `${accountDisplayName(account)} · ${t(accountStatusLabel(account.authStatus))}` }))])
const baseUrl = `${window.location.origin}/v1`
const keyActivityCount = computed(() => status.value?.activity.entries.filter(entry => entry.keyId === revokeTarget.value?.id).length || 0)
const clientConfig = `model_provider = "sidux_gateway"\nmodel = "gpt-5.6-luna"\n\n[model_providers.sidux_gateway]\nname = "Sidux API"\nbase_url = "${baseUrl}"\nenv_key = "SIDUX_API_KEY"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = true`
function resolvedAccountId(id: string): string | null {
  return ['global', 'follow'].includes(id) ? settings.value.accountStorageId || status.value?.accounts.activeStorageId || null : id
}
/** 与账号卡片一致沿用 supportedEndpoints；普通 OpenAI 账号固定三端全量。 */
function accountEndpoints(id: string): CustomEndpoint[] {
  const account = status.value?.accounts.accounts.find(row => row.storageId === resolvedAccountId(id))
  if (!account || account.kind !== 'custom') return [...endpointOrder]
  return endpointOrder.filter(endpoint => (account.supportedEndpoints || []).includes(endpoint))
}
function keyEndpoints(draft: KeyPolicyDraft): CustomEndpoint[] {
  if (!draft.aggregateEnabled) return accountEndpoints(draft.account)
  const supported = new Set<CustomEndpoint>()
  for (const row of draft.entries) {
    if (!row.account) continue
    for (const endpoint of accountEndpoints(row.account)) supported.add(endpoint)
  }
  return endpointOrder.filter(endpoint => supported.has(endpoint))
}
function accountExists(id: string): boolean {
  return (status.value?.accounts.accounts || []).some(row => row.storageId === id)
}
function advancedSummary(draft: KeyPolicyDraft): string {
  const parts: string[] = []
  if (draft.protected) parts.push(t('受保护'))
  if (draft.forceEnabled) parts.push(`${t('强制路由：')}${draft.forceModel.trim() || t('未填写')}`)
  if (draft.aggregateEnabled) parts.push(`${t('聚合路由：')}${draft.entries.length}${t(' 项')}`)
  return parts.join(' · ')
}
/** 确认高级选项时集中校验路由；返回空表示可以应用。 */
function routeDraftError(draft: KeyPolicyDraft, name: string): string {
  if (draft.forceEnabled && !draft.forceModel.trim()) return t('强制路由必须填写模型名。')
  if (!draft.aggregateEnabled) return ''
  if (!draft.entries.length) return t('聚合路由至少需要一项。')
  const models = new Set<string>()
  for (const row of draft.entries) {
    const model = row.model.trim()
    if (!model) return t('聚合路由存在空模型。')
    if (models.has(model)) return `${t('聚合路由存在重复模型：')}${model}`
    models.add(model)
    if (!row.account) return t('聚合路由存在空账号。')
    if (row.account !== 'global' && !accountExists(row.account)) return t('聚合路由的账号已被删除或停用。')
  }
  if (draft.forceEnabled && !models.has(draft.forceModel.trim())) return `${name} ${t('路由配置错误：')}${t('强制路由的模型不在聚合路由清单内。')}`
  return ''
}
function addRouteRow(): void {
  if (!advancedDraft.value) return
  advancedDraft.value.entries.push({ model: '', account: 'global' })
}
function removeRouteRow(index: number): void {
  advancedDraft.value?.entries.splice(index, 1)
}
function openAdvanced(key?: ApiProxyKey): void {
  const source = key ? policyDrafts.value[key.id] : createDraft.value
  if (!source) return
  advancedKey.value = key ?? null
  advancedDraft.value = copyDraft(source)
  advancedOpen.value = true
}
function closeAdvanced(): void { advancedOpen.value = false; advancedDraft.value = null; advancedKey.value = null }
function confirmAdvanced(): void {
  const draft = advancedDraft.value
  if (!draft) return
  const name = advancedKey.value?.name || keyNameDraft.value.trim() || t('新 API key')
  const message = routeDraftError(draft, name)
  if (message) { notifyOperation(message, 'error'); return }
  if (advancedKey.value) policyDrafts.value[advancedKey.value.id] = copyDraft(draft)
  else createDraft.value = copyDraft(draft)
  closeAdvanced()
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
      if (!policyDrafts.value[key.id]) policyDrafts.value[key.id] = draftFromKey(key)
    }
    status.value = next
    if (reset) settings.value = { ...next.settings }
  } catch (caught) { error.value = caught instanceof Error ? caught.message : '读取失败。' }
  finally { refreshing = false }
}
async function run(action: () => Promise<void>): Promise<void> {
  if (busy.value || busyKeyIds.value.length) return
  busy.value = true
  error.value = ''
  try { await action() } catch (caught) { error.value = caught instanceof Error ? caught.message : '操作失败。' }
  finally { busy.value = false; await refresh(false) }
}
function isKeyBusy(id: string): boolean { return busyKeyIds.value.includes(id) }
// 只让涉及的行进入忙碌状态，避免整面板按钮一起禁用、抖出闪烁。
async function runKeys(ids: string[], action: () => Promise<void>): Promise<void> {
  if (busy.value || busyKeyIds.value.length) return
  busyKeyIds.value = [...ids]
  error.value = ''
  try { await action() } catch (caught) { error.value = caught instanceof Error ? caught.message : '操作失败。' }
  finally { busyKeyIds.value = []; await refresh(false) }
}
async function runKey(id: string, action: () => Promise<void>): Promise<void> { await runKeys([id], action) }
async function save(force: boolean): Promise<void> {
  await run(async () => {
    await apiProxyRequest('/settings', { settings: settings.value, force })
    forceDialog.value = false
    await refresh(true)
  })
}
function openCreate(key?: ApiProxyKey): void {
  rotateTarget.value = key || null
  createDraft.value = key ? draftFromKey(key) : emptyDraft()
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
      ...routePayload(createDraft.value),
      name: keyNameDraft.value,
      expiresAt: expiresAt?.toISOString() ?? null,
    })
    secret.value = created.secret
    if (rotateTarget.value) await apiProxyRequest(`/keys/${rotateTarget.value.id}`, { expiresAt: new Date(Date.now() + 86400_000).toISOString() })
  })
}
async function copySecret(): Promise<void> { try { await copyTextToClipboard(secret.value) } catch { error.value = '无法自动复制，请选中 key 手动复制。' } }
async function updateKey(key: ApiProxyKey, input: unknown): Promise<void> { await runKey(key.id, async () => { await apiProxyRequest(`/keys/${key.id}`, input) }) }
async function revokeKey(): Promise<void> { const target = revokeTarget.value; if (!target) return; await run(async () => { await apiProxyRequest(`/keys/${target.id}`, { revoke: true, interrupt: interruptKey.value }); revokeTarget.value = null }) }
async function renameKey(): Promise<void> { const target = renameTarget.value; if (!target) return; await run(async () => { await apiProxyRequest(`/keys/${target.id}`, { name: renameValue.value }); renameTarget.value = null }) }
onMounted(() => {
  void refresh(true)
  timer = setInterval(() => { if (!document.hidden && !busy.value && !busyKeyIds.value.length) void refresh(false) }, 10_000)
})
onUnmounted(() => { disposed = true; if (timer) clearInterval(timer); secret.value = '' })
</script>
