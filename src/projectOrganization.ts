import { isProjectlessChatPath, normalizePathForComparison } from './pathUtils.js'
import type { UiProjectGroup } from './types/codex.js'

export type VirtualProject = {
  id: string
  label: string
  cwds: string[]
}

export function isVirtualProjectId(value: string): boolean {
  return /^virtual:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
}

// Grouping changes only presentation. The native thread ID, cwd and account
// remain authoritative for sending, resuming, approval and runtime routing.
export function organizeProjectGroups(groups: UiProjectGroup[], projects: VirtualProject[]): UiProjectGroup[] {
  if (!projects.length) return groups
  const ownerByCwd = new Map<string, string>()
  const byId = new Map<string, UiProjectGroup>()
  for (const project of projects) {
    byId.set(project.id, { projectName: project.id, threads: [] })
    for (const cwd of project.cwds) ownerByCwd.set(normalizePathForComparison(cwd), project.id)
  }
  const result: UiProjectGroup[] = []
  for (const group of groups) {
    const remaining = group.threads.filter(thread => {
      const owner = isProjectlessChatPath(thread.cwd) ? ownerByCwd.get(normalizePathForComparison(thread.cwd)) : undefined
      if (!owner) return true
      byId.get(owner)!.threads.push({ ...thread, projectName: owner })
      return false
    })
    if (remaining.length || !group.threads.length) result.push(remaining.length === group.threads.length ? group : { ...group, threads: remaining })
  }
  return [...result, ...byId.values()]
}
