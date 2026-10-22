import { computed, ref } from 'vue'
import { notifyOperation } from './useOperationToast'
import { availableDisplayTimeZones, browserTimeZone, displayTimeZonePreference, setDisplayTimeZone } from '../dateTime'
import { useUiLanguage } from './useUiLanguage'

const error = ref('')
const isSaving = ref(false)

export function useDisplayTimeZoneSettings() {
  const { t } = useUiLanguage()
  const options = computed(() => [
    { value: 'system', label: `${t('Follow system')} · ${browserTimeZone()}` },
    ...availableDisplayTimeZones().map(zone => ({ value: zone, label: zone })),
  ])

  async function onChange(value: string): Promise<void> {
    if (isSaving.value || value === displayTimeZonePreference.value) return
    isSaving.value = true
    error.value = ''
    try {
      const currentResponse = await fetch('/codex-api/api-proxy/activation')
      const current = await currentResponse.json()
      if (!currentResponse.ok) throw new Error(current.error?.message || '读取激活计划失败')
      const response = await fetch('/codex-api/api-proxy/activation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...current.data.settings, timezone: value === 'system' ? browserTimeZone() : value }),
      })
      if (!response.ok) throw new Error('同步激活计划时区失败，请重试。')
      const telegramResponse = await fetch('/codex-api/telegram/notification-preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timezone: value === 'system' ? browserTimeZone() : value }),
      })
      if (!telegramResponse.ok) throw new Error('显示时区保存失败。')
      setDisplayTimeZone(value)
    } catch (cause) {
      notifyOperation(cause instanceof Error ? cause.message : '显示时区保存失败。')
    } finally {
      isSaving.value = false
    }
  }

  return {
    displayTimeZonePreference,
    displayTimeZoneError: error,
    isSavingDisplayTimeZone: isSaving,
    displayTimeZoneOptions: options,
    onDisplayTimeZoneChange: onChange,
  }
}
