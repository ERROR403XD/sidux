import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { buildFeedbackReport, installFeedbackDiagnostics, FEEDBACK_URL, feedbackReport, openFeedbackReport, recordFeedbackDiagnostic, useFeedbackDiagnostics } from './useFeedbackDiagnostics'

beforeEach(() => {
  vi.stubGlobal('window', {
    innerWidth: 390, innerHeight: 844, addEventListener: vi.fn(),
    location: { hash: '#/thread/private-id?token=secret', href: 'https://private-host/private-path' },
    localStorage: { getItem: () => { throw new Error('Storage must not be read') } },
  })
  vi.stubGlobal('document', {
    documentElement: { classList: { contains: () => true }, dataset: { uiLanguage: 'zh-CN' } },
    body: { get innerText() { throw new Error('Page text must not be read') } },
  })
  useFeedbackDiagnostics().diagnostics.value = []
  feedbackReport.value = null
})
afterEach(() => vi.unstubAllGlobals())

describe('minimal feedback report', () => {
  it('exports only allowlisted context and diagnostic categories', () => {
    recordFeedbackDiagnostic({ kind: 'api-response', message: 'private conversation secret', url: '/private/path?token=secret', status: 429, statusText: 'private response' })
    const report = buildFeedbackReport()
    expect(report).toContain('Route: thread')
    expect(report).toContain('Theme: dark')
    expect(report).toContain('Language: zh-CN')
    expect(report).toContain('Viewport: 390x844')
    expect(report).toContain('api-response / HTTP 429')
    expect(report).not.toMatch(/private|secret|token|localStorage/)
  })
  it('opens a local preview and prevents anchor navigation', () => {
    const event = { preventDefault: vi.fn() } as unknown as MouseEvent
    openFeedbackReport(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(feedbackReport.value).toContain('CodexApp')
    expect(FEEDBACK_URL).toBe('https://github.com/ERROR403XD/codexapp/issues')
  })
  it('bounds reports and deduplicates identical latest entries', () => {
    const entry = { kind: 'visible-error' as const, message: 'failure' }
    recordFeedbackDiagnostic(entry)
    recordFeedbackDiagnostic(entry)
    expect(useFeedbackDiagnostics().diagnostics.value).toHaveLength(1)
    for (let i = 0; i < 30; i++) recordFeedbackDiagnostic({ ...entry, message: String(i) })
    expect(useFeedbackDiagnostics().diagnostics.value).toHaveLength(20)
    expect(buildFeedbackReport().match(/visible-error/g)).toHaveLength(12)
  })
})

// Keep the existing startup failure guards covered after replacing email reports.
describe('feedback instrumentation startup', () => {
  it('does not prevent startup when fetch is unavailable', () => {
    expect(() => installFeedbackDiagnostics()).not.toThrow()
    expect(useFeedbackDiagnostics().diagnostics.value[0]?.message).toContain('window.fetch is unavailable')
  })
  it('does not prevent startup when fetch cannot be patched', () => {
    Object.defineProperty(window, 'fetch', { value: vi.fn(), writable: false, configurable: true })
    expect(() => installFeedbackDiagnostics()).not.toThrow()
    expect(useFeedbackDiagnostics().diagnostics.value[0]?.message).toContain('could not monitor fetch')
  })
})
