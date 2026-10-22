const FILE_UPLOAD_TIMEOUT_MS = 60_000

export async function uploadFile(file: File): Promise<string | null> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), FILE_UPLOAD_TIMEOUT_MS)
  try {
    const form = new FormData()
    form.append('file', file)
    const resp = await fetch('/codex-api/upload-file', {
      method: 'POST',
      body: form,
      signal: controller.signal,
    })
    if (!resp.ok) return null
    const data = (await resp.json()) as { path?: string }
    return data.path ?? null
  } catch {
    return null
  } finally {
    clearTimeout(timeoutId)
  }
}
