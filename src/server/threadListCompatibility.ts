/** The legacy import supplement cannot honor native filters or cursor boundaries. */
export function maySupplementImportedThreads(value: unknown): boolean {
  const params = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  if (params.cursor || params.archived === true) return false
  if (['parentThreadId', 'ancestorThreadId', 'cwd', 'searchTerm', 'projectId', 'sectionId'].some(key => params[key] !== undefined && params[key] !== '')) return false
  if (['sourceKinds', 'modelProviders'].some(key => Array.isArray(params[key]) && params[key].length > 0)) return false
  return params.sortDirection !== 'asc' && params.useStateDbOnly !== true
}
