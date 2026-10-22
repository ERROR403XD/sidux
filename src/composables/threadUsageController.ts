import { computed, ref } from 'vue'
import type { UiThreadTokenUsage } from '../types/codex'
import { clamp, omitKey } from './threadNotificationValues'
import { pruneThreadStateMap } from './threadContextState'

type ThreadUsageControllerOptions = {
  getSelectedThreadId: () => string
}

const THREAD_TOKEN_USAGE_STORAGE_KEY = 'codex-web-local.thread-token-usage.v1'

function normalizeStoredTokenCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value))
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.trunc(parsed))
    }
  }

  return null
}

function asStoredRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalizeStoredTokenUsageBreakdown(record: Record<string, unknown> | null): UiThreadTokenUsage['last'] | null {
  if (!record || Array.isArray(record)) return null
  return {
    totalTokens: normalizeStoredTokenCount(record.totalTokens) ?? 0,
    inputTokens: normalizeStoredTokenCount(record.inputTokens) ?? 0,
    cachedInputTokens: normalizeStoredTokenCount(record.cachedInputTokens) ?? 0,
    outputTokens: normalizeStoredTokenCount(record.outputTokens) ?? 0,
    reasoningOutputTokens: normalizeStoredTokenCount(record.reasoningOutputTokens) ?? 0,
  }
}

function normalizeStoredThreadTokenUsage(record: Record<string, unknown> | null): UiThreadTokenUsage | null {
  if (!record) return null
  const total = normalizeStoredTokenUsageBreakdown(asStoredRecord(record.total))
  const last = normalizeStoredTokenUsageBreakdown(asStoredRecord(record.last))
  if (!total || !last) return null

  const modelContextWindow = normalizeStoredTokenCount(record.modelContextWindow)
  const currentContextTokens = last.totalTokens
  const remainingContextTokens = typeof modelContextWindow === 'number'
    ? Math.max(modelContextWindow - currentContextTokens, 0)
    : null
  const remainingContextPercent = typeof modelContextWindow === 'number' && modelContextWindow > 0
    ? clamp(Math.round((remainingContextTokens ?? 0) / modelContextWindow * 100), 0, 100)
    : null

  return {
    total,
    last,
    modelContextWindow,
    currentContextTokens,
    remainingContextTokens,
    remainingContextPercent,
  }
}

function loadThreadTokenUsageMap(): Record<string, UiThreadTokenUsage> {
  if (typeof window === 'undefined') return {}

  try {
    const raw = window.localStorage.getItem(THREAD_TOKEN_USAGE_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const normalizedMap: Record<string, UiThreadTokenUsage> = {}
    for (const [threadId, usage] of Object.entries(parsed as Record<string, unknown>)) {
      if (!threadId) continue
      const normalizedUsage = normalizeStoredThreadTokenUsage(asStoredRecord(usage))
      if (normalizedUsage) {
        normalizedMap[threadId] = normalizedUsage
      }
    }
    return normalizedMap
  } catch {
    return {}
  }
}

function saveThreadTokenUsageMap(state: Record<string, UiThreadTokenUsage>): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(THREAD_TOKEN_USAGE_STORAGE_KEY, JSON.stringify(state))
}

export function createThreadUsageController({ getSelectedThreadId }: ThreadUsageControllerOptions) {
  const threadTokenUsageByThreadId = ref<Record<string, UiThreadTokenUsage>>(loadThreadTokenUsageMap())
  const selectedThreadTokenUsage = computed<UiThreadTokenUsage | null>(() => {
    const threadId = getSelectedThreadId()
    if (!threadId) return null
    return threadTokenUsageByThreadId.value[threadId] ?? null
  })

  function setThreadTokenUsage(threadId: string, usage: UiThreadTokenUsage | null): void {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return

    if (!usage) {
      if (!(normalizedThreadId in threadTokenUsageByThreadId.value)) return
      threadTokenUsageByThreadId.value = omitKey(threadTokenUsageByThreadId.value, normalizedThreadId)
      saveThreadTokenUsageMap(threadTokenUsageByThreadId.value)
      return
    }

    const current = threadTokenUsageByThreadId.value[normalizedThreadId]
    if (current && JSON.stringify(current) === JSON.stringify(usage)) return

    threadTokenUsageByThreadId.value = {
      ...threadTokenUsageByThreadId.value,
      [normalizedThreadId]: usage,
    }
    saveThreadTokenUsageMap(threadTokenUsageByThreadId.value)
  }

  function prune(threadIds: Set<string>): void {
    threadTokenUsageByThreadId.value = pruneThreadStateMap(threadTokenUsageByThreadId.value, threadIds)
  }

  function reset(): void {
    threadTokenUsageByThreadId.value = {}
  }

  return { selectedThreadTokenUsage, setThreadTokenUsage, prune, reset }
}
