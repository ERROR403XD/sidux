import { computed, ref } from 'vue'

export const FEEDBACK_URL = 'https://github.com/ERROR403XD/codexapp/issues'
const MAX_DIAGNOSTICS = 20
export const feedbackReport = ref<string | null>(null)

export type FeedbackDiagnosticKind = 'window-error' | 'unhandled-rejection' | 'fetch-error' | 'api-response' | 'visible-error'

export type FeedbackDiagnostic = {
  kind: FeedbackDiagnosticKind
  message: string
  atIso: string
  url?: string
  method?: string
  status?: number
  statusText?: string
}

const diagnostics = ref<FeedbackDiagnostic[]>([])
let listenersInstalled = false
let fetchInstalled = false
let originalFetch: typeof window.fetch | null = null

function normalizeMessage(value: unknown): string {
  if (value instanceof Error) return value.stack || value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function normalizeFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function normalizeFetchMethod(input: RequestInfo | URL, init?: RequestInit): string {
  const initMethod = init?.method?.trim()
  if (initMethod) return initMethod.toUpperCase()
  if (typeof input === 'object' && 'method' in input && typeof input.method === 'string' && input.method.trim()) {
    return input.method.trim().toUpperCase()
  }
  return 'GET'
}

export function recordFeedbackDiagnostic(input: Omit<FeedbackDiagnostic, 'atIso'> & { atIso?: string }): void {
  const message = input.message.trim()
  if (!message) return
  const newest = diagnostics.value[0]
  if (
    newest &&
    newest.kind === input.kind &&
    newest.message === message &&
    newest.url === input.url &&
    newest.method === input.method &&
    newest.status === input.status
  ) {
    return
  }

  const next: FeedbackDiagnostic = {
    ...input,
    message,
    atIso: input.atIso ?? new Date().toISOString(),
  }
  diagnostics.value = [next, ...diagnostics.value].slice(0, MAX_DIAGNOSTICS)
}

export function buildFeedbackReport(entries: FeedbackDiagnostic[] = diagnostics.value): string {
  const root = typeof document === 'undefined' ? undefined : document.documentElement
  const route = typeof window === 'undefined' ? '' : window.location.hash.split(/[/?]/)[1]
  const category = ['thread', 'settings', 'skills', 'automations', 'api-proxy'].includes(route || '') ? route : 'home/other'
  return [
    `CodexApp ${import.meta.env.VITE_APP_VERSION || 'unknown'}`,
    `Time: ${new Date().toISOString()}`,
    `Route: ${category}`,
    `Theme: ${root?.classList?.contains('dark') ? 'dark' : 'light'}`,
    `Language: ${root?.dataset?.uiLanguage || 'unknown'}`,
    `Viewport: ${typeof window === 'undefined' ? 'unknown' : `${window.innerWidth}x${window.innerHeight}`}`,
    '',
    'Diagnostics (category / HTTP status only):',
    ...entries.slice(0, 12).map(entry => `${entry.kind}${Number.isInteger(entry.status) ? ` / HTTP ${entry.status}` : ''}`),
  ].join('\n')
}

export function openFeedbackReport(event?: MouseEvent): void {
  event?.preventDefault()
  feedbackReport.value = buildFeedbackReport()
}

export function installFeedbackDiagnostics(): void {
  if (typeof window === 'undefined') return

  if (!listenersInstalled) {
    listenersInstalled = true
    window.addEventListener('error', (event) => {
      recordFeedbackDiagnostic({
        kind: 'window-error',
        message: event.error ? normalizeMessage(event.error) : event.message,
        url: event.filename || window.location.href,
      })
    })
    window.addEventListener('unhandledrejection', (event) => {
      recordFeedbackDiagnostic({
        kind: 'unhandled-rejection',
        message: normalizeMessage(event.reason),
        url: window.location.href,
      })
    })
  }

  if (!fetchInstalled) {
    if (typeof window.fetch !== 'function') {
      recordFeedbackDiagnostic({
        kind: 'fetch-error',
        message: 'Feedback diagnostics could not monitor fetch: window.fetch is unavailable',
        url: window.location.href,
      })
      return
    }

    try {
      originalFetch = window.fetch.bind(window)
      window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = normalizeFetchUrl(input)
        const method = normalizeFetchMethod(input, init)
        try {
          const response = await originalFetch!(input, init)
          if (!response.ok) {
            recordFeedbackDiagnostic({
              kind: url.includes('/codex-api/') ? 'api-response' : 'fetch-error',
              message: `Request failed with HTTP ${response.status}`,
              url,
              method,
              status: response.status,
              statusText: response.statusText,
            })
          }
          return response
        } catch (error) {
          recordFeedbackDiagnostic({
            kind: 'fetch-error',
            message: normalizeMessage(error),
            url,
            method,
          })
          throw error
        }
      }) as typeof window.fetch
      fetchInstalled = true
    } catch (error) {
      originalFetch = null
      fetchInstalled = false
      try {
        recordFeedbackDiagnostic({
          kind: 'fetch-error',
          message: `Feedback diagnostics could not monitor fetch: ${normalizeMessage(error)}`,
          url: window.location.href,
        })
      } catch {
        // Startup diagnostics must never prevent the app from mounting.
      }
    }
  }
}

export function useFeedbackDiagnostics() {
  const hasFeedbackDiagnostics = computed(() => diagnostics.value.length > 0)

  function recordVisibleFailure(message: string, url?: string): void {
    recordFeedbackDiagnostic({
      kind: 'visible-error',
      message,
      url: url || (typeof window === 'undefined' ? undefined : window.location.href),
    })
  }

  return {
    diagnostics,
    hasFeedbackDiagnostics,
    recordVisibleFailure,
    openFeedbackReport,
    feedbackUrl: FEEDBACK_URL,
  }
}
