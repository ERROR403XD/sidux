import { createDeliveryId } from './delivery'

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
// Only failed writes are retained, across composer remounts within this page.
export const composerDraftRecovery = new Map<string, string>()

/** Mark the exact persisted revision, so a late acknowledgement cannot erase a later edit. */
export function captureDraftSubmission(storage: DraftStorage, key: string, expectedPayload: string): string | null {
  try {
    const value = JSON.parse(storage.getItem(key) || 'null')
    if (value === null) return null
    const payload = {
      text: typeof value === 'string' ? value : value.text || '',
      imageUrls: value.imageUrls || [],
      fileAttachments: value.fileAttachments || [],
      skills: value.skills || [],
    }
    // The displayed view can be older than another tab's saved draft, even before submission.
    if (JSON.stringify(payload) !== expectedPayload) return null
    const raw = JSON.stringify({ ...payload, revision: value.revision || createDeliveryId(), submittedAt: Date.now() })
    storage.setItem(key, raw)
    return raw
  } catch { return null }
}

export function clearSubmittedDraft(storage: DraftStorage, key: string, submitted: string | null): boolean {
  if (!submitted) return false
  try {
    if (storage.getItem(key) !== submitted) return false
    storage.removeItem(key)
    return true
  } catch { return false }
}

export function readAcknowledgedDraft(storage: DraftStorage, key: string, deliveryCreatedAt: number): string | null {
  try {
    const raw = storage.getItem(key)
    const value = JSON.parse(raw || 'null')
    return value?.revision && typeof value.submittedAt === 'number' && value.submittedAt <= deliveryCreatedAt ? raw : null
  } catch { return null }
}
