<template>
  <div class="api-proxy-panel" data-testid="api-proxy-panel">
    <p class="api-proxy-intro">使用账号池为外部 Codex 客户端提供 API 接入。</p>
    <p v-if="error" role="alert" class="api-proxy-error">{{ error }}</p>
    <p v-if="!status">正在读取出口状态…</p>
    <template v-else>
      <section class="api-proxy-card">
        <div class="api-proxy-heading"><h2>服务与账号</h2><span class="api-proxy-state">{{ stateLabel }}</span></div>
        <p v-if="status.lastError" class="api-proxy-error">{{ status.lastError }}</p>
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
        <div class="api-proxy-heading"><h2>API key</h2><AppButton :disabled="busy" @click="openCreate()">创建 key</AppButton></div>
        <p class="api-proxy-muted">完整 key 仅创建时显示一次。撤销后立即阻止新请求，已经开始的响应默认继续完成。</p>
        <p v-if="!status.keys.length">尚未创建 API key。</p>
        <div v-for="key in status.keys" :key="key.id" class="api-proxy-key-row">
          <div class="api-proxy-key-copy"><strong>{{ key.name }}</strong><span>••••{{ key.suffix }} · {{ keyLabel(key) }}</span><small>到期：{{ date(key.expiresAt) }} · 最近使用：{{ date(key.lastUsedAt) }}</small></div>
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
    <AppDialog :open="createDialog" :title="rotateTarget ? '轮换 API key' : '创建 API key'" :busy="busy" size="compact" @close="closeCreate">
      <p v-if="error" role="alert" class="api-proxy-error">{{ error }}</p>
      <template v-if="!secret"><label>名称<input v-model="keyNameDraft" class="app-input" data-autofocus maxlength="80" /></label><label>到期时间（可留空）<input v-model="keyExpiry" class="app-input" type="datetime-local" /></label><p v-if="rotateTarget">创建成功后，旧 key 将于 24 小时后到期；也可手动提前撤销。</p></template>
      <template v-else><p>请现在保存完整 key，关闭后不会再次显示。</p><textarea class="app-input api-proxy-secret" :value="secret" readonly rows="3" aria-label="新 API key" /><AppButton @click="copySecret">复制 key</AppButton></template>
      <template #footer><AppButton :disabled="busy" @click="closeCreate">{{ secret ? '已保存，关闭' : '取消' }}</AppButton><AppButton v-if="!secret" :busy="busy" @click="createKey">创建</AppButton></template>
    </AppDialog>
    <AppDialog :open="!!revokeTarget" title="撤销 API key" :busy="busy" size="compact" @close="revokeTarget = null">
      <p>撤销“{{ revokeTarget?.name }}”后无法重新启用。</p><label class="api-proxy-check"><input v-model="interruptKey" type="checkbox" />同时中断这把 key 的活动连接（{{ keyActivityCount }}）</label>
      <template #footer><AppButton :disabled="busy" @click="revokeTarget = null">取消</AppButton><AppButton variant="danger" :busy="busy" @click="revokeKey">撤销</AppButton></template>
    </AppDialog>
    <AppDialog :open="!!renameTarget" title="重命名 API key" :busy="busy" size="compact" @close="renameTarget = null"><input v-model="renameValue" class="app-input" maxlength="80" data-autofocus /><template #footer><AppButton :busy="busy" @click="renameKey">保存</AppButton></template></AppDialog>
    <AppDialog :open="forceDialog" title="中断活动连接并保存" :busy="busy" size="compact" @close="forceDialog = false"><p>将中断 {{ status?.activity.connections || 0 }} 个连接，其中 {{ status?.activity.activeRequests || 0 }} 个请求正在处理。客户端会收到中断，需要重新连接。</p><template #footer><AppButton :disabled="busy" @click="forceDialog = false">取消</AppButton><AppButton variant="danger" :busy="busy" @click="save(true)">中断并保存</AppButton></template></AppDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import AppButton from '../common/AppButton.vue'
import AppDialog from '../common/AppDialog.vue'
import AppSelect from '../common/AppSelect.vue'
import { apiProxyRequest, type ApiProxyKey, type ApiProxySettings, type ApiProxyStatus } from '../../api/apiProxy'

const status = ref<ApiProxyStatus | null>(null)
const settings = ref<ApiProxySettings>({ enabled: false, accountStorageId: null, globalConcurrency: 8, keyConcurrency: 4, drainTimeoutSeconds: 60 })
const busy = ref(false)
const error = ref('')
const createDialog = ref(false)
const forceDialog = ref(false)
const secret = ref('')
const keyNameDraft = ref('Codex CLI')
const keyExpiry = ref('')
const rotateTarget = ref<ApiProxyKey | null>(null)
const revokeTarget = ref<ApiProxyKey | null>(null)
const renameTarget = ref<ApiProxyKey | null>(null)
const renameValue = ref('')
const interruptKey = ref(false)
const model = ref('gpt-5.6-luna')
const models = ref<string[]>([])
let timer: ReturnType<typeof setInterval> | undefined
let refreshing = false
let disposed = false
const selectedAccount = computed({ get: () => settings.value.accountStorageId || 'follow', set: value => { settings.value.accountStorageId = value === 'follow' ? null : value } })
const accountOptions = computed(() => [{ value: 'follow', label: '跟随 WebUI 当前账号' }, ...(status.value?.accounts.accounts || []).map(account => ({ value: account.storageId, label: `${account.email || account.accountId} · ${accountStatusLabel(account.authStatus)}` }))])
const modelOptions = computed(() => [...new Set([model.value, ...models.value])].map(value => ({ value, label: value })))
const baseUrl = `${window.location.origin}/v1`
const stateLabel = computed(() => !status.value?.installed ? '组件未安装' : status.value.activity.draining ? '等待活动请求结束' : !status.value.settings.enabled ? '未启用' : status.value.ready ? '可用' : status.value.lastError ? '异常' : '按需启动')
const keyActivityCount = computed(() => status.value?.activity.entries.filter(entry => entry.keyId === revokeTarget.value?.id).length || 0)
const clientConfig = computed(() => `model_provider = "codexapp_gateway"\nmodel = "${model.value}"\n\n[model_providers.codexapp_gateway]\nname = "CodexApp API"\nbase_url = "${baseUrl}"\nenv_key = "CODEXAPP_API_KEY"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = true`)
function accountStatusLabel(value: string): string { return ({ ready: '可用', stale: '待确认', refreshing: '刷新中', reauth_required: '需重新登录', payment_required: '需处理额度', transient_error: '暂时异常', materialization_dirty: '需修复认证' } as Record<string, string>)[value] || value }
function date(value: string | null): string { return value ? new Date(value).toLocaleString() : '—' }
function accountName(id: string | null): string { const account = status.value?.accounts.accounts.find(row => row.storageId === id); return account?.email || account?.accountId || '未选择' }
function keyName(id: string): string { return status.value?.keys.find(key => key.id === id)?.name || id.slice(0, 8) }
function keyLabel(key: ApiProxyKey): string { return key.revokedAt ? '已撤销' : key.expiresAt && Date.parse(key.expiresAt) <= Date.now() ? '已到期' : key.enabled ? '可用' : '已停用' }
async function refresh(reset = false): Promise<void> {
  if (refreshing || disposed) return
  refreshing = true
  try {
    const next = await apiProxyRequest<ApiProxyStatus>('/status')
    if (disposed) return
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
  keyNameDraft.value = key ? `${key.name}（新）` : 'Codex CLI'
  keyExpiry.value = ''
  secret.value = ''
  createDialog.value = true
}
function closeCreate(): void { createDialog.value = false; secret.value = ''; rotateTarget.value = null }
async function createKey(): Promise<void> {
  await run(async () => {
    const created = await apiProxyRequest<{ secret: string }>('/keys', { name: keyNameDraft.value, expiresAt: keyExpiry.value ? new Date(keyExpiry.value).toISOString() : null })
    secret.value = created.secret
    if (rotateTarget.value) await apiProxyRequest(`/keys/${rotateTarget.value.id}`, { expiresAt: new Date(Date.now() + 86400_000).toISOString() })
  })
}
async function copySecret(): Promise<void> { try { await navigator.clipboard.writeText(secret.value) } catch { error.value = '当前浏览器无法自动复制，请选中 key 手动复制。' } }
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
