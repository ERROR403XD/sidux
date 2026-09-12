<template>
  <section class="account-panel custom-connections">
    <header class="account-panel-header"><h3>{{ t('自定义连接') }} <small>{{ state.connections.length }}</small></h3><AppButton @click="open()">{{ t('添加账号') }}</AppButton></header>
    <p v-if="error && !dialog" class="account-panel-error" role="alert">{{ t(error) }}</p>
    <div class="account-panel-list">
      <article v-for="connection in state.connections" :key="connection.storageId" class="account-card" :class="{ 'is-active': state.activeId === connection.storageId }" :data-connection-id="connection.storageId">
        <div class="account-card-heading"><strong>{{ connection.alias }}</strong><span class="account-plan-badge">{{ connection.provider }}</span></div>
        <ConnectionEndpoints :endpoints="customConnectionEndpoints(connection)" />
        <footer class="account-card-actions"><AppButton @click="open(connection)">{{ t('账号设置') }}</AppButton><AppButton :disabled="busy || connection.wireApi !== 'responses' || state.activeId === connection.storageId" @click="select(connection.storageId)">{{ t(state.activeId === connection.storageId ? '当前使用' : '切换至此账号') }}</AppButton></footer>
      </article>
    </div>
    <AppDialog :open="dialog" :title="t(draft.storageId ? '账号设置' : '添加账号')" :busy="busy" panel-class="custom-connection-dialog" @close="dialog = false">
      <div class="custom-connection-form">
        <p v-if="error" class="account-panel-error" role="alert">{{ t(error) }}</p>
        <label>{{ t('别名') }}<input v-model="draft.alias" class="app-input" data-autofocus maxlength="80" :disabled="busy" /></label>
        <label>{{ t('提供方') }}<AppSelect :model-value="draft.provider" :options="customProviderPresets.map(row => ({ value: row.value, label: t(row.label) }))" :disabled="busy" @update:model-value="setProvider" /></label>
        <label class="custom-connection-wide">Base URL<input v-model="draft.baseUrl" class="app-input" type="url" placeholder="https://api.example.com/v1" :disabled="busy" /></label>
        <label class="custom-connection-wide">API key<input v-model="draft.apiKey" class="app-input" type="password" autocomplete="off" :placeholder="t(draft.storageId ? '留空保留现有密钥' : '输入 API key')" :disabled="busy" /></label>
        <label>{{ t('模型') }}<input v-model="draft.model" class="app-input" :placeholder="t('自动读取，或输入模型名')" :disabled="busy" /></label>
        <ConnectionEndpoints v-if="testedEndpoints.length" class="custom-connection-wide" :endpoints="testedEndpoints" />
        <p v-if="testToken" class="custom-connection-wide account-panel-notice" role="status">{{ t('连接成功') }}</p>
      </div>
      <template #footer>
        <AppButton class="custom-connection-test" :busy="busy" @click="test">{{ t('测试连接') }}</AppButton>
        <div class="custom-connection-footer-actions">
          <AppButton v-if="draft.storageId" variant="danger" :disabled="busy" @click="remove">{{ t(confirmRemove ? '确认移除' : '移除') }}</AppButton>
          <AppButton v-else :disabled="busy" @click="dialog = false">{{ t('取消') }}</AppButton>
          <AppButton :disabled="busy || !testToken" @click="save">{{ t('确定') }}</AppButton>
        </div>
      </template>
    </AppDialog>
  </section>
</template>
<script setup lang="ts">
import { notifyOperation } from '../../composables/useOperationToast'
import { onMounted, ref, watch } from 'vue'
import { t } from '../../composables/useUiLanguage'
import { useCustomConnections, customConnectionRequest } from '../../composables/useCustomConnections'
import { customConnectionEndpoints, type CustomEndpoint, customProviderPresets, type CustomConnection, type CustomConnectionDraft, type CustomConnectionSnapshot } from '../../customConnections'
import AppButton from '../common/AppButton.vue'
import AppDialog from '../common/AppDialog.vue'
import AppSelect from '../common/AppSelect.vue'
import ConnectionEndpoints from './ConnectionEndpoints.vue'
const emit = defineEmits<{ changed: [accountChanged: boolean] }>()
const { state, load } = useCustomConnections()
const dialog = ref(false)
const busy = ref(false)
const error = ref('')
const testToken = ref('')
const testedEndpoints = ref<CustomEndpoint[]>([])
const confirmRemove = ref(false)
const draft = ref<CustomConnectionDraft>({ alias: '', provider: 'openrouter', baseUrl: customProviderPresets[0]!.baseUrl, apiKey: '', model: '', wireApi: 'responses' })
watch(draft, () => { testToken.value = ''; testedEndpoints.value = []; confirmRemove.value = false }, { deep: true, flush: 'sync' })
function open(connection?: CustomConnection): void {
  draft.value = connection ? { storageId: connection.storageId, alias: connection.alias, provider: connection.provider, baseUrl: connection.baseUrl, apiKey: '', model: connection.model, wireApi: connection.wireApi } : { alias: '', provider: 'openrouter', baseUrl: customProviderPresets[0]!.baseUrl, apiKey: '', model: '', wireApi: 'responses' }
  testedEndpoints.value = connection ? customConnectionEndpoints(connection) : []
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
    const result = await customConnectionRequest<{ token: string; model: string; supportedEndpoints: CustomEndpoint[]; wireApi: 'responses' | 'chat' }>('/test', draft.value)
    draft.value.model = result.model
    draft.value.wireApi = result.wireApi
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
    notifyOperation('账号已切换', 'success')
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
