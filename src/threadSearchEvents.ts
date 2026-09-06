const searchableChangeMethods = new Set([
  'item/completed',
  'turn/started',
  'turn/completed',
  'thread/started',
  'thread/name/updated',
  'thread/archived',
  'thread/unarchived',
  'thread/closed',
])

export function changesThreadSearch(method: string): boolean {
  return searchableChangeMethods.has(method)
}
