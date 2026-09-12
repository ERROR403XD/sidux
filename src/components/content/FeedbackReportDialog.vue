<template>
  <AppDialog :open="feedbackReport !== null" :title="t('问题报告')" @close="feedbackReport = null">
    <p>{{ t('仅含版本、界面信息和错误类别，可补充复现步骤。') }}</p>
    <textarea v-model="reportText" class="app-input feedback-report-text" :aria-label="t('问题报告')" />
    <p v-if="copyState" role="status">{{ t(copyState) }}</p>
    <template #footer>
      <a :href="FEEDBACK_URL" target="_blank" rel="noopener noreferrer">{{ t('打开项目 Issues') }}</a>
      <AppButton @click="copyReport">{{ t('复制报告') }}</AppButton>
    </template>
  </AppDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppDialog from '../common/AppDialog.vue'
import AppButton from '../common/AppButton.vue'
import { feedbackReport, FEEDBACK_URL } from '../../composables/useFeedbackDiagnostics'
import { t } from '../../composables/useUiLanguage'
const reportText = computed({ get: () => feedbackReport.value ?? '', set: value => { feedbackReport.value = value } })
const copyState = ref('')
watch(feedbackReport, () => { copyState.value = '' })
async function copyReport(): Promise<void> {
  try {
    await navigator.clipboard.writeText(reportText.value)
    copyState.value = '已复制'
  } catch {
    copyState.value = '复制失败，请选中文本复制。'
  }
}
</script>

<style scoped>
.feedback-report-text { width: 100%; min-height: 260px; margin-top: 12px; font: 13px/1.6 monospace; }
</style>
