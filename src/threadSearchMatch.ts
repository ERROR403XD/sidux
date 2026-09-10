export type ThreadSearchMode = 'title' | 'body'

export function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ')
}

/** All words must match; exact titles and phrases rank ahead of scattered words. */
export function createThreadMatcher(query: string): (value: string) => number {
  const phrase = normalizeSearchText(query)
  const words = [...new Set(phrase.split(' ').filter(Boolean))]
  return (value) => {
    if (!phrase) return 0
    const normalized = normalizeSearchText(value)
    if (!words.every(word => normalized.includes(word))) return 0
    if (normalized === phrase) return 4
    if (normalized.startsWith(phrase)) return 3
    if (normalized.includes(phrase)) return 2
    return 1
  }
}
