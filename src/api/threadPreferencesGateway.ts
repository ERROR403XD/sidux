import { callRpc } from './rpcGateway'
import { normalizeConversationPreferences, type ConversationPreferences, type ConversationPreferencePatch } from '../conversationPreferences'

export async function getConversationPreferences(threadId: string): Promise<ConversationPreferences> {
  const response = await fetch(`/codex-api/preferences/conversations?${new URLSearchParams({ threadId })}`, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error('会话设置同步失败，请稍后重试。')
  return normalizeConversationPreferences((await response.json()).data)
}

export async function persistConversationPreferences(patch: ConversationPreferencePatch): Promise<void> {
  const response = await fetch('/codex-api/preferences/conversations', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error('会话设置保存失败，请稍后重试。')
}

export type ThreadTitleCache = { titles: Record<string, string>; order: string[] }
export type ThreadPinnedState = { threadIds: string[] }

export async function getThreadTitleCache(): Promise<ThreadTitleCache> {
  try {
    const response = await fetch('/codex-api/thread-titles')
    if (!response.ok) return { titles: {}, order: [] }
    const envelope = (await response.json()) as { data?: ThreadTitleCache }
    return envelope.data ?? { titles: {}, order: [] }
  } catch {
    return { titles: {}, order: [] }
  }
}

export async function persistThreadTitle(id: string, title: string): Promise<void> {
  try {
    await fetch('/codex-api/thread-titles', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, title }),
    })
  } catch {
    // Best-effort persist
  }
}

export async function getPinnedThreadState(): Promise<ThreadPinnedState> {
  try {
    const response = await fetch('/codex-api/thread-pins')
    if (!response.ok) return { threadIds: [] }
    const envelope = (await response.json()) as { data?: ThreadPinnedState }
    return envelope.data ?? { threadIds: [] }
  } catch {
    return { threadIds: [] }
  }
}

export async function persistPinnedThreadIds(threadIds: string[]): Promise<void> {
  try {
    await fetch('/codex-api/thread-pins', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadIds }),
    })
  } catch {
    // Best-effort persist
  }
}

export async function generateThreadTitle(prompt: string, cwd: string | null): Promise<string> {
  try {
    const result = await callRpc<{ title?: string }>('generate-thread-title', { prompt, cwd })
    return result.title?.trim() ?? ''
  } catch {
    return ''
  }
}
