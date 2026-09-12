<template>
  <div class="webui-branding-settings settings-form-subgrid">
    <div class="sidebar-settings-row sidebar-settings-row--select settings-field-roomy">
      <label for="webui-title">{{ t('WebUI标题') }}</label>
      <input id="webui-title" v-model="title" class="app-input" placeholder="Codex Web" maxlength="120" :disabled="busy || convertingLogo" @change="save({ title })" />
    </div>
    <div class="sidebar-settings-row sidebar-settings-row--select settings-field-roomy">
      <span>{{ t('标题显示') }}</span>
      <AppSelect :model-value="branding.titleMode" :options="titleOptions" :aria-label="t('标题显示')" :disabled="busy || convertingLogo" @update:model-value="save({ titleMode: $event })" />
    </div>
    <div class="sidebar-settings-row sidebar-settings-row--select settings-field-wide">
      <span class="sidebar-settings-label">{{ t('WebUI Logo') }}</span>
      <div class="webui-logo-actions">
        <img :src="webUiIconUrl(64, branding.logoVersion)" alt="" />
        <AppButton :busy="busy || convertingLogo" @click="fileInput?.click()">{{ t('上传Logo') }}</AppButton>
        <AppButton v-if="branding.logoVersion" :disabled="busy || convertingLogo" @click="save({ icons: null })">{{ t('移除') }}</AppButton>
      </div>
      <input ref="fileInput" class="visually-hidden" type="file" accept=".svg,.png,.ico,image/svg+xml,image/png,image/x-icon,image/vnd.microsoft.icon" :aria-label="t('上传Logo')" @change="uploadLogo" />
    </div>
    <p v-if="error" class="account-panel-error settings-field-wide" role="alert">{{ t(error) }}</p>
  </div>
</template>
<script setup lang="ts">
import { notifyOperation } from '../../composables/useOperationToast'
import { computed, ref, watch } from 'vue'
import AppButton from '../common/AppButton.vue'
import AppSelect from '../common/AppSelect.vue'
import { t } from '../../composables/useUiLanguage'
import { useWebUiBranding } from '../../composables/useWebUiBranding'
import { webUiIconSizes, webUiIconUrl } from '../../webUiBranding'
const { branding, applyWebUiBranding } = useWebUiBranding()
const title = ref(branding.value.title)
const busy = ref(false)
const convertingLogo = ref(false)
const error = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
const titleOptions = computed(() => [{ value: 'fixed', label: t('固定标题') }, { value: 'prefix', label: t('会话标题前缀') }])
watch(() => branding.value.title, value => { title.value = value })
async function save(input: Record<string, unknown>): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const response = await fetch('/codex-api/webui-branding', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.error || '保存失败')
    applyWebUiBranding(payload.data)
  } catch (cause) { notifyOperation(cause instanceof Error ? cause.message : '保存失败') }
  finally { busy.value = false }
}
async function uploadLogo(): Promise<void> {
  if (busy.value || convertingLogo.value) return
  const file = fileInput.value?.files?.[0]
  if (!file) return
  error.value = ''
  convertingLogo.value = true
  let url = ''
  try {
    if (!/\.(svg|png|ico)$/i.test(file.name)) throw new Error('请选择SVG、PNG或ICO文件')
    if (file.size > 5 * 1024 * 1024) throw new Error('Logo文件不得超过5MB')
    url = URL.createObjectURL(file)
    const image = new Image()
    image.src = url
    await image.decode()
    const icons: Record<string, string> = {}
    for (const name of [...webUiIconSizes.map(size => `icon-${size}`), 'maskable-512']) {
      const size = Number(name.split('-')[1])
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const context = canvas.getContext('2d')!
      const maskable = name.startsWith('maskable')
      if (maskable) { context.fillStyle = '#ffffff'; context.fillRect(0, 0, size, size) }
      const scale = (maskable ? 0.7 : 1) * size / Math.max(image.naturalWidth, image.naturalHeight)
      const width = image.naturalWidth * scale
      const height = image.naturalHeight * scale
      context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height)
      icons[name] = canvas.toDataURL('image/png').split(',')[1]!
    }
    await save({ icons })
  } catch (cause) { notifyOperation(cause instanceof Error ? cause.message : '无法读取Logo') }
  finally {
    convertingLogo.value = false
    if (url) URL.revokeObjectURL(url)
    if (fileInput.value) fileInput.value.value = ''
  }
}
</script>
