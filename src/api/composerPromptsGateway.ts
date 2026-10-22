export type ComposerPromptInfo = {
  name: string
  path: string
  content: string
  description: string
}

let composerPromptsRead: Promise<ComposerPromptInfo[]> | null = null

export function getComposerPrompts(): Promise<ComposerPromptInfo[]> {
  if (composerPromptsRead) return composerPromptsRead
  const task = readComposerPrompts().finally(() => {
    if (composerPromptsRead === task) composerPromptsRead = null
  })
  composerPromptsRead = task
  return task
}

async function readComposerPrompts(): Promise<ComposerPromptInfo[]> {
  try {
    const response = await fetch('/codex-api/prompts')
    if (!response.ok) return []
    const payload = (await response.json()) as { data?: ComposerPromptInfo[] }
    return Array.isArray(payload.data) ? payload.data : []
  } catch {
    return []
  }
}

export async function createComposerPrompt(name: string, content: string): Promise<ComposerPromptInfo | null> {
  try {
    const response = await fetch('/codex-api/prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, content }),
    })
    if (!response.ok) return null
    const payload = (await response.json()) as { data?: ComposerPromptInfo }
    composerPromptsRead = null
    return payload.data ?? null
  } catch {
    return null
  }
}

export async function removeComposerPrompt(path: string): Promise<boolean> {
  try {
    const params = new URLSearchParams({ path })
    const response = await fetch(`/codex-api/prompts?${params.toString()}`, {
      method: 'DELETE',
    })
    if (response.ok) composerPromptsRead = null
    return response.ok
  } catch {
    return false
  }
}
