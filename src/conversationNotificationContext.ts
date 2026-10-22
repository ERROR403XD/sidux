import type { WorkspaceRootsState } from './api/projectGateway.js'
import { getPathParent, isProjectlessChatPath, normalizePathForComparison, normalizePathForUi, toProjectName } from './pathUtils.js'

export type ConversationNotificationContext = { title: string; projectName: string }

// Resolve presentation names without filtering out hidden or paginated conversations.
// An empty result represents a conversation outside any project.
export function conversationNotificationProjectName(cwd: string, roots: WorkspaceRootsState | null): string {
  const path = normalizePathForUi(cwd).trim()
  if (!path) return ''
  const comparable = normalizePathForComparison(path)
  if (isProjectlessChatPath(path)) {
    return roots?.virtualProjects?.find(project => project.cwds.some(member => normalizePathForComparison(member) === comparable))?.label.trim() || ''
  }
  const leaf = toProjectName(path)
  const matchingRoots = roots?.order.filter(root => toProjectName(root) === leaf) ?? []
  let projectPath = roots?.order.find(root => normalizePathForComparison(root) === comparable) || path
  if (path.replaceAll('\\', '/').includes('/.codex/worktrees/') && projectPath === path) {
    const canonicalRoots = matchingRoots.filter(root => !root.replaceAll('\\', '/').includes('/.codex/worktrees/'))
    if (canonicalRoots.length === 1) projectPath = canonicalRoots[0]!
  }
  const label = Object.entries(roots?.labels ?? {}).find(([root]) => normalizePathForComparison(root) === normalizePathForComparison(projectPath))?.[1].trim()
  if (label) return label
  if (matchingRoots.length > 1) return projectPath
  const parent = toProjectName(getPathParent(projectPath))
  return parent.startsWith('.') && parent !== leaf ? `${leaf} ${parent}` : leaf
}
