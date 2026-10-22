import { readCodexAuth } from './appServerAuth.js'
import { asRecord } from './httpUtils.js'
import { readNonEmptyString } from './runtimePaths.js'

function parseConnectorLogoUrl(rawUrl: string): { connectorId: string; theme: 'light' | 'dark' } | null {
  const trimmed = rawUrl.trim()
  if (!trimmed.startsWith('connectors://')) return null
  const rest = trimmed.slice('connectors://'.length)
  const connectorId = (rest.split(/[/?#]/u)[0] ?? '').trim()
  if (!connectorId) return null
  const query = rest.includes('?') ? rest.slice(rest.indexOf('?') + 1).split('#')[0] ?? '' : ''
  const theme = new URLSearchParams(query).get('theme')?.toLowerCase() === 'dark' ? 'dark' : 'light'
  return { connectorId, theme }
}

export async function fetchConnectorLogo(rawUrl: string): Promise<{ contentType: string; body: Buffer }> {
  const parsed = parseConnectorLogoUrl(rawUrl)
  if (!parsed) throw new Error('Unsupported connector logo URL')
  const auth = await readCodexAuth()
  if (!auth) throw new Error('No auth token available for connector logo')

  const endpoint = `https://chatgpt.com/backend-api/aip/connectors/${encodeURIComponent(parsed.connectorId)}/logo?theme=${parsed.theme}`
  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      originator: 'Codex Desktop',
      'User-Agent': `Codex Desktop/0.1.0 (${process.platform}; ${process.arch})`,
      ...(auth.accountId ? { 'ChatGPT-Account-Id': auth.accountId } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Connector logo fetch failed (${response.status})`)

  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    const payload = asRecord(await response.json())
    const body = asRecord(payload?.body)
    const base64 = readNonEmptyString(body?.base64)
    const nestedContentType = readNonEmptyString(body?.contentType) || readNonEmptyString(body?.content_type)
    if (!base64 || !nestedContentType) throw new Error('Connector logo response was missing image data')
    return { contentType: nestedContentType, body: Buffer.from(base64, 'base64') }
  }

  return {
    contentType: contentType || 'image/png',
    body: Buffer.from(await response.arrayBuffer()),
  }
}
