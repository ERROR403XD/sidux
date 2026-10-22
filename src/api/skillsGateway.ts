import { callRpc } from './rpcGateway'

export type SkillInfo = {
  name: string
  displayName?: string
  description: string
  path: string
  scope: string
  enabled: boolean
}

function normalizeSkillMarkdownPath(skillPath: string): string {
  if (!skillPath) return ''
  return skillPath.endsWith('/SKILL.md') ? skillPath : `${skillPath}/SKILL.md`
}

function deriveGroupedSkillRoot(
  skillPath: string,
  knownPaths: Set<string>,
): { rootPath: string; rootName: string; isNested: boolean } | null {
  const normalizedPath = normalizeSkillMarkdownPath(skillPath)
  const parts = normalizedPath.split('/').filter(Boolean)
  if (parts.length < 2) return null

  const pluginSkillsIndex = parts.lastIndexOf('skills')
  if (pluginSkillsIndex >= 2) {
    const pluginName = parts[pluginSkillsIndex - 2] ?? ''
    if (pluginName) {
      const pluginRootPath = `/${[...parts.slice(0, pluginSkillsIndex + 1), pluginName, 'SKILL.md'].join('/')}`
      if (knownPaths.has(pluginRootPath)) {
        return { rootPath: pluginRootPath, rootName: pluginName, isNested: pluginRootPath !== normalizedPath }
      }
    }
  }

  const firstSkillsIndex = parts.indexOf('skills')
  if (firstSkillsIndex < 0 || firstSkillsIndex + 1 >= parts.length - 1) return null
  const rootName = parts[firstSkillsIndex + 1] ?? ''
  if (!rootName) return null
  const rootPath = `/${[...parts.slice(0, firstSkillsIndex + 2), 'SKILL.md'].join('/')}`
  if (!knownPaths.has(rootPath)) return { rootPath, rootName, isNested: rootPath !== normalizedPath }
  return { rootPath, rootName, isNested: rootPath !== normalizedPath }
}

type SkillsListResponseEntry = {
  cwd: string
  skills: Array<{
    name: string
    description: string
    shortDescription?: string
    path: string
    scope: string
    enabled: boolean
  }>
  errors: unknown[]
}

export async function getSkillsList(cwds?: string[]): Promise<SkillInfo[]> {
  try {
    const params: Record<string, unknown> = {}
    if (cwds && cwds.length > 0) params.cwds = cwds
    const payload = await callRpc<{ data: SkillsListResponseEntry[] }>('skills/list', params)
    const allSkills = payload.data.flatMap((entry) => entry.skills)
    const pathSet = new Set(allSkills.map((skill) => normalizeSkillMarkdownPath(skill.path)).filter(Boolean))
    const grouped = new Map<string, SkillInfo & { __hasRoot: boolean }>()
    for (const entry of payload.data) {
      for (const skill of entry.skills) {
        if (!skill.name) continue
        const groupInfo = deriveGroupedSkillRoot(skill.path, pathSet)
        const normalizedPath = normalizeSkillMarkdownPath(skill.path)
        const shouldCollapseIntoRoot = Boolean(groupInfo?.isNested && pathSet.has(groupInfo.rootPath))
        const key = shouldCollapseIntoRoot ? groupInfo!.rootPath : normalizedPath
        const isRoot = normalizedPath === key
        const existing = grouped.get(key)
        const candidate: SkillInfo & { __hasRoot: boolean } = {
          name: skill.name,
          displayName: groupInfo && key === groupInfo.rootPath ? groupInfo.rootName : undefined,
          description: skill.shortDescription || skill.description || '',
          path: key,
          scope: skill.scope,
          enabled: skill.enabled,
          __hasRoot: isRoot,
        }
        if (!existing) {
          grouped.set(key, candidate)
          continue
        }
        existing.enabled = existing.enabled || skill.enabled
        if (!existing.__hasRoot && isRoot) {
          grouped.set(key, candidate)
          continue
        }
        if (!existing.displayName && candidate.displayName) {
          existing.displayName = candidate.displayName
        }
        if (!existing.description && candidate.description) {
          existing.description = candidate.description
        }
      }
    }
    return Array.from(grouped.values()).map(({ __hasRoot: _ignored, ...skill }) => skill)
  } catch {
    return []
  }
}
