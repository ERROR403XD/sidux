<template>
  <div class="settings-about-versions">
    <div class="account-versions">
      <span>Codex {{ t(runtimeCapabilities?.cliVersion || '检测中…') }}</span>
      <span>Sidux {{ runtimeCapabilities?.appVersion || appVersion }}</span>
    </div>
    <p v-if="runtimeCapabilities && runtimeCapabilities.appVersion !== appVersion" role="alert">
      {{ t('前端版本') }} {{ appVersion }} {{ t('与服务端版本不同，请刷新页面。') }}
    </p>
  </div>
  <details class="runtime-capabilities">
    <summary>{{ t('运行版本与能力') }}</summary>
    <template v-if="runtimeCapabilities">
      <p>{{ t('模型：动态目录 · 工具：轻量摘要') }}</p>
      <p>{{ t('异步问题：已接入') }}</p>
      <p>{{ t('原生历史分页：') }}{{ t(runtimeCapabilities.features?.historyPaging ? '可用' : 'CLI 未声明，使用兼容路径') }}</p>
      <p>{{ t('协议') }} {{ t(runtimeCapabilities.experimental ? 'experimental' : '默认') }} · {{ runtimeCapabilities.schemaHash.slice(0, 12) }}</p>
      <p>{{ t('CLI 声明') }} {{ runtimeCapabilities.methods.length }} {{ t('个方法，声明数量不代表客户端支持率。') }}</p>
      <p>{{ t('检测时间') }} {{ runtimeCapabilities.generatedAt }}</p>
    </template>
    <p v-if="runtimeCapabilitiesError" role="alert">{{ t(runtimeCapabilitiesError) }}</p>
    <AppButton :busy="runtimeCapabilitiesLoading" @click="loadRuntimeCapabilities">{{ t('重新检测') }}</AppButton>
  </details>
</template>

<script setup lang="ts">
import AppButton from '../common/AppButton.vue'
import { useRuntimeCapabilities } from '../../composables/useRuntimeCapabilities'
import { useUiLanguage } from '../../composables/useUiLanguage'

const { t } = useUiLanguage()
const appVersion = import.meta.env.VITE_APP_VERSION ?? 'unknown'
const { runtimeCapabilities, runtimeCapabilitiesError, runtimeCapabilitiesLoading, loadRuntimeCapabilities } = useRuntimeCapabilities()
</script>
