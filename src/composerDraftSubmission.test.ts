import { describe, expect, it, vi } from 'vitest'
import { captureDraftSubmission, clearSubmittedDraft, readAcknowledgedDraft } from './composerDraftSubmission'
const snapshot = JSON.stringify({ text: 'same text', imageUrls: [], fileAttachments: [], skills: [] })

function setup() {
  const rows = new Map([['home', JSON.stringify({ text: 'same text', revision: 'first' })]])
  const storage = { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value) }, removeItem: (key: string) => { rows.delete(key) } }
  return { rows, storage }
}

describe('draft submission ownership', () => {
  it('clears the submitted source after navigation without touching another draft', () => {
    const { rows, storage } = setup()
    const submitted = captureDraftSubmission(storage, 'home', snapshot)
    rows.set('other', JSON.stringify({ text: 'other draft', revision: 'other' }))
    expect(clearSubmittedDraft(storage, 'home', submitted)).toBe(true)
    expect(rows.has('home')).toBe(false)
    expect(rows.has('other')).toBe(true)
  })
  it('preserves a newer revision even if its text is identical', () => {
    const { rows, storage } = setup()
    const submitted = captureDraftSubmission(storage, 'home', snapshot)
    rows.set('home', JSON.stringify({ text: 'same text', revision: 'second' }))
    expect(clearSubmittedDraft(storage, 'home', submitted)).toBe(false)
    expect(readAcknowledgedDraft(storage, 'home', Date.now() + 1000)).toBeNull()
    expect(JSON.parse(rows.get('home')!).revision).toBe('second')
  })
  it('only recovers acknowledgements made after that draft was submitted', () => {
    const { storage } = setup()
    const submitted = captureDraftSubmission(storage, 'home', snapshot)!
    const time = JSON.parse(submitted).submittedAt
    expect(readAcknowledgedDraft(storage, 'home', time - 1)).toBeNull()
    expect(readAcknowledgedDraft(storage, 'home', time)).toBe(submitted)
  })
  it('leaves unsubmitted drafts intact and upgrades legacy drafts only when submitted', () => {
    const { storage, rows } = setup()
    expect(readAcknowledgedDraft(storage, 'home', Date.now())).toBeNull()
    rows.set('home', JSON.stringify('legacy'))
    expect(captureDraftSubmission(storage, 'home', snapshot)).toBeNull()
    const legacy = captureDraftSubmission(storage, 'home', snapshot.replace('same text', 'legacy'))
    expect(clearSubmittedDraft(storage, 'home', legacy)).toBe(true)
  })
  it('does not claim a newer draft saved by another tab before submission', () => {
    const { rows, storage } = setup()
    rows.set('home', JSON.stringify({ text: 'another tab', revision: 'other' }))
    expect(captureDraftSubmission(storage, 'home', snapshot)).toBeNull()
    expect(JSON.parse(rows.get('home')!).text).toBe('another tab')
  })
  it('does not treat failed persistence as a successful capture or clear', () => {
    const { storage } = setup()
    const submitted = captureDraftSubmission(storage, 'home', snapshot)
    storage.setItem = vi.fn(() => { throw new Error('full') })
    storage.removeItem = vi.fn(() => { throw new Error('blocked') })
    expect(captureDraftSubmission(storage, 'home', snapshot)).toBeNull()
    expect(clearSubmittedDraft(storage, 'home', submitted)).toBe(false)
  })
})
