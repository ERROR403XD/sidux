import { computed, ref } from 'vue'
import { useUiLanguage } from './useUiLanguage'

const SEND_WITH_ENTER_KEY = 'codex-web-local.send-with-enter.v1'
const DICTATION_CLICK_TO_TOGGLE_KEY = 'codex-web-local.dictation-click-to-toggle.v1'
const DICTATION_AUTO_SEND_KEY = 'codex-web-local.dictation-auto-send.v1'
const DICTATION_LANGUAGE_KEY = 'codex-web-local.dictation-language.v1'

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>

function readPreference(storage: PreferenceStorage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function loadBoolPref(storage: PreferenceStorage | undefined, key: string, fallback: boolean): boolean {
  const value = readPreference(storage, key)
  if (value === null) return fallback
  return value === '1'
}

function loadDictationLanguagePref(storage: PreferenceStorage | undefined): string {
  const value = readPreference(storage, DICTATION_LANGUAGE_KEY)?.trim() || 'auto'
  const normalized = normalizeToWhisperLanguage(value)
  return normalized || 'auto'
}

function normalizeToWhisperLanguage(raw: string): string {
  const value = raw.trim().toLowerCase()
  if (!value || value === 'auto') return ''
  if (Object.hasOwn(WHISPER_LANGUAGES, value)) return value
  const base = value.split('-')[0] ?? value
  if (Object.hasOwn(WHISPER_LANGUAGES, base)) return base
  return ''
}

const WHISPER_LANGUAGES: Record<string, string> = {
  en: 'english',
  zh: 'chinese',
  de: 'german',
  es: 'spanish',
  ru: 'russian',
  ko: 'korean',
  fr: 'french',
  ja: 'japanese',
  pt: 'portuguese',
  tr: 'turkish',
  pl: 'polish',
  ca: 'catalan',
  nl: 'dutch',
  ar: 'arabic',
  sv: 'swedish',
  it: 'italian',
  id: 'indonesian',
  hi: 'hindi',
  fi: 'finnish',
  vi: 'vietnamese',
  he: 'hebrew',
  uk: 'ukrainian',
  el: 'greek',
  ms: 'malay',
  cs: 'czech',
  ro: 'romanian',
  da: 'danish',
  hu: 'hungarian',
  ta: 'tamil',
  no: 'norwegian',
  th: 'thai',
  ur: 'urdu',
  hr: 'croatian',
  bg: 'bulgarian',
  lt: 'lithuanian',
  la: 'latin',
  mi: 'maori',
  ml: 'malayalam',
  cy: 'welsh',
  sk: 'slovak',
  te: 'telugu',
  fa: 'persian',
  lv: 'latvian',
  bn: 'bengali',
  sr: 'serbian',
  az: 'azerbaijani',
  sl: 'slovenian',
  kn: 'kannada',
  et: 'estonian',
  mk: 'macedonian',
  br: 'breton',
  eu: 'basque',
  is: 'icelandic',
  hy: 'armenian',
  ne: 'nepali',
  mn: 'mongolian',
  bs: 'bosnian',
  kk: 'kazakh',
  sq: 'albanian',
  sw: 'swahili',
  gl: 'galician',
  mr: 'marathi',
  pa: 'punjabi',
  si: 'sinhala',
  km: 'khmer',
  sn: 'shona',
  yo: 'yoruba',
  so: 'somali',
  af: 'afrikaans',
  oc: 'occitan',
  ka: 'georgian',
  be: 'belarusian',
  tg: 'tajik',
  sd: 'sindhi',
  gu: 'gujarati',
  am: 'amharic',
  yi: 'yiddish',
  lo: 'lao',
  uz: 'uzbek',
  fo: 'faroese',
  ht: 'haitian creole',
  ps: 'pashto',
  tk: 'turkmen',
  nn: 'nynorsk',
  mt: 'maltese',
  sa: 'sanskrit',
  lb: 'luxembourgish',
  my: 'myanmar',
  bo: 'tibetan',
  tl: 'tagalog',
  mg: 'malagasy',
  as: 'assamese',
  tt: 'tatar',
  haw: 'hawaiian',
  ln: 'lingala',
  ha: 'hausa',
  ba: 'bashkir',
  jw: 'javanese',
  su: 'sundanese',
  yue: 'cantonese',
}

function createInputPreferenceState(storage: PreferenceStorage | undefined) {
  const sendWithEnter = ref(loadBoolPref(storage, SEND_WITH_ENTER_KEY, true))
  const dictationClickToToggle = ref(loadBoolPref(storage, DICTATION_CLICK_TO_TOGGLE_KEY, false))
  const dictationAutoSend = ref(loadBoolPref(storage, DICTATION_AUTO_SEND_KEY, true))
  const dictationLanguage = ref(loadDictationLanguagePref(storage))

  function persist(key: string, value: string): void {
    try {
      storage?.setItem(key, value)
    } catch {
      // Keep the current preference usable when browser storage is unavailable.
    }
  }

  function toggleSendWithEnter(): void {
    sendWithEnter.value = !sendWithEnter.value
    persist(SEND_WITH_ENTER_KEY, sendWithEnter.value ? '1' : '0')
  }

  function toggleDictationClickToToggle(): void {
    dictationClickToToggle.value = !dictationClickToToggle.value
    persist(DICTATION_CLICK_TO_TOGGLE_KEY, dictationClickToToggle.value ? '1' : '0')
  }

  function toggleDictationAutoSend(): void {
    dictationAutoSend.value = !dictationAutoSend.value
    persist(DICTATION_AUTO_SEND_KEY, dictationAutoSend.value ? '1' : '0')
  }

  function onDictationLanguageChange(nextValue: string): void {
    const normalized = normalizeToWhisperLanguage(nextValue.trim())
    const value = normalized || 'auto'
    dictationLanguage.value = value
    persist(DICTATION_LANGUAGE_KEY, value)
  }

  return {
    sendWithEnter, dictationClickToToggle, dictationAutoSend, dictationLanguage,
    toggleSendWithEnter, toggleDictationClickToToggle, toggleDictationAutoSend, onDictationLanguageChange,
  }
}

let sharedPreferences: ReturnType<typeof createInputPreferenceState> | undefined

function browserStorage(): PreferenceStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

export function useInputPreferences() {
  // Restore once on first use, after module constants are initialized.
  const preferences = sharedPreferences ??= createInputPreferenceState(browserStorage())
  const { dictationLanguage } = preferences
  const { t } = useUiLanguage()

  function buildDictationLanguageOptions(): Array<{ value: string; label: string }> {
    const options: Array<{ value: string; label: string }> = [{ value: 'auto', label: t('Auto-detect') }]
    const seen = new Set<string>(['auto'])
    function formatLanguageLabel(value: string): string {
      const languageName = WHISPER_LANGUAGES[value] || value
      const title = languageName.charAt(0).toUpperCase() + languageName.slice(1)
      return `${title} (${value})`
    }

    for (const raw of typeof navigator !== 'undefined' ? navigator.languages ?? [] : []) {
      const normalized = normalizeToWhisperLanguage(raw)
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      options.push({ value: normalized, label: formatLanguageLabel(normalized) })
    }

    const current = dictationLanguage.value.trim()
    if (current && current !== 'auto' && !seen.has(current)) {
      seen.add(current)
      options.push({ value: current, label: `Preferred: ${formatLanguageLabel(current)}` })
    }

    for (const value of Object.keys(WHISPER_LANGUAGES)) {
      if (seen.has(value)) continue
      seen.add(value)
      options.push({ value, label: formatLanguageLabel(value) })
    }

    return options
  }

  return {
    ...preferences,
    dictationLanguageOptions: computed(buildDictationLanguageOptions),
  }
}
