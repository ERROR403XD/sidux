import { ref } from 'vue'
import { defaultWebUiBranding, webUiIconUrl, type WebUiBranding } from '../webUiBranding'
const initial = typeof window !== 'undefined' ? (window as Window & { __WEBUI_BRANDING__?: WebUiBranding }).__WEBUI_BRANDING__ : undefined
const branding = ref<WebUiBranding>(initial || { ...defaultWebUiBranding })
export function applyWebUiBranding(value: WebUiBranding): void {
  branding.value = value
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[data-webui-icon]')) {
    link.href = webUiIconUrl(Number(link.dataset.webuiIcon), value.logoVersion)
  }
  const manifest = document.querySelector<HTMLLinkElement>('link[rel=manifest]')
  if (manifest) manifest.href = `/manifest.webmanifest?v=${encodeURIComponent(`${value.logoVersion}-${value.title}`)}`
  document.querySelector('meta[name=apple-mobile-web-app-title]')?.setAttribute('content', value.title || 'Codex Web')
  document.querySelector('meta[name=application-name]')?.setAttribute('content', value.title || 'Codex Web')
}
export function useWebUiBranding() { return { branding, applyWebUiBranding } }
if (typeof document !== 'undefined') {
  if (initial) applyWebUiBranding(initial)
  else void fetch('/webui-assets/settings').then(response => response.json()).then(payload => applyWebUiBranding(payload.data)).catch(() => {})
}
