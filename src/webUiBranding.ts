export type WebUiBranding = { title: string; titleMode: 'fixed' | 'prefix'; logoVersion: string }
export const defaultWebUiBranding: WebUiBranding = { title: '', titleMode: 'prefix', logoVersion: '' }
export const webUiIconSizes = [32, 64, 150, 180, 192, 512] as const
export function webUiDocumentTitle(settings: WebUiBranding, threadTitle: string, fallback: string): string {
  const title = settings.title.trim()
  if (!title) return threadTitle.trim() || fallback
  return settings.titleMode === 'prefix' && threadTitle.trim() ? `${title} - ${threadTitle.trim()}` : title
}
export function webUiIconUrl(size: number, version: string, maskable = false): string {
  return `/webui-assets/${maskable ? 'maskable' : 'icon'}-${size}.png?v=${encodeURIComponent(version)}`
}
