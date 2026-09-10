import { useUiLanguage } from './composables/useUiLanguage'
import { readonly, ref } from 'vue'
import { DEFAULT_TIME_ZONE } from './timeZoneConstants'

export { DEFAULT_TIME_ZONE } from './timeZoneConstants'
export const DISPLAY_TIME_ZONE_STORAGE_KEY = 'codex-web-local.display-timezone.v1'
const formatters = new Map<string, Intl.DateTimeFormat>()

export function isValidTimeZone(value: string): boolean {
  if (!value || value.length > 100) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0)
    return true
  } catch {
    return false
  }
}

function readStoredTimeZone(): string {
  try {
    const value = typeof window === 'undefined' ? '' : window.localStorage.getItem(DISPLAY_TIME_ZONE_STORAGE_KEY) || ''
    return value !== 'system' && isValidTimeZone(value) ? value : 'system'
  } catch {
    return 'system'
  }
}

const preferredTimeZone = ref(readStoredTimeZone())
export const displayTimeZonePreference = readonly(preferredTimeZone)

export function setDisplayTimeZone(value: string): void {
  if (value !== 'system' && !isValidTimeZone(value)) throw new Error('请选择有效的 IANA 时区。')
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(DISPLAY_TIME_ZONE_STORAGE_KEY, value)
      if (window.localStorage.getItem(DISPLAY_TIME_ZONE_STORAGE_KEY) !== value) throw new Error('Not saved')
    } catch {
      throw new Error('无法保存显示时区，请检查浏览器存储后重试。')
    }
  }
  preferredTimeZone.value = value
}

export function subscribeDisplayTimeZoneStorage(): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === DISPLAY_TIME_ZONE_STORAGE_KEY || event.key === null) preferredTimeZone.value = readStoredTimeZone()
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}

let supportedZones: string[] | null = null
export function availableDisplayTimeZones(): string[] {
  if (!supportedZones) {
    const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }
    try {
      supportedZones = intl.supportedValuesOf?.('timeZone') || []
    } catch {
      supportedZones = []
    }
  }
  const fallbackZones = ['America/New_York', 'America/Los_Angeles', 'Europe/London', 'Asia/Tokyo', 'Asia/Singapore', 'Australia/Sydney']
  return [...new Set([
    'UTC', 'Asia/Shanghai', browserTimeZone(),
    ...(preferredTimeZone.value === 'system' ? [] : [preferredTimeZone.value]),
    ...(supportedZones.length ? supportedZones : fallbackZones),
  ])]
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIME_ZONE
  } catch {
    return DEFAULT_TIME_ZONE
  }
}

export function displayTimeZone(): string {
  return preferredTimeZone.value === 'system' ? browserTimeZone() : preferredTimeZone.value
}

export function formatLocalDateTime(value: string | number, options: Intl.DateTimeFormatOptions = {}, locale?: string): string {
  locale ??= useUiLanguage().uiLanguage.value
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  const settings: Intl.DateTimeFormatOptions = {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    ...options, timeZone: displayTimeZone(),
  }
  const key = JSON.stringify([locale, settings])
  let formatter = formatters.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, settings)
    if (formatters.size >= 32) formatters.delete(formatters.keys().next().value!)
    formatters.set(key, formatter)
  }
  return formatter.format(date)
}
