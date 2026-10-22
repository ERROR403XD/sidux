import type { Ref } from 'vue'

function omitKey<TValue>(record: Record<string, TValue>, key: string): Record<string, TValue> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

function pruneReasoningMap(
  textByThreadId: Record<string, string>,
  activeThreadIds: Set<string>,
): Record<string, string> {
  const nextEntries = Object.entries(textByThreadId).filter(([threadId]) => activeThreadIds.has(threadId))
  if (nextEntries.length === Object.keys(textByThreadId).length) {
    return textByThreadId
  }
  return Object.fromEntries(nextEntries)
}

type ThreadLiveReasoningStateOptions = {
  textByThreadId: Ref<Record<string, string>>
}

export function createThreadLiveReasoningState({ textByThreadId }: ThreadLiveReasoningStateOptions) {
  function getText(threadId: string): string {
    return textByThreadId.value[threadId] ?? ''
  }

  function setText(threadId: string, text: string): void {
    if (!threadId) return
    const normalized = text.trim()
    const previous = getText(threadId)
    if (normalized.length === 0) {
      if (!previous) return
      textByThreadId.value = omitKey(textByThreadId.value, threadId)
      return
    }
    if (previous === normalized) return
    textByThreadId.value = {
      ...textByThreadId.value,
      [threadId]: normalized,
    }
  }

  return {
    getText,
    setText,
    append: (threadId: string, delta: string): void => {
      if (!threadId) return
      setText(threadId, `${getText(threadId)}${delta}`)
    },
    appendSectionBreak: (threadId: string): void => {
      const current = getText(threadId)
      if (current.trim().length > 0 && !current.endsWith('\n\n')) {
        setText(threadId, `${current}\n\n`)
      }
    },
    clear: (threadId: string): void => {
      if (!threadId || !(threadId in textByThreadId.value)) return
      textByThreadId.value = omitKey(textByThreadId.value, threadId)
    },
    prune: (activeThreadIds: Set<string>) => {
      textByThreadId.value = pruneReasoningMap(textByThreadId.value, activeThreadIds)
    },
    reset: () => {
      textByThreadId.value = {}
    },
  }
}
