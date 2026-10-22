import { computed, ref } from 'vue'
import { useUiLanguage } from './useUiLanguage'

export type ChatWidthMode = 'standard' | 'wide' | 'extra-wide'

type ChatWidthPreset = {
  label: string
  columnMax: string
  cardMax: string
}

export const CHAT_WIDTH_PRESETS: Record<ChatWidthMode, ChatWidthPreset> = {
  standard: {
    label: 'Standard',
    columnMax: '45rem',
    cardMax: '76ch',
  },
  wide: {
    label: 'Wide',
    columnMax: '72rem',
    cardMax: '88ch',
  },
  'extra-wide': {
    label: 'Extra wide',
    columnMax: '96rem',
    cardMax: '96ch',
  },
}

const DARK_MODE_KEY = 'codex-web-local.dark-mode.v1'
const CHAT_WIDTH_KEY = 'codex-web-local.chat-width.v1'

function loadDarkModePref(): 'system' | 'light' | 'dark' {
  if (typeof window === 'undefined') return 'system'
  const value = window.localStorage.getItem(DARK_MODE_KEY)
  if (value === 'light' || value === 'dark') return value
  return 'system'
}

function loadChatWidthPref(): ChatWidthMode {
  if (typeof window === 'undefined') return 'standard'
  const value = window.localStorage.getItem(CHAT_WIDTH_KEY)
  return value === 'standard' || value === 'wide' || value === 'extra-wide' ? value : 'standard'
}

const darkMode = ref<'system' | 'light' | 'dark'>(loadDarkModePref())
const chatWidth = ref<ChatWidthMode>(loadChatWidthPref())

function syncThemeColorMeta(): void {
  const meta = document.getElementById('app-theme-color')
  if (!meta) return
  const isDark = document.documentElement.classList.contains('dark')
  meta.setAttribute('content', isDark ? '#09090b' : '#ffffff')
}

function applyDarkMode(): void {
  const root = document.documentElement
  if (darkMode.value === 'dark') {
    root.classList.add('dark')
  } else if (darkMode.value === 'light') {
    root.classList.remove('dark')
  } else {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    root.classList.toggle('dark', prefersDark)
  }
  syncThemeColorMeta()
}

export function useAppearancePreferences() {
  const { t } = useUiLanguage()

  function setDarkMode(value: string): void {
    if (value !== 'system' && value !== 'light' && value !== 'dark') return
    darkMode.value = value
    window.localStorage.setItem(DARK_MODE_KEY, darkMode.value)
    applyDarkMode()
  }

  function cycleDarkMode(): void {
    const order: Array<'system' | 'light' | 'dark'> = ['dark', 'light', 'system']
    const index = order.indexOf(darkMode.value)
    setDarkMode(order[(index + 1) % order.length]!)
  }

  function setChatWidth(value: string): void {
    if (value !== 'standard' && value !== 'wide' && value !== 'extra-wide') return
    chatWidth.value = value
    window.localStorage.setItem(CHAT_WIDTH_KEY, chatWidth.value)
  }

  return {
    darkMode,
    chatWidth,
    appearanceOptions: computed(() => [
      { value: 'system', label: t('自动') },
      { value: 'light', label: t('Light') },
      { value: 'dark', label: t('Dark') },
    ]),
    chatWidthOptions: computed(() => Object.entries(CHAT_WIDTH_PRESETS).map(([value, preset]) => ({
      value,
      label: t(preset.label),
    }))),
    applyDarkMode,
    cycleDarkMode,
    setDarkMode,
    setChatWidth,
  }
}
