export interface FreeModeStatus {
  enabled: boolean
  hasCodexAuth?: boolean
  keyCount: number
  models: string[]
  currentModel: string | null
  customKey: boolean
  maskedKey: string | null
  provider?: 'openrouter' | 'custom' | 'opencode-zen'
  customBaseUrl?: string
  wireApi?: 'responses' | 'chat' | null
}

export async function getFreeModeStatus(): Promise<FreeModeStatus> {
  const response = await fetch('/codex-api/free-mode/status')
  return await response.json() as FreeModeStatus
}

export async function setFreeMode(enable: boolean): Promise<{ ok: boolean; enabled: boolean; model?: string; models?: string[] }> {
  const response = await fetch('/codex-api/free-mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enable }),
  })
  return await response.json() as { ok: boolean; enabled: boolean; model?: string; models?: string[] }
}

export async function setFreeModeCustomKey(key: string): Promise<{ ok: boolean; customKey: boolean }> {
  const response = await fetch('/codex-api/free-mode/custom-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  })
  return await response.json() as { ok: boolean; customKey: boolean }
}

export async function setCustomProvider(
  baseUrl: string,
  apiKey: string,
  options?: { wireApi?: 'responses' | 'chat'; provider?: 'custom' | 'opencode-zen' | 'openrouter' },
): Promise<{ ok: boolean }> {
  const response = await fetch('/codex-api/free-mode/custom-provider', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl,
      apiKey,
      wireApi: options?.wireApi,
      provider: options?.provider,
    }),
  })
  return await response.json() as { ok: boolean }
}
