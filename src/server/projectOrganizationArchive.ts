import { isAbsolute } from 'node:path'
import { isProjectlessChatPath } from '../pathUtils.js'

export type ProjectArchiveMember = { cwd: string; prefix: string }

export function readProjectArchiveMembers(value: unknown): ProjectArchiveMember[] | null {
  if (value === undefined) return null
  const record = value as { version?: unknown; members?: unknown }
  if (!record || record.version !== 1 || !Array.isArray(record.members)) throw new Error('Invalid project archive')
  const paths = new Set<string>()
  const prefixes = new Set<string>()
  return record.members.map(member => {
    if (!member || typeof member.cwd !== 'string' || !isAbsolute(member.cwd) || !isProjectlessChatPath(member.cwd)
      || typeof member.prefix !== 'string' || !/^files\/\d{6}\/$/u.test(member.prefix)
      || paths.has(member.cwd) || prefixes.has(member.prefix)) throw new Error('Invalid project archive')
    paths.add(member.cwd)
    prefixes.add(member.prefix)
    return { cwd: member.cwd, prefix: member.prefix }
  })
}
