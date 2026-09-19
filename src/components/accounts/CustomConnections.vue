<template>
  <section class="account-panel custom-connections">
    <header class="account-panel-header"><h3>{{ t('自定义连接') }} <small>{{ state.connections.length }}</small></h3><AppButton @click="open()">{{ t('添加账号') }}</AppButton></header>
    <p v-if="error && !dialog" class="account-panel-error" role="alert">{{ t(error) }}</p>
    <div class="account-panel-list">
      <article v-for="connection in state.connections" :key="connection.storageId" class="account-card" :class="{ 'is-active': state.activeId === connection.storageId }" :data-connection-id="connection.storageId">
        <div class="account-card-heading"><strong>{{ connection.alias }}</strong><span class="account-plan-badge">{{ connection.provider }}</span></div>
        <ConnectionEndpoints :endpoints="customConnectionEndpoints(connection)" :bridged="customConnectionBridgedEndpoints(connection)" />
        <footer class="account-card-actions"><AppButton @click="open(connection)">{{ t('账号设置') }}</AppButton><AppButton :disabled="busy || (connection.wireApi === 'chat' && !connection.protocolBridge) || state.activeId === connection.storageId" :title="connection.wireApi === 'chat' && !connection.protocolBridge ? t('该连接仅支持 Chat Completions，可在账号设置中开启协议转换') : undefined" @click="select(connection.storageId)">{{ t(state.activeId === connection.storageId ? '当前使用' : '切换至此账号') }}</AppButton></footer>
      </article>
    </div>
    <AppDialog :open="dialog" :title="t(draft.storageId ? '账号设置' : '添加账号')" :busy="busy" panel-class="custom-connection-dialog" @close="dialog = false">
      <div class="custom-connection-form">
        <p v-if="error" class="account-panel-error" role="alert">{{ t(error) }}</p>
        <label>{{ t('别名') }}<input v-model="draft.alias" class="app-input" data-autofocus maxlength="80" :disabled="busy" /></label>
        <label>{{ t('提供方') }}<AppSelect :model-value="draft.provider" :options="customProviderPresets.map(row => ({ value: row.value, label: t(row.label) }))" :disabled="busy" @update:model-value="setProvider" /></label>
        <label class="custom-connection-wide">Base URL<input v-model="draft.baseUrl" class="app-input" type="url" placeholder="https://api.example.com/v1" :disabled="busy" /></label>
        <label class="custom-connection-wide">API key<input v-model="draft.apiKey" class="app-input" type="password" autocomplete="off" :placeholder="t(draft.storageId ? '留空保留现有密钥' : '输入 API key')" :disabled="busy" /></label>
        <div class="custom-connection-wide custom-connection-model-row" :class="{ 'is-single': !bridgeToggleAvailable }">
          <label>{{ t('模型') }}<input v-model="draft.model" class="app-input" :placeholder="t('自动读取，或输入模型名')" :disabled="busy" /></label>
          <div v-if="bridgeToggleAvailable" class="custom-connection-bridge">
            <AppSwitch v-model="draft.protocolBridge" :disabled="busy">{{ t('协议转换') }}</AppSwitch>
          </div>
        </div>
        <div class="custom-connection-wide custom-connection-efforts-row">
          <span class="custom-connection-efforts-label">{{ t('推理强度') }}</span>
          <div class="custom-connection-efforts-options" role="group" :aria-label="t('推理强度')">
            <button v-for="level in customReasoningEffortLevels" :key="level" type="button" class="custom-connection-effort" :aria-pressed="draft.reasoningEfforts?.includes(level) === true" :disabled="busy || reasoningSupport === 'rejected'" @click="toggleEffort(level)">{{ t(effortLevelLabels[level]) }}</button>
          </div>
          <ConnectionEndpoints v-if="testedEndpoints.length" class="custom-connection-endpoints-inline" :endpoints="testedEndpoints" :bridged="testedBridgeEndpoints" />
        </div>
        <p v-if="reasoningSupport === 'rejected'" class="custom-connection-wide custom-connection-efforts-warning" role="status">{{ t('探测到上游明确拒绝推理参数，推理强度已禁用。') }}</p>
        <p v-if="testToken" class="custom-connection-wide account-panel-notice" role="status">{{ t('连接成功') }}</p>
      </div>
      <template #footer>
        <AppButton class="custom-connection-test" :busy="busy" @click="test">{{ t('测试连接') }}</AppButton>
        <div class="custom-connection-footer-actions">
          <AppButton v-if="draft.storageId" variant="danger" :disabled="busy" @click="remove">{{ t(confirmRemove ? '确认移除' : '移除') }}</AppButton>
          <AppButton v-else :disabled="busy" @click="dialog = false">{{ t('取消') }}</AppButton>
          <AppButton :variant="hasChanges ? 'primary' : 'default'" :disabled="busy || !testToken" @click="save">{{ t('保存配置') }}</AppButton>
        </div>
      </template>
    </AppDialog>
  </section>
</template>
<script setup lang="ts">
import { notifyOperation } from '../../composables/useOperationToast'
import { computed, onMounted, ref, watch } from 'vue'
import { t } from '../../composables/useUiLanguage'
import { useCustomConnections, customConnectionRequest } from '../../composables/useCustomConnections'
import { customConnectionBridgedEndpoints, customConnectionEndpoints, customConnectionNativeEndpoints, customReasoningEffortLevels, type CustomEndpoint, customProviderPresets, type CustomConnection, type CustomConnectionDraft, type CustomConnectionSnapshot, type ReasoningEffortSupport } from '../../customConnections'
import AppButton from '../common/AppButton.vue'
import AppDialog from '../common/AppDialog.vue'
import AppSelect from '../common/AppSelect.vue'
import AppSwitch from '../common/AppSwitch.vue'
import ConnectionEndpoints from './ConnectionEndpoints.vue'
const emit = defineEmits<{ changed: [accountChanged: boolean] }>()
const { state, load } = useCustomConnections()
const dialog = ref(false)
const busy = ref(false)
const error = ref('')
const testToken = ref('')
const testedEndpoints = ref<CustomEndpoint[]>([])
const confirmRemove = ref(false)
const draft = ref<CustomConnectionDraft>({ alias: '', provider: 'openrouter', baseUrl: customProviderPresets[0]!.baseUrl, apiKey: '', model: '', wireApi: 'responses', protocolBridge: false, reasoningEfforts: [] })
const savedConfiguration = ref('')
const reasoningSupport = ref<ReasoningEffortSupport>('unknown')
const effortLevelLabels: Record<(typeof customReasoningEffortLevels)[number], string> = { minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高' }
function toggleEffort(level: (typeof customReasoningEffortLevels)[number]): void {
  const declared = draft.value.reasoningEfforts ?? []
  draft.value.reasoningEfforts = declared.includes(level) ? declared.filter(item => item !== level) : [...declared, level]
}
const hasChanges = computed(() => savedConfiguration.value !== JSON.stringify(draft.value))
// Only proof-relevant fields invalidate the test; the protocol bridge toggle
// must be savable without re-probing the provider. The sync flush keeps the
// clear-before-refill order when test() writes the resolved model back.
const proofSignature = computed(() => JSON.stringify([draft.value.storageId ?? '', draft.value.alias, draft.value.provider, draft.value.baseUrl, draft.value.apiKey, draft.value.model]))
watch(proofSignature, () => { testToken.value = ''; testedEndpoints.value = []; confirmRemove.value = false }, { flush: 'sync' })
const nativeEndpoints = computed<CustomEndpoint[]>(() => {
  if (testedEndpoints.value.length) return testedEndpoints.value
  return draft.value.storageId ? state.value.connections.find(row => row.storageId === draft.value.storageId)?.supportedEndpoints ?? [] : []
})
const bridgeToggleAvailable = computed(() => {
  const native = nativeEndpoints.value
  return native.length > 0 && (!native.includes('/v1/responses') || !native.includes('/v1/chat/completions'))
})
const testedBridgeEndpoints = computed(() => {
  if (!bridgeToggleAvailable.value || !draft.value.protocolBridge) return []
  return customConnectionBridgedEndpoints({ wireApi: draft.value.wireApi, protocolBridge: true, supportedEndpoints: nativeEndpoints.value })
})
function open(connection?: CustomConnection): void {
  draft.value = connection
    ? { storageId: connection.storageId, alias: connection.alias, provider: connection.provider, baseUrl: connection.baseUrl, apiKey: '', model: connection.model, wireApi: connection.wireApi, protocolBridge: connection.protocolBridge, reasoningEfforts: connection.reasoningEffortSupport === 'rejected' ? [] : [...(connection.reasoningEfforts ?? [])] }
    : { alias: '', provider: 'openrouter', baseUrl: customProviderPresets[0]!.baseUrl, apiKey: '', model: '', wireApi: 'responses', protocolBridge: false, reasoningEfforts: [] }
  reasoningSupport.value = connection?.reasoningEffortSupport ?? 'unknown'
  savedConfiguration.value = JSON.stringify(draft.value)
  testedEndpoints.value = connection ? customConnectionNativeEndpoints(connection) : []
  error.value = ''
  testToken.value = ''
  confirmRemove.value = false
  dialog.value = true
}
function setProvider(value: string): void {
  draft.value.provider = value
  draft.value.baseUrl = customProviderPresets.find(row => row.value === value)?.baseUrl || ''
  draft.value.model = ''
}
async function run(action: () => Promise<void>): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try { await action() } catch (cause) { notifyOperation(cause instanceof Error ? cause.message : '连接配置无效') }
  finally { busy.value = false }
}
async function test(): Promise<void> {
  await run(async () => {
    const result = await customConnectionRequest<{ token: string; model: string; supportedEndpoints: CustomEndpoint[]; wireApi: 'responses' | 'chat'; reasoningEffortSupport: ReasoningEffortSupport }>('/test', draft.value)
    draft.value.model = result.model
    draft.value.wireApi = result.wireApi
    reasoningSupport.value = result.reasoningEffortSupport
    if (result.reasoningEffortSupport === 'rejected') draft.value.reasoningEfforts = []
    testedEndpoints.value = result.supportedEndpoints
    testToken.value = result.token
    notifyOperation('连接测试成功', 'success')
  })
}
async function save(): Promise<void> {
  await run(async () => {
    const previousId = state.value.activeId
    state.value = await customConnectionRequest<CustomConnectionSnapshot>('', { ...draft.value, testToken: testToken.value })
    draft.value.apiKey = ''
    dialog.value = false
    emit('changed', previousId !== state.value.activeId)
    notifyOperation('连接已保存', 'success')
  })
}
async function select(storageId: string): Promise<void> {
  await run(async () => {
    const previousId = state.value.activeId
    state.value = await customConnectionRequest<CustomConnectionSnapshot>('/select', { storageId })
    emit('changed', previousId !== state.value.activeId)
    notifyOperation('连接已切换', 'success')
  })
}
async function remove(): Promise<void> {
  if (!confirmRemove.value) { confirmRemove.value = true; return }
  await run(async () => {
    const previousId = state.value.activeId
    state.value = await customConnectionRequest<CustomConnectionSnapshot>('/remove', { storageId: draft.value.storageId })
    notifyOperation('连接已移除', 'success')
    dialog.value = false
    emit('changed', previousId !== state.value.activeId)
  })
}
onMounted(() => { void load().catch(cause => { error.value = cause instanceof Error ? cause.message : '连接配置无效' }) })
</script>
