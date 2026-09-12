export function projectDisplayName(path: string, labels: Record<string, string>): string {
  return labels[path]?.trim() || path.replace(/[\\/]+$/u, '').split(/[\\/]/u).at(-1) || ''
}

export function projectSetupInput(path: string, name: string) {
  const target = path.trim()
  if (!name.trim()) throw new Error('Enter a project name.')
  if (target && (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(target) || target.includes('\0'))) {
    throw new Error('Enter an absolute target folder path.')
  }
  return { path: target, options: { createIfMissing: true, label: name.trim() } }
}
