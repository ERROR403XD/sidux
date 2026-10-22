import { restoreTrackedCompactionMessage } from './threadCompaction'
import { normalizeThreadMessagesV2 } from './normalizers/v2'
import type { ThreadReadResponse } from './appServerDtos'
import type { UiMessage } from '../types/codex'

export function readThreadTurnStartIndex(payload: ThreadReadResponse): number {
  const raw = (payload as { threadTurnStartIndex?: unknown }).threadTurnStartIndex
  return Math.max(0, Math.floor(typeof raw === 'number' ? raw : 0))
}

export function normalizeThreadMessagesWithCompaction(payload: ThreadReadResponse, startTurnIndex = 0): UiMessage[] {
  return restoreTrackedCompactionMessage(normalizeThreadMessagesV2(payload, startTurnIndex), payload, startTurnIndex)
}
